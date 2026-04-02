// erase service - standalone chip erase operations for ESP and STM32
// 2026-03-26

import { ESPLoader, Transport, type Before } from 'esptool-js';
import { DFU, DFUse } from 'webdfu';
import { Stm32UartProtocol } from './stm32UartProtocol';
import { StlinkDevice, FlashOperations, FLASH_BASE } from './stlink';
import { FlasherStateMachine } from './flasherStateMachine';

export interface EraseOptions {
  onProgress?: (progress: number, status: string) => void;
  onLog?: (message: string) => void;
}

/**
 * full chip erase for ESP devices via esptool-js
 */
export async function eraseESP(
  port: SerialPort,
  options: EraseOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', 'Connecting to ESP device...');

  // ensure port is closed so esptool can open it
  if (port.readable || port.writable) {
    try { await port.close(); } catch (_) { /* ignore */ }
    await new Promise(r => setTimeout(r, 500));
  }
  await new Promise(r => setTimeout(r, 500));

  // @ts-ignore: ESPLoader types are not perfect
  const transport = new Transport(port as any);

  const esploader = new ESPLoader({
    transport,
    baudrate: 921600,
    terminal: {
      clean: () => {},
      writeLine: (data: string) => {
        const trimmed = data.trim();
        if (trimmed.length > 0 && trimmed !== 'esptool.js' && !trimmed.startsWith('Serial port')) {
          sm.log(data);
        }
      },
      write: (data: string) => {
        const trimmed = data.trim();
        if (trimmed.length > 0 && trimmed !== 'esptool.js' && !trimmed.startsWith('Serial port')) {
          sm.log(data);
        }
      },
    },
    romBaudrate: 115200,
  });

  try {
    const chipName = await esploader.main('default_reset' as Before);
    sm.log(`Detected chip: ${chipName}`);

    sm.transition('ERASING', 'Performing full chip erase...');
    await esploader.eraseFlash();

    sm.transition('RESETTING', 'Erase complete! Resetting device...');
    await transport.setDTR(false);
    await transport.setRTS(true);
    await new Promise(r => setTimeout(r, 500));
    await transport.setRTS(false);
    await transport.disconnect();

    sm.transition('DONE', 'ESP chip erase complete!');
  } catch (err) {
    sm.transition('ERROR', `ESP erase failed: ${err instanceof Error ? err.message : String(err)}`);
    try { await transport.disconnect(); } catch (_) { /* ignore */ }
    try { if (port.readable || port.writable) await port.close(); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * full chip erase for STM32 via UART bootloader protocol
 */
export async function eraseSTM32UART(
  port: SerialPort,
  options: EraseOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', 'Connecting to STM32 bootloader...');

  // ensure port is closed so protocol can open with correct parity
  if (port.readable || port.writable) {
    try { await port.close(); } catch (_) { /* ignore */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  const protocol = new Stm32UartProtocol(port, (msg) => sm.log(msg));

  try {
    await protocol.connect();
    sm.log('Connected to STM32 bootloader.');

    sm.transition('SYNCING');
    const info = await protocol.get();
    sm.log(`Bootloader version: ${info.version.toString(16)}`);

    const chipId = await protocol.getId();
    sm.log(`Chip ID: 0x${chipId.toString(16)}`);

    sm.transition('ERASING', 'Performing full chip erase (this may take a while)...');
    await protocol.eraseAll();

    sm.transition('DONE', 'STM32 chip erase complete!');
  } catch (err) {
    sm.transition('ERROR', `STM32 UART erase failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && (err.message.includes('no ACK') || err.message.includes('timeout'))) {
      sm.log('Hint: Check your connections and ensure the device is in bootloader mode.');
    }
    throw err;
  } finally {
    await protocol.disconnect();
  }
}

/**
 * full chip erase for STM32 via DFU (WebUSB)
 */
export async function eraseSTM32DFU(
  device: USBDevice,
  options: EraseOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', 'Connecting to STM32 DFU device...');

  try {
    // find DFU interfaces
    const interfaces = DFU.findDeviceDfuInterfaces(device);
    if (!interfaces || interfaces.length === 0) {
      throw new Error('No DFU interfaces found. Ensure device is in DFU mode.');
    }

    // fix interface names if needed
    if (interfaces.some((intf: any) => intf.name === null)) {
      const tempDevice = new DFU.Device(device, interfaces[0]);
      await tempDevice.device_.open();
      await tempDevice.device_.selectConfiguration(1);
      const mapping = await tempDevice.readInterfaceNames();
      await tempDevice.close();

      for (const intf of interfaces) {
        if (intf.name === null) {
          const configIndex = intf.configuration.configurationValue;
          const intfNumber = intf['interface'].interfaceNumber;
          const alt = intf.alternate.alternateSetting;
          if (mapping[configIndex]?.[intfNumber]?.[alt]) {
            intf.name = mapping[configIndex][intfNumber][alt];
          }
        }
      }
    }

    // select flash interface
    let settings = interfaces[0];
    if (interfaces.length > 1) {
      const flashInterface = interfaces.find((a: any) => a.name?.indexOf('Flash') !== -1);
      if (flashInterface) settings = flashInterface;
    }
    sm.log(`DFU interface: ${settings.name || 'Unnamed'} (Alt ${settings.alternate.alternateSetting})`);

    // create DFU device and read descriptors
    let dfu: InstanceType<typeof DFU.Device> | InstanceType<typeof DFUse.Device> = new DFU.Device(device, settings);

    const setupLogging = (dev: any) => {
      dev.logDebug = (msg: string) => console.debug(msg);
      dev.logInfo = (msg: string) => sm.log(msg);
      dev.logWarning = (msg: string) => sm.log(`Warning: ${msg}`);
      dev.logError = (msg: string) => sm.log(`Error: ${msg}`);
      dev.logProgress = () => {};
    };
    setupLogging(dfu);

    await dfu.open();

    // read DFU descriptor for version info
    let dfuVersion = 0;
    try {
      const data = await dfu.readConfigurationDescriptor(0);
      const configDesc = DFU.parseConfigurationDescriptor(data);
      const configValue = dfu.settings.configuration.configurationValue;
      if (configDesc.bConfigurationValue === configValue) {
        for (const desc of configDesc.descriptors) {
          if (desc.bDescriptorType === 0x21 && desc.hasOwnProperty('bcdDFUVersion')) {
            dfuVersion = desc.bcdDFUVersion ?? 0;
            break;
          }
        }
      }
    } catch (_) {
      sm.log('Warning: Could not read DFU descriptor.');
    }

    // switch to DFUse if applicable
    if (dfuVersion === 0x011a && settings.alternate.interfaceProtocol === 0x02) {
      sm.log('DFuSe protocol detected.');
      await dfu.close();
      dfu = new DFUse.Device(device, settings);
      setupLogging(dfu);
      await dfu.open();
    }

    sm.transition('ERASING', 'Performing full chip erase...');

    const dfuseDevice = dfu as InstanceType<typeof DFUse.Device>;
    if (dfuseDevice.memoryInfo?.segments) {
      // erase all writable flash segments
      const writableSegments = dfuseDevice.memoryInfo.segments.filter(s => s.writable);
      sm.log(`Erasing ${writableSegments.length} writable segment(s)...`);

      let segIndex = 0;
      for (const segment of writableSegments) {
        let addr = segment.start;
        while (addr < segment.end) {
          await dfuseDevice.dfuseCommand(DFUse.ERASE_SECTOR, addr, 4);
          addr += segment.sectorSize || 1024;
        }
        segIndex++;
        sm.updateProgress(Math.round((segIndex / writableSegments.length) * 100));
      }
    } else {
      // fallback: download an empty buffer which triggers erase
      sm.log('No DFUse memory info available. Attempting standard DFU detach...');
      throw new Error('Cannot determine flash segments for erase. Device may not support DFUse.');
    }

    sm.transition('DONE', 'STM32 DFU chip erase complete!');

    try { await dfu.close(); } catch (_) { /* ignore */ }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sm.transition('ERROR', `STM32 DFU erase failed: ${errMsg}`);
    sm.logLinuxUsbHint(errMsg);
    throw err;
  }
}

/**
 * full chip erase for STM32 via ST-Link/SWD (WebUSB)
 */
export async function eraseSTM32SWD(
  device: USBDevice,
  options: EraseOptions
): Promise<void> {
  const sm = new FlasherStateMachine(options.onProgress, options.onLog);
  sm.transition('CONNECTING', 'Connecting to ST-Link...');

  const stlink = new StlinkDevice(device, (_level, msg) => sm.log(msg));

  try {
    // connect handles: open USB, enter SWD, detect chip, read flash size
    await stlink.connect();

    if (!stlink.chipInfo) {
      throw new Error('Failed to detect target chip. Check SWD connections.');
    }

    sm.log(`Detected: ${stlink.chipInfo.devType} (ID: 0x${stlink.chipId.toString(16)})`);
    sm.log(`Flash: ${stlink.flashSize / 1024}KB, Page size: ${stlink.chipInfo.flashPageSize}B`);

    // erase all flash pages
    sm.transition('ERASING', 'Performing full chip erase via SWD...');
    const flashOps = new FlashOperations(stlink);
    await flashOps.unlockFlash();
    await flashOps.erasePages(FLASH_BASE, stlink.flashSize, stlink.chipInfo.flashPageSize, (pct, _status) => {
      sm.updateProgress(pct);
    });
    await flashOps.lockFlash();

    // reset target
    sm.log('Resetting target...');
    await stlink.reset();
    await stlink.run();

    sm.transition('DONE', 'STM32 SWD chip erase complete!');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    sm.transition('ERROR', `STM32 SWD erase failed: ${errMsg}`);
    sm.logLinuxUsbHint(errMsg);
    throw err;
  } finally {
    try { await stlink.disconnect(); } catch (_) { /* ignore */ }
  }
}
