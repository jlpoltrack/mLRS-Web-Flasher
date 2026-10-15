// rx ota: updates a receiver over the air, relayed by a tx module via its usb cli, = mLRS tools/run_rx_ota.py
// the port can also be the usb serial (VCP) of an EdgeTX radio, for an internal tx module, it is found by itself
// the receiver pulls the image, this only answers its requests
// protocol must match mLRS Common/ota/ota_protocol.h and CommonTx/ota_relay_tx.h
import { BufferedSerial } from './bufferedSerial';
import { FlasherStateMachine } from './flasherStateMachine';
import { parseHex } from './hexParser';
import type { FlasherOptions } from './flasher';

const OTA_PROTOCOL_VERSION = 1;
const OTA_CMD_INFO = 1;
const OTA_CMD_DATA = 2;
const OTA_CMD_RESULT = 3;
const OTA_CMD_RESPONSE = 0x80;
const OTA_STATUS_OK = 0;
const OTA_STATUS_ERR_TARGET = 1;
const OTA_STATUS_ERR_LENGTH = 2;
const OTA_STATUS_ERR_VERSION = 3;
const OTA_STATUS = ['ok', 'wrong target', 'bad length', 'wrong protocol version', 'flash error', 'image check failed', 'not supported', 'bad data'];
const OTA_FLAG_DEFLATE = 0x01; // zlib stream, ESP32
const OTA_FLAG_GZIP = 0x02; // gzip stream, ESP8285
const OTA_RELAY_STX = 0xA5;
const ESP_IMAGE_MAGIC = 0xE9;
const OTA_APP_INFO_MAGIC = [0x4D, 0x52, 0x4C, 0x4F]; // 'MRLO'

// internal tx module via the EdgeTX serial passthrough
const MBRIDGE_CMD_RX_OTA_JRPIN5 = 20;
const JRPIN5_BAUDS = [400000, 921600, 1870000]; // = crsf_baud[] of the tx, it autobauds
const OTA_RELAY_JRPIN5_BAUDRATE = 115200; // the module goes to it when its relay starts
const RADIO_CONNECT_TIMEOUT_MS = 25000;

// .ota file for the radio's SD card, = tools/run_rx_ota_file.py, must match lua/mLRS-RxUpdate.lua
const OTA_FILE_MAGIC = 0x32544F4D;
const OTA_FILE_FLAG_RAW = 0x01; // the image as it is, for STM32, which takes no compressed image
const OTA_FILE_HEADER_LEN = 56;
const ZLIB_HEAD = [0x78, 0xDA]; // the lua script puts these around the raw deflate stream
const GZIP_HEAD = [0x1F, 0x8B, 0x08, 0, 0, 0, 0, 0, 0x02, 0xFF];

const CLI_BAUDRATE = 115200; // also of the relay
const CONNECT_TRIES = 15; // 1 s each
const RELAY_START_DELAY_MS = 1500; // the tx starts the relay 1 s after the cli command
const RX_SILENT_TIMEOUT_MS = 10000; // the receiver gives up after some seconds without answers
const UPDATE_TIMEOUT_MS = 300000;
const RESULT_LINGER_MS = 500; // keep answering, the receiver repeats its result if our answer got lost
const USB_UART_VIDS = [0x10C4, 0x0403, 0x1A86]; // CP210x, FTDI, CH340, as for an ESP32 Tx module

interface OtaImage {
  image: Uint8Array;
  name: string; // the receiver's device name
  version: number;
  isEsp: boolean;
}

// CRC-16/MCRF4XX (MAVLink X.25), = fmav_crc_calculate()
function crc16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (const b of data) {
    let tmp = (b ^ (crc & 0xFF)) & 0xFF;
    tmp = (tmp ^ (tmp << 4)) & 0xFF;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF;
  }
  return crc;
}

// CRC-32/MPEG-2, = ota_crc() of the receiver
function crc32Mpeg2(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const b of data) {
    crc ^= b << 24;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
  }
  return crc >>> 0;
}

// CRC-32/ISO-HDLC, = zlib.crc32()
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

// CRC-8/DVB-S2, poly 0xD5
function crc8Crsf(data: number[]): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = ((crc & 0x80) ? (crc << 1) ^ 0xD5 : crc << 1) & 0xFF;
  }
  return crc;
}

// to the tx module
function crsfFrame(body: number[]): Uint8Array {
  return new Uint8Array([0xEE, body.length + 1, ...body, crc8Crsf(body)]);
}

