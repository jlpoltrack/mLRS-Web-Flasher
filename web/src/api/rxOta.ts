// rx ota: updates a receiver over the air, relayed by a tx module via its usb cli
// an internal tx module is reached via the usb serial (VCP) of the EdgeTX radio, which passes it through
// protocol must match mLRS Common/ota/ota_loader.h and CommonTx/ota_relay_tx.h
import { BufferedSerial } from './bufferedSerial';
import { FlasherStateMachine } from './flasherStateMachine';
import { parseHex } from './hexParser';
import type { FlasherOptions } from './flasher';

const OTA_APP_INFO_OFFSET = 0x0200;
const OTA_APP_INFO_MAGIC = 0x4F4C524D; // 'MRLO'
const OTA_CMD_HELLO = 1;
const OTA_CMD_BEGIN = 2;
const OTA_CMD_DATA = 3;
const OTA_CMD_END = 4;
const OTA_CMD_RESPONSE = 0x80;
const OTA_STATUS = ['ok', 'wrong target', 'bad length', 'bad state', 'flash error', 'image check failed', 'not supported', 'bad data'];
const OTA_LOADER_VERSION = 1;
const OTA_FLAG_DEFLATE = 0x01; // zlib stream
const OTA_FLAG_GZIP = 0x02; // gzip stream, for ESP8285 receivers
const OTA_RELAY_STX = 0xA5;
const ESP_IMAGE_MAGIC = 0xE9;
const OTA_FILE_MAGIC = 0x53544F4D; // 'MOTS'
const OTA_FILE_FLAG_DEFLATE = 0x01; // data is a raw deflate stream

const FLASH_PAGE_SIZE = 0x0800; // the app starts on a page boundary behind the loader
const RELAY_START_DELAY_MS = 2000; // the tx starts the relay 1 s after the cli command
const CONNECT_TIMEOUT_MS = 15000;
const RESPONSE_TIMEOUT_MS = 1500;
const RETRIES = 10;
const WINDOW = 2; // data blocks on their way, the tx gets the next one while it does the radio with the current one
const USB_UART_VIDS = [0x10C4, 0x0403, 0x1A86]; // CP210x, FTDI, CH340, as for an ESP32 Tx module
const HELLO_RETRIES = 20;

const RADIO_VIDS = [0x0483, 0x2E3C]; // EdgeTX/OpenTX VCP, AX12, a STM32 Tx module has the first too
const JRPIN5_BAUDS = [400000, 921600, 1870000]; // of the uart between radio and internal tx module, = txcrsf_bauds[]
const OTA_RELAY_JRPIN5_BAUDRATE = 230400; // the module goes to it when its relay starts
const MBRIDGE_CMD_RX_OTA = 19;
const RADIO_CONNECT_TIMEOUT_MS = 25000;
const RADIO_PROBE_TIMEOUT_MS = 2500;

interface OtaResponse {
  status: number;
  payload: Uint8Array;
}

interface OtaImage {
  image: Uint8Array;
  targetId: number;
  version: number;
  isEsp: boolean;
}

// = fmav_crc_calculate()
function crc16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (const b of data) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

// = zlib.crc32()
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// = zlib.adler32()
function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (const d of data) {
    a = (a + d) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function crc8Crsf(data: number[]): number { // poly 0xD5
  let crc = 0;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x80) ? (crc << 1) ^ 0xD5 : crc << 1) & 0xFF;
  }
  return crc;
}

