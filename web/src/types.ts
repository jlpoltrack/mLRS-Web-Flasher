import type { LogType } from './constants';

export interface LogEntry {
  type: LogType | 'stderr' | 'default' | 'log';
  message: string;
  timestamp?: string;
}

export interface FirmwareFile {
  filename: string;
  url: string;
  size?: number;
}

export interface WirelessBridgeConfig {
  chipset?: string;
  fname?: string;
  erase?: string;
  baud?: number;
  reset?: string;
}

export interface FirmwareMetadata {
  description?: string;
  raw_flashmethod?: string;
  needsPort?: boolean;
  hasWirelessBridge?: boolean;
  isWirelessBridgeFirmware?: boolean;
  chipset?: string;
  erase?: string;
  reset?: string;
  wireless?: WirelessBridgeConfig;
  [key: string]: unknown;
}

// options accepted by api.flash
export interface FlashOptions {
  filename: string;
  version: string;
  // serial port name, or the USB device itself for ST-Link
  port?: string | USBDevice | null;
  // legacy field from the desktop backend; ignored by the web flasher
  programmer?: string;
  usbDeviceName?: string;
  firmwareData?: ArrayBuffer;
  type: string;
  device: string;
  flashMethod?: string;
  passthroughSerial?: string;
  passthroughIdentifier?: number;
  baudrate?: number;
  target?: string;
  reset?: string;
  url?: string;
  erase?: string;
  activationBaud?: number;
  chipset?: string;
}

// payload delivered by the api output callback
export type OutputEvent = { type: 'progress'; progress: number; status?: string } | LogEntry;

export interface Version {
  version: string;
  versionStr: string;
  commit: string;
  gitUrl: string;
}