// the module goes on only after channel frames, all mid but throttle (ch3, AETR) at -100%
function crsfRcFrame(): Uint8Array {
  const packed: number[] = new Array(22).fill(0);
  for (let ch = 0; ch < 16; ch++) {
    const value = ch === 2 ? 173 : 992;
    for (let bit = 0; bit < 11; bit++) {
      const pos = 11 * ch + bit;
      if (value & (1 << bit)) packed[pos >> 3] |= 1 << (pos & 7);
    }
  }
  return crsfFrame([0x16, ...packed]);
}

const CRSF_RC_FRAME = crsfRcFrame();
const CRSF_RX_OTA_FRAME = crsfFrame([0x81, 0x4F, 0x57, 0xA0 + MBRIDGE_CMD_RX_OTA_JRPIN5]); // 'O', 'W', cmd, as the lua scripts

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function u32(data: Uint8Array, pos: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(pos, true);
}

// up to the first zero
function nameOf(data: Uint8Array): string {
  const n = data.indexOf(0);
  return new TextDecoder().decode(n < 0 ? data : data.subarray(0, n));
}

function findBytes(data: Uint8Array | number[], pattern: number[], from = 0): number {
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

// the image which goes to the receiver
// ESP: the .bin of the build
// STM32: the .hex of the build has the OTA loader and the app, the app goes, it's the part with the app info
function loadImage(firmwareData: ArrayBuffer, filename?: string): Uint8Array {
  if (!filename?.toLowerCase().endsWith('.hex')) return new Uint8Array(firmwareData);
  const segments: { address: number; data: number[] }[] = []; // the small gaps between sections are filled
  for (const block of parseHex(new TextDecoder().decode(firmwareData))) {
    const last = segments[segments.length - 1];
    const gap = last ? block.address - (last.address + last.data.length) : -1;
    if (last && gap >= 0 && gap < 256) {
      last.data.push(...new Array(gap).fill(0xFF), ...block.data);
    } else {
      segments.push({ address: block.address, data: [...block.data] });
    }
  }
  const app = segments.find(s => findBytes(s.data, OTA_APP_INFO_MAGIC) >= 0);
  return new Uint8Array(app ? app.data : []);
}

// the receiver's device name, and its firmware version, from the app info in the image
// app info: magic, version[4], device_name[21]
export function extractOtaImage(firmwareData: ArrayBuffer, filename?: string): OtaImage {
  const image = loadImage(firmwareData, filename);
  const noImage = new Error('This firmware cannot be sent over the air (no OTA image found in the file)');
  const isEsp = image.length >= 16 && image[0] === ESP_IMAGE_MAGIC;
  const isStm32 = image.length >= 16 && ((u32(image, 0) & 0xFFF00000) >>> 0) === 0x20000000; // stack pointer
  if (!isEsp && !isStm32) throw noImage;
  const pos = findBytes(image, OTA_APP_INFO_MAGIC);
  if (pos < 0 || pos + 29 > image.length || findBytes(image, OTA_APP_INFO_MAGIC, pos + 4) >= 0) throw noImage;
  return { image, name: nameOf(image.subarray(pos + 8, pos + 29)), version: u32(image, pos + 4), isEsp };
}

// makes the image file which goes into /FIRMWARE on the radio's SD card, = tools/run_rx_ota_file.py
export async function buildOtaFile(firmwareData: ArrayBuffer, filename?: string): Promise<Uint8Array> {
  const { image, name, version, isEsp } = extractOtaImage(firmwareData, filename);

  let data = image, flags = OTA_FILE_FLAG_RAW, adler = 0, crc = 0, crcZlib, crcGzip;
  if (!isEsp) {
    // STM32, the image as it is, the crcs of the streams are both the crc of the image
    crcZlib = crcGzip = crc32Mpeg2(image);
  } else {
    // raw deflate stream, the lua script makes it into the zlib or gzip stream the receiver wants
    data = await compress(image, 'deflate-raw');
    flags = 0;
    adler = adler32(image);
    crc = crc32(image);
    const trailer = new Uint8Array(8);
    const tv = new DataView(trailer.buffer);
    tv.setUint32(0, adler, false);
    const zlibStream = new Uint8Array([...ZLIB_HEAD, ...data, ...trailer.subarray(0, 4)]);
    tv.setUint32(0, crc, true);
    tv.setUint32(4, image.length, true);
    const gzipStream = new Uint8Array([...GZIP_HEAD, ...data, ...trailer]);
    // the crcs of the streams are what the receiver checks, see Common/ota/ota_protocol.h
    crcZlib = crc32Mpeg2(zlibStream);
    crcGzip = crc32Mpeg2(gzipStream);
  }

  const file = new Uint8Array(OTA_FILE_HEADER_LEN + data.length);
  const view = new DataView(file.buffer);
  [OTA_FILE_MAGIC, version, data.length, image.length, adler, crc, crcZlib, crcGzip].forEach((v, i) => view.setUint32(i * 4, v, true));
  file.set(new TextEncoder().encode(name).subarray(0, 20), 32);
  view.setUint32(52, flags, true);
  file.set(data, OTA_FILE_HEADER_LEN);
  return file;
}

class OtaRelay {
  private serial: BufferedSerial;
  private buf: number[] = [];

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

  // the session id is filled in by the tx
  async answer(cmd: number, payload: Uint8Array = new Uint8Array(0)): Promise<void> {
    await this.send(new Uint8Array([cmd | OTA_CMD_RESPONSE, 0, 0, ...payload]));
  }

  // returns the next packet from the receiver, null if none came in time
  async receive(timeoutMs = 500): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      // find a frame in what we have
      while (this.buf.length >= 4) {
        if (this.buf[0] !== OTA_RELAY_STX) { this.buf.shift(); continue; }
        const n = this.buf[1];
        if (this.buf.length < n + 4) break;
        const frame = this.buf.splice(0, n + 4);
        if (crc16(new Uint8Array(frame.slice(1, n + 2))) === (frame[n + 2] | (frame[n + 3] << 8))) {
          return new Uint8Array(frame.slice(2, n + 2));
        }
      }
      if (Date.now() > deadline) return null;
      try {
        const n = Math.max(1, this.serial.bytesAvailable);
        this.buf.push(...(await this.serial.read(n, 20)));
      } catch { /* timeout */ }
    }
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
  let prompt = false;
  for (let i = 0; i < 2 && !prompt; i++) {
    serial.flush();
    await serial.write(new TextEncoder().encode('\r\n'));
    await sleep(1000);
    prompt = (await readText(serial)).includes('>');
  }
  if (!prompt) throw new Error('No answer on the serial port, neither from a Tx module CLI nor from a radio CLI');
  for (const cmd of ['set pulses 0', 'set rfmod 0 bootpin 0', 'set rfmod 0 power on', `serialpassthrough rfmod 0 ${JRPIN5_BAUDS[0]}`]) {
    await serial.write(new TextEncoder().encode(cmd + '\n'));
    await sleep(500);
    log(`Radio: ${cmd} -> ${(await readText(serial)).trim().replace(/\r?\n/g, ' | ')}`);
  }
}