function crsfFrame(address: number, body: number[]): Uint8Array {
  return new Uint8Array([address, body.length + 1, ...body, crc8Crsf(body)]);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function u32(data: Uint8Array, pos: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(pos, true);
}

// the target id is a hash of the device name
function targetIdStr(id: number): string {
  return id.toString(16).toUpperCase().padStart(8, '0');
}

function findBytes(data: Uint8Array, pattern: number[], from = 0): number {
  for (let pos = from; pos + pattern.length <= data.length; pos++) {
    if (pattern.every((b, i) => data[pos + i] === b)) return pos;
  }
  return -1;
}

// 'deflate' gives a zlib stream, 'deflate-raw' one without header and trailer
async function compress(data: Uint8Array, format: 'deflate' | 'deflate-raw' | 'gzip'): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function versionStr(version: number): string {
  const patch = version % 100;
  return `v${Math.floor(version / 10000)}.${Math.floor(version / 100) % 100}.${patch < 10 ? '0' : ''}${patch}`;
}

function statusStr(status: number): string {
  return OTA_STATUS[status] ?? String(status);
}

function toFlatImage(firmwareData: ArrayBuffer, filename?: string): Uint8Array {
  if (!filename?.toLowerCase().endsWith('.hex')) return new Uint8Array(firmwareData);

  const blocks = parseHex(new TextDecoder().decode(firmwareData));
  if (blocks.length === 0) throw new Error('Failed to parse HEX file');
  const start = Math.min(...blocks.map(b => b.address));
  const end = Math.max(...blocks.map(b => b.address + b.data.length));
  const image = new Uint8Array(end - start).fill(0xFF);
  for (const b of blocks) image.set(b.data, b.address - start);
  return image;
}

// finds the app in a firmware file
// STM32: either the app alone or loader + app (.hex, .bin), the app info sits at a fixed place
// ESP32: the normal .bin, the app info sits somewhere, the receiver checks the image's own checksum
export function extractOtaImage(firmwareData: ArrayBuffer, filename?: string): OtaImage {
  const image = toFlatImage(firmwareData, filename);
  const noImage = new Error('This firmware cannot be sent over the air (no OTA image found in the file)');

  if (image[0] === ESP_IMAGE_MAGIC) {
    const magic = [0x4D, 0x52, 0x4C, 0x4F]; // OTA_APP_INFO_MAGIC
    const pos = findBytes(image, magic);
    if (pos < 0 || pos + 16 > image.length || findBytes(image, magic, pos + 4) >= 0) throw noImage;
    if (u32(image, pos + 8) !== 0) throw noImage;
    return { image, targetId: u32(image, pos + 4), version: u32(image, pos + 12), isEsp: true };
  }

  for (let base = 0; base + OTA_APP_INFO_OFFSET + 16 <= image.length; base += FLASH_PAGE_SIZE) {
    if (u32(image, base + OTA_APP_INFO_OFFSET) !== OTA_APP_INFO_MAGIC) continue;
    let length = u32(image, base + OTA_APP_INFO_OFFSET + 8);
    if (length === 0) {
      // as it comes out of the build, length and crc are open, the crc goes into the last 4 bytes, multiple of 8
      length = (image.length - base + 4 + 7) & ~7;
      const app = new Uint8Array(length).fill(0xFF);
      app.set(image.subarray(base));
      const view = new DataView(app.buffer);
      view.setUint32(OTA_APP_INFO_OFFSET + 8, length, true);
      view.setUint32(length - 4, crc32(app.subarray(0, length - 4)), true);
      return { image: app, targetId: u32(app, OTA_APP_INFO_OFFSET + 4), version: u32(app, OTA_APP_INFO_OFFSET + 12), isEsp: false };
    }
    if (length < OTA_APP_INFO_OFFSET + 16 || (length & 7) || base + length > image.length) continue;
    const app = image.subarray(base, base + length);
    if (crc32(app.subarray(0, length - 4)) !== u32(app, length - 4)) {
      throw new Error('Firmware image is corrupted (crc mismatch)');
    }
    return { image: app, targetId: u32(app, OTA_APP_INFO_OFFSET + 4), version: u32(app, OTA_APP_INFO_OFFSET + 12), isEsp: false };
  }

  throw noImage;
}

// makes the image file which goes into /FIRMWARE on the radio's SD card, = tools/run_rx_ota_file.py
// the lua script mLRS-RxUpdate.lua feeds it to the tx module, format as tOtaFileHeader in ota_loader.h
export async function buildOtaFile(firmwareData: ArrayBuffer, filename?: string): Promise<Uint8Array> {
  const { image, targetId, version, isEsp } = extractOtaImage(firmwareData, filename);

  // ESP: raw deflate stream, the tx makes it into the zlib or gzip stream the receiver wants
  // STM32: the app as it is, the loader can't inflate
  const data = isEsp ? await compress(image, 'deflate-raw') : image;

  const HEADER_LEN = 40;
  const file = new Uint8Array(HEADER_LEN + data.length);
  const view = new DataView(file.buffer);
  const fields = [
    OTA_FILE_MAGIC, targetId, version, isEsp ? OTA_FILE_FLAG_DEFLATE : 0, data.length, crc32(data),
    image.length, isEsp ? adler32(image) : 0, isEsp ? crc32(image) : 0,
  ];
  fields.forEach((v, i) => view.setUint32(i * 4, v, true));
  view.setUint32(HEADER_LEN - 4, crc32(file.subarray(0, HEADER_LEN - 4)), true);
  file.set(data, HEADER_LEN);
  return file;
}

class OtaRelay {
  private serial: BufferedSerial;

  constructor(serial: BufferedSerial) {
    this.serial = serial;
  }

  async send(packet: Uint8Array): Promise<void> {
    const body = new Uint8Array(1 + packet.length);
    body[0] = packet.length;
    body.set(packet, 1);
    const crc = crc16(body);
    await this.serial.write([OTA_RELAY_STX, ...body, crc & 0xFF, crc >> 8]);
  }

  // returns the response of the loader, empty if the tx says there is none, null if the tx says nothing
  async receive(): Promise<Uint8Array | null> {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    const remaining = () => Math.max(1, deadline - Date.now());
    try {
      while ((await this.serial.readByte(remaining())) !== OTA_RELAY_STX) { /* skip */ }
      const len = await this.serial.readByte(remaining());
      const data = await this.serial.read(len + 2, remaining());
      const body = new Uint8Array(1 + len);
      body[0] = len;
      body.set(data.subarray(0, len), 1);
      if (crc16(body) !== (data[len] | (data[len + 1] << 8))) return null;
      return data.subarray(0, len);
    } catch {
      return null; // timeout
    }
  }

  // sends a command to the loader, the session id is filled in by the tx
  async command(cmd: number, payload: number[] | Uint8Array = [], retries = RETRIES): Promise<OtaResponse | null> {
    for (let n = 0; n < retries; n++) {
      await this.send(new Uint8Array([cmd, 0, 0, ...payload]));
      const res = await this.receive();
      if (res && res.length >= 4 && res[0] === (cmd | OTA_CMD_RESPONSE)) {
        return { status: res[3], payload: res.subarray(4) };
      }
    }
    return null;
  }

  async end(): Promise<void> {
    await this.send(new Uint8Array(0));
  }
}

async function readText(serial: BufferedSerial): Promise<string> {
  const n = serial.bytesAvailable;
  return n ? new TextDecoder().decode(await serial.read(n, 100)) : '';
}

// makes the radio pass its usb serial through to the internal tx module
// stopping the pulses powers the module off, so it is powered on again, and boots into its firmware
async function edgetxPassthrough(serial: BufferedSerial, log: (msg: string) => void): Promise<void> {
  for (const cmd of ['set pulses 0', 'set rfmod 0 bootpin 0', 'set rfmod 0 power on', `serialpassthrough rfmod 0 ${JRPIN5_BAUDS[0]}`]) {
    log(`> ${cmd}`);
    await serial.write(new TextEncoder().encode(cmd + '\n'));
    await sleep(500);
    serial.flush();
  }
}

// plays the radio: sends channel frames, and looks at the link statistics the module answers with
// the module autobauds at startup, and stays at one of its rates, so we have to find it, the radio follows our rate
// leaves the port at the rate of the module
async function crsfWaitConnected(serial: BufferedSerial, timeoutMs: number): Promise<'connected' | 'found' | 'silent'> {
  const rc = crsfFrame(0xC8, [0x16, ...Array(2).fill([0xE0, 0x03, 0x1F, 0xF8, 0xC0, 0x07, 0x3E, 0xF0, 0x81, 0x0F, 0x7C]).flat()]); // all channels mid
  let buf: number[] = [];
  let found = false;
  let baudIndex = 0;
  let tBaud = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!found && Date.now() - tBaud > 500) {
      await serial.connect({ baudRate: JRPIN5_BAUDS[baudIndex] });
      baudIndex = (baudIndex + 1) % JRPIN5_BAUDS.length;
      tBaud = Date.now();
      buf = [];
    }
    await serial.write(rc);
    await sleep(20);
    const n = serial.bytesAvailable;
    if (n) buf = [...buf, ...(await serial.read(n, 100))].slice(-600);
    let pos = 0;
    while (pos + 2 < buf.length) {
      const len = buf[pos + 1];
      if ((buf[pos] !== 0xEA && buf[pos] !== 0xC8) || len < 2 || len > 62) { pos++; continue; }
      if (pos + 2 + len > buf.length) break;
      const frame = buf.slice(pos, pos + 2 + len);
      if (crc8Crsf(frame.slice(2, -1)) !== frame[frame.length - 1]) { pos++; continue; }
      found = true;
      if (frame[2] === 0x14 && len >= 12 && frame[5] > 0) return 'connected'; // link statistics, uplink lq
      pos += 2 + len;
    }
    buf = buf.slice(pos);
  }
  return found ? 'found' : 'silent';
}

