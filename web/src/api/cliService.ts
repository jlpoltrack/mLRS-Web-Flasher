// CLI service - serial communication with mLRS CLI for parameter management

import { BufferedSerial } from './bufferedSerial';
import { SERIAL_FILTERS } from '../constants';
import { formatPortName } from './hardwareService';
import type { CliParameter } from './cliParser';
import { parseParameterList, parseParameterOptions } from './cliParser';

export interface CliConnection {
  serial: BufferedSerial;
  port: SerialPort;
}

let connection: CliConnection | null = null;

/**
 * prompt the user to select a serial port for CLI communication
 */
export async function selectPort(): Promise<{ port: SerialPort; name: string } | null> {
  if (!navigator.serial) {
    throw new Error('Web Serial API not supported in this browser.');
  }
  try {
    const port = await navigator.serial.requestPort({ filters: [...SERIAL_FILTERS] });
    return { port, name: formatPortName(port) };
  } catch {
    return null; // user cancelled
  }
}

/**
 * connect to a serial port for CLI communication
 */
export async function connect(
  port: SerialPort,
  onLog?: (msg: string) => void
): Promise<void> {
  if (connection) {
    await disconnect();
  }
  const serial = new BufferedSerial(port, onLog);
  await serial.connect({ baudRate: 115200 });
  connection = { serial, port };

  // flush any stale data and send a newline to get a clean prompt
  await sleep(200);
  serial.flush();
  await serial.write(new TextEncoder().encode('\r'));
  await sleep(200);
  serial.flush();
}

/**
 * disconnect the current CLI session
 */
export async function disconnect(): Promise<void> {
  if (!connection) return;
  try {
    await connection.serial.close();
  } catch {
    // ignore close errors
  }
  connection = null;
}

/**
 * check if currently connected
 */
export function isConnected(): boolean {
  return connection !== null;
}

/**
 * send a CLI command and collect the full response
 * handles echo stripping and chunked output accumulation
 */
export async function sendCommand(command: string, timeout = 5000): Promise<string> {
  if (!connection) throw new Error('Not connected');
  const { serial } = connection;

  // flush any pending data
  serial.flush();

  // send the command
  const encoded = new TextEncoder().encode(command + '\r');
  await serial.write(encoded);

  // accumulate response in chunks until no more data arrives
  // the firmware sends: echo of command, then >\r\n, then the response data
  const decoder = new TextDecoder();
  let response = '';
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const available = serial.bytesAvailable;
    if (available > 0) {
      // read all available bytes at once
      const chunk = await serial.read(available, 200);
      response += decoder.decode(chunk, { stream: true });
    } else if (response.length > 0) {
      // no bytes available - wait a bit to see if more data arrives
      await sleep(150);
      if (serial.bytesAvailable === 0) {
        break; // no more data coming, response is complete
      }
    } else {
      // nothing received yet, wait for first data
      try {
        const chunk = await serial.read(1, 200);
        response += decoder.decode(chunk, { stream: true });
      } catch {
        // read timeout, keep waiting until overall timeout
      }
    }
  }

  // flush decoder to handle any incomplete UTF-8 sequences
  response += decoder.decode(new Uint8Array(), { stream: false });

  // strip the echoed command from the beginning
  // the firmware echoes what we typed, then outputs >\r\n before the response
  // anchor search to the start of the response (within the echo region only)
  const echoEnd = command.length + 20; // echo + some margin for \r\n and >
  const searchRegion = response.substring(0, Math.min(echoEnd, response.length));
  const promptIdx = searchRegion.indexOf('>\r\n');
  if (promptIdx !== -1) {
    response = response.substring(promptIdx + 3);
  } else {
    // fallback: strip the echoed command if found at the start
    const cmdIdx = searchRegion.indexOf(command);
    if (cmdIdx !== -1) {
      response = response.substring(cmdIdx + command.length);
    }
  }

  return response.trim();
}

/**
 * send 'pl' to list all parameters
 */
export async function listParameters(): Promise<CliParameter[]> {
  const response = await sendCommand('pl', 8000);
  return parseParameterList(response);
}

/**
 * query available options for a single parameter
 */
export async function queryParameterOptions(
  paramName: string
): Promise<CliParameter | null> {
  const safeName = paramName.replace(/ /g, '_');
  const response = await sendCommand(`p ${safeName} = ?`, 3000);
  return parseParameterOptions(response, paramName);
}

/**
 * set a parameter value
 */
export async function setParameter(
  paramName: string,
  value: string
): Promise<{ success: boolean; response: string }> {
  const safeName = paramName.replace(/ /g, '_');
  const response = await sendCommand(`p ${safeName} = ${value}`, 3000);

  const hasError = response.includes('err:');
  return { success: !hasError, response };
}

/**
 * store parameters to EEPROM
 */
export async function storeParameters(): Promise<string> {
  return sendCommand('pstore', 3000);
}

/**
 * get device version info
 */
export async function getVersion(): Promise<string> {
  return sendCommand('v', 3000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