// plays the radio: sends channel frames, and looks at the link statistics the module answers with
// the module autobauds and stays at one of its rates, so we have to find it, the radio follows our rate
// returns true when the module reports a link to the receiver
async function crsfWaitConnected(serial: BufferedSerial, log: (msg: string) => void): Promise<boolean> {
  let buf: number[] = [];
  let baud = 0; // the module's baudrate once found
  let baudIndex = 0;
  let tBaud = 0;
  const deadline = Date.now() + RADIO_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!baud && Date.now() - tBaud > 500) {
      // web serial changes the baudrate only by reopening the port
      await serial.connect({ baudRate: JRPIN5_BAUDS[baudIndex] });
      baudIndex = (baudIndex + 1) % JRPIN5_BAUDS.length;
      tBaud = Date.now();
      buf = [];
    }
    await serial.write(CRSF_RC_FRAME);
    await sleep(4);
    const n = serial.bytesAvailable;
    if (n) buf = [...buf, ...(await serial.read(n, 100))].slice(-128);
    for (let i = 0; i + 3 < buf.length; i++) { // frames from the module with valid crc
      const f = buf.slice(i, i + 2 + buf[i + 1]);
      if (f[0] !== 0xEA || f.length < 4 || f.length !== 2 + f[1] || crc8Crsf(f.slice(2, -1)) !== f[f.length - 1]) continue;
      if (!baud) {
        baud = JRPIN5_BAUDS[(baudIndex + JRPIN5_BAUDS.length - 1) % JRPIN5_BAUDS.length];
        log(`Tx module talks CRSF at ${baud} baud`);
      }
      if (f[2] === 0x14 && f.length === 14 && f[5] > 0) return true; // link statistics, uplink lq
    }
  }
  if (!baud) log("Nothing heard from the Tx module");
  return false;
}