function failed(what: string, res: OtaResponse | null): Error {
  return new Error(what + (res ? `, ${statusStr(res.status)}` : ', no response from receiver'));
}

export async function flashRxOta(
  port: SerialPort,
  firmwareData: ArrayBuffer,
  options: FlasherOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', "Starting receiver OTA update...");

  const { image, targetId, version, isEsp } = extractOtaImage(firmwareData, options.filename);
  const length = image.length;
  sm.log(`Image: target ${targetIdStr(targetId)}, ${versionStr(version)}, ${length} bytes`);

  const serial = new BufferedSerial(port, options.onLog);
  let relay: OtaRelay | null = null;
  let started = false;
  let radio = false; // the port is that of a radio, the tx module is its internal one

  try {
    await serial.connect({ baudRate: 115200 });
    if (USB_UART_VIDS.includes(port.getInfo().usbVendorId ?? 0)) {
      // the adapter of an ESP32 Tx module may reset it or hold it in boot with these
      try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* not supported by all */ }
    }

    // a radio answers with the prompt of its command line, a tx module with its cli
    // a radio which is in passthrough already, e.g. after a failed update, answers with neither
    if (RADIO_VIDS.includes(port.getInfo().usbVendorId ?? 0)) {
      await serial.write(new TextEncoder().encode('\r\n'));
      await sleep(500);
      if (/(^|\n)> $/.test(await readText(serial))) {
        sm.log("Radio found, setting it to pass through to its internal Tx module...");
        await edgetxPassthrough(serial, msg => sm.log(msg));
        radio = true;
      } else {
        serial.flush();
        await serial.write(new TextEncoder().encode('v;'));
        await sleep(1000);
        if (!serial.bytesAvailable) {
          radio = (await crsfWaitConnected(serial, RADIO_PROBE_TIMEOUT_MS)) !== 'silent';
          if (!radio) await serial.connect({ baudRate: 115200 });
        }
      }
    }

    if (radio) {
      // the module tells the receiver to go into ota only if it is connected
      sm.log("Waiting for the receiver to be connected...");
      const state = await crsfWaitConnected(serial, RADIO_CONNECT_TIMEOUT_MS);
      if (state === 'silent') throw new Error('No answer from the internal Tx module');
      if (state === 'found') sm.log("Receiver is not connected, trying anyway.");
      await serial.write(crsfFrame(0xEE, [0x81, 0x4F, 0x57, 0xA0 + MBRIDGE_CMD_RX_OTA])); // mBridge command in a CRSF frame
      await sleep(RELAY_START_DELAY_MS);
      await serial.connect({ baudRate: OTA_RELAY_JRPIN5_BAUDRATE });
    } else {
      // opening the port may have reset the tx, and the receiver must be connected to get told to go into ota
      // a receiver which sits in its loader doesn't connect, so go on in any case
      sm.log("Waiting for the receiver to be connected...");
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        serial.flush();
        await serial.write(new TextEncoder().encode('v;'));
        await sleep(1000);
        const text = await readText(serial);
        if (text.includes('Rx: ') && !text.includes('not connected')) break;
      }

      await serial.write(new TextEncoder().encode('rxota;'));
      await sleep(RELAY_START_DELAY_MS);
      serial.flush();
    }
    relay = new OtaRelay(serial);

    sm.transition('SYNCING', "Looking for receiver...");
    const hello = await relay.command(OTA_CMD_HELLO, [], HELLO_RETRIES);
    if (!hello || hello.payload.length < 1) throw new Error('No response from receiver');
    if (hello.payload[0] !== OTA_LOADER_VERSION || hello.payload.length < 11) {
      throw new Error(`Receiver has OTA version ${hello.payload[0]}, this flasher is for version ${OTA_LOADER_VERSION}`);
    }
    const blockSize = hello.payload[1];
    const rxTargetId = u32(hello.payload, 2);
    const rxFlags = hello.payload[10];
    sm.log(`Receiver: target ${targetIdStr(rxTargetId)}, OTA version ${hello.payload[0]}`);
    if (rxTargetId !== targetId) throw new Error('Firmware is not for this receiver');
    if (length > u32(hello.payload, 6)) throw new Error('Firmware is too large for this receiver');

    // length is what is transferred, image length what it becomes in flash, they differ only with deflate
    let data = image;
    let flags = 0;
    if (rxFlags & OTA_FLAG_DEFLATE) {
      data = await compress(image, 'deflate');
      flags = OTA_FLAG_DEFLATE;
    } else if (rxFlags & OTA_FLAG_GZIP) {
      data = await compress(image, 'gzip');
      flags = OTA_FLAG_GZIP;
    }
    if (flags) {
      sm.log(`Compressed to ${data.length} bytes, ${Math.floor(100 * data.length / length)} %`);
    }

    const head = new Uint8Array(13);
    new DataView(head.buffer).setUint32(0, data.length, true);
    new DataView(head.buffer).setUint32(4, targetId, true);
    head[8] = flags;
    new DataView(head.buffer).setUint32(9, length, true);
    let res = await relay.command(OTA_CMD_BEGIN, head);
    if (res?.status !== 0) throw failed('Begin failed', res);

    sm.transition('WRITING', "Sending firmware...");
    started = true;
    // the tx answers each block it gets, in order, and the loader tells in each response which block it wants next
    // so blocks can be sent ahead, if one gets lost the loader refuses those behind it, and we go back
    const blockNum = Math.ceil(data.length / blockSize);
    let block = 0;
    let pending = 0; // blocks sent for which the answer of the tx is to come
    let sendNext = 0;
    let resync = false; // something went wrong, wait for what is on its way, then go on with the block the loader wants
    let fails = 0;
    let retries = 0;
    let lastLoggedProgress = 0;
    while (block < blockNum || pending) {
      while (!resync && pending < WINDOW && sendNext < blockNum) {
        const chunk = data.subarray(sendNext * blockSize, (sendNext + 1) * blockSize);
        await relay.send(new Uint8Array([OTA_CMD_DATA, 0, 0, sendNext & 0xFF, sendNext >> 8, ...chunk]));
        sendNext++;
        pending++;
      }
      if (pending) {
        const r = await relay.receive();
        pending = (r !== null) ? pending - 1 : 0; // if the tx is silent nothing more is to come
        const expected = sendNext - pending; // the block the loader wants if all went well up to this response
        if (r && r.length >= 6 && r[0] === (OTA_CMD_DATA | OTA_CMD_RESPONSE)) {
          if (r[3] !== 0) throw new Error(`Block ${block} failed, ${statusStr(r[3])}`);
          block = r[4] | (r[5] << 8);
          if (block !== expected) resync = true; else fails = 0;
          const progress = Math.round(100 * block / blockNum);
          sm.updateProgress(progress);
          // log every 10%
          if (Math.floor(progress / 10) > Math.floor(lastLoggedProgress / 10)) {
            sm.log(`Progress: ${progress}% (${block}/${blockNum} blocks)`);
            lastLoggedProgress = progress;
          }
        } else {
          resync = true;
        }
      }
      if (resync && !pending) {
        resync = false;
        retries++;
        if (++fails > RETRIES) throw new Error(`Block ${block} failed, no response from receiver`);
        sendNext = block;
      }
    }
    sm.log(`Sent ${blockNum} blocks, ${retries} retries`);

    // crc32 of what was transferred, an ESP8285 receiver needs it, the others ignore it
    const end = new Uint8Array(4);
    new DataView(end.buffer).setUint32(0, crc32(data), true);
    res = await relay.command(OTA_CMD_END, end);
    if (res && res.status !== 0) throw failed('Receiver rejected the firmware', res);
    if (!res) sm.log("No response to end, receiver may have rebooted already. Check that it connects.");

    sm.transition('DONE', "Receiver OTA update complete, receiver reboots.");
    if (radio) sm.log("Restart the radio now, it passes its USB through to the Tx module until then.");
  } catch (err) {
    sm.transition('ERROR', `Error during receiver OTA update: ${err instanceof Error ? err.message : String(err)}`);
    if (started && isEsp) {
      sm.log("Hint: The receiver goes back to its firmware some seconds after the update stopped. Wait until it is connected to the Tx module again, then flash again.");
    } else if (started) {
      sm.log("Hint: The receiver stays in update mode (red LED on). Keep it powered and flash again.");
    } else {
      sm.log("Hint: Select the serial port of a Tx module which is connected to the receiver. The Tx module needs a firmware with 'rxota' in its CLI, and the receiver must have been flashed by wire once with a firmware which supports OTA.");
    }
    if (radio) sm.log("Hint: The radio passes its USB through to the Tx module until it is restarted. You can flash again without restarting it.");
    throw err;
  } finally {
    try { await relay?.end(); } catch { /* port may be gone */ }
    await serial.close();
  }
}