export async function flashRxOta(
  port: SerialPort,
  firmwareData: ArrayBuffer,
  options: FlasherOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', "Starting receiver OTA update...");

  const { image, name, version, isEsp } = extractOtaImage(firmwareData, options.filename);
  sm.log(`Image: ${name}, ${versionStr(version)}, ${image.length} bytes`);

  const serial = new BufferedSerial(port, options.onLog);
  let relay: OtaRelay | null = null;
  let started = false;
  let radio = false; // the port is the usb serial of an EdgeTX radio, the tx module is an internal one

  try {
    await serial.connect({ baudRate: CLI_BAUDRATE });
    if (USB_UART_VIDS.includes(port.getInfo().usbVendorId ?? 0)) {
      // the adapter of an ESP32 Tx module may reset it or hold it in boot with these
      try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* not supported by all */ }
    }

    // the receiver must be connected to get told to go into ota
    // a receiver which is in its ota update already doesn't connect, so go on in any case
    sm.log("Waiting for the receiver to be connected...");
    let cliOk = false;
    let rx: RegExpMatchArray | null = null;
    for (let i = 0; i < CONNECT_TRIES; i++) {
      serial.flush();
      await serial.write(new TextEncoder().encode('v;'));
      await sleep(1000);
      const text = await readText(serial);
      if (text.includes('Tx: ')) cliOk = true;
      rx = text.match(/Rx: ([^,\r\n]+), ([^\r\n]+)/);
      if (rx || (!cliOk && i === 1)) break; // the tx CLI answers within 1 s, else it's a radio
    }
    radio = !cliOk;
    let connected: boolean;
    if (radio) {
      sm.log("No Tx module CLI, trying the radio for an internal Tx module...");
      await edgetxPassthrough(serial, msg => sm.log(msg));
      connected = await crsfWaitConnected(serial, msg => sm.log(msg));
    } else {
      connected = rx !== null;
      if (rx) {
        const rxName = rx[1].trim();
        sm.log(`Receiver: ${rxName}, ${rx[2].trim()}`);
        if (rxName !== name.substring(0, 20)) throw new Error(`Firmware is for ${name}, not for this receiver`);
      }
    }
    if (!connected) sm.log("Receiver is not connected, trying anyway.");

    if (radio) {
      // the mBridge command starts the relay, which then has the JR pin5 uart as plain serial
      for (let i = 0; i < 3; i++) { await serial.write(CRSF_RX_OTA_FRAME); await sleep(4); } // a lost frame doesn't matter then
      await sleep(RELAY_START_DELAY_MS);
      await serial.connect({ baudRate: OTA_RELAY_JRPIN5_BAUDRATE });
    } else {
      serial.flush();
      await serial.write(new TextEncoder().encode('rxota;'));
      await sleep(RELAY_START_DELAY_MS);
      if (!(await readText(serial)).includes('relay starts')) {
        throw new Error("Tx module did not take the 'rxota' command, it needs a firmware which supports OTA");
      }
    }
    serial.flush();
    relay = new OtaRelay(serial);

    sm.transition('SYNCING', "Waiting for the receiver...");
    let data: Uint8Array | null = null; // what is sent, set when the receiver has told what it can take
    let requests = 0;
    let repeats = 0;
    let lastOffset = -1;
    let lastLoggedProgress = 0;
    let tUpdate = Date.now();
    let tLast = Date.now();
    let tResult = 0;
    let result = OTA_STATUS_OK;
    while (!tResult || Date.now() - tResult < RESULT_LINGER_MS) {
      if (Date.now() - tUpdate > UPDATE_TIMEOUT_MS) throw new Error('Timeout');
      if (Date.now() - tLast > RX_SILENT_TIMEOUT_MS) throw new Error(data ? 'Receiver went silent' : 'No response from receiver');
      const packet = await relay.receive();
      if (!packet || packet.length < 3) continue;
      tLast = Date.now();
      const cmd = packet[0];
      const payload = packet.subarray(3);

      if (cmd === OTA_CMD_INFO && payload.length >= 1) {
        // version, space[4], flags, device_name_20[20]
        const rxVersion = payload[0];
        let rxFlags = 0;
        let status = OTA_STATUS_OK;
        if (rxVersion !== OTA_PROTOCOL_VERSION || payload.length !== 26) {
          status = OTA_STATUS_ERR_VERSION;
        } else {
          const rxSpace = u32(payload, 1);
          rxFlags = payload[5];
          const rxName = nameOf(payload.subarray(6, 26));
          if (!data) sm.log(`Receiver in its update: ${rxName}`);
          if (rxName !== name.substring(0, 20)) status = OTA_STATUS_ERR_TARGET;
          else if (image.length > rxSpace) status = OTA_STATUS_ERR_LENGTH;
        }
        if (status !== OTA_STATUS_OK) {
          await relay.answer(OTA_CMD_INFO, new Uint8Array([status, ...Array(13).fill(0)]));
          if (status === OTA_STATUS_ERR_VERSION) throw new Error(`Receiver has OTA protocol version ${rxVersion}, this flasher is for version ${OTA_PROTOCOL_VERSION}`);
          if (status === OTA_STATUS_ERR_TARGET) throw new Error('Firmware is not for this receiver');
          throw new Error('Firmware is too large for this receiver');
        }
        let flags = 0;
        if (!data) {
          // length is what is transferred, image length what it becomes in flash, they differ only with compression
          data = image;
          if (rxFlags & OTA_FLAG_DEFLATE) { data = await compress(image, 'deflate'); flags = OTA_FLAG_DEFLATE; }
          else if (rxFlags & OTA_FLAG_GZIP) { data = await compress(image, 'gzip'); flags = OTA_FLAG_GZIP; }
          if (flags) sm.log(`Compressed to ${data.length} bytes, ${Math.floor(100 * data.length / image.length)} %`);
          sm.transition('WRITING', "Sending firmware...");
          started = true;
          tUpdate = Date.now();
        } else {
          flags = rxFlags & OTA_FLAG_DEFLATE ? OTA_FLAG_DEFLATE : rxFlags & OTA_FLAG_GZIP ? OTA_FLAG_GZIP : 0;
        }
        const info = new Uint8Array(14);
        const view = new DataView(info.buffer);
        info[0] = OTA_STATUS_OK;
        view.setUint32(1, data.length, true);
        info[5] = flags;
        view.setUint32(6, image.length, true);
        view.setUint32(10, crc32Mpeg2(data), true);
        await relay.answer(OTA_CMD_INFO, info);

      } else if (cmd === OTA_CMD_DATA && payload.length === 5 && data) {
        const offset = u32(payload, 0);
        const maxLen = payload[4];
        if (offset >= data.length || maxLen === 0) continue;
        requests++;
        if (offset <= lastOffset) repeats++;
        lastOffset = offset;
        const chunk = data.subarray(offset, offset + maxLen);
        const answer = new Uint8Array(4 + chunk.length);
        new DataView(answer.buffer).setUint32(0, offset, true);
        answer.set(chunk, 4);
        await relay.answer(OTA_CMD_DATA, answer);
        const progress = Math.floor(100 * (offset + chunk.length) / data.length);
        sm.updateProgress(progress);
        // log every 10%
        if (Math.floor(progress / 10) > Math.floor(lastLoggedProgress / 10)) {
          sm.log(`Progress: ${progress}%`);
          lastLoggedProgress = progress;
        }

      } else if (cmd === OTA_CMD_RESULT && payload.length === 1) {
        await relay.answer(OTA_CMD_RESULT);
        if (!tResult) {
          tResult = Date.now();
          result = payload[0];
          sm.log(`Done in ${((tResult - tUpdate) / 1000).toFixed(1)} s, ${requests} requests, ${repeats} repeated`);
        }
      }
    }

    if (result !== OTA_STATUS_OK) throw new Error(`Receiver rejected the firmware, ${statusStr(result)}`);
    sm.transition('DONE', "Receiver OTA update complete, receiver reboots.");
    if (radio) sm.log("Restart the radio now, it passes its USB through to the Tx module until then.");
  } catch (err) {
    sm.transition('ERROR', `Error during receiver OTA update: ${err instanceof Error ? err.message : String(err)}`);
    if (started && isEsp) {
      sm.log("Hint: The receiver goes back to its firmware some seconds after the update stopped. Wait until it is connected to the Tx module again, then flash again.");
    } else if (started) {
      sm.log("Hint: The receiver stays in its update. Keep it powered and flash again.");
    } else {
      sm.log("Hint: Select the serial port of the Tx module the receiver is connected to, or for an internal Tx module the one of the radio in 'USB Serial (VCP)' mode. The Tx module needs a firmware which supports OTA and Privacy off, and the receiver must have been flashed by wire once with a firmware which supports OTA.");
    }
    if (radio) sm.log("Hint: Restart the radio before you flash again, it passes its USB through to the Tx module until then.");
    throw err;
  } finally {
    try { await relay?.end(); } catch { /* port may be gone */ }
    await serial.close();
  }
}
