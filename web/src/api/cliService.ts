// CLI service - serial communication with mLRS CLI for parameter management

import { BufferedSerial } from './bufferedSerial';
import type { CliParameter } from './cliParser';
import { parseParameterList, parseParameterOptions } from './cliParser';

export class CliSession {
  private serial: BufferedSerial | null = null;
  // command queue ensures only one command runs at a time on the serial link
  private commandQueue: Promise<void> = Promise.resolve();

  /**
   * connect to a serial port for CLI communication
   */
  async connect(port: SerialPort, onLog?: (msg: string) => void): Promise<void> {
    if (this.serial) {
      await this.disconnect();
    }
    const serial = new BufferedSerial(port, onLog);
    await serial.connect({ baudRate: 115200 });
    this.serial = serial;

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
  async disconnect(): Promise<void> {
    this.commandQueue = Promise.resolve();
    if (!this.serial) return;
    try {
      await this.serial.close();
    } catch {
      // ignore close errors
    }
    this.serial = null;
  }

  /**
   * send a CLI command and collect the full response
   * commands are serialized so concurrent callers queue rather than corrupt each other
   *
   * @param idleGap ms of silence before considering the response complete.
   *                use a short value (50ms) for small responses like option queries,
   *                and a longer value (500ms) for large responses like 'pl'.
   */
  sendCommand(command: string, timeout = 5000, idleGap = 500): Promise<string> {
    if (!this.serial) throw new Error('Not connected');

    return new Promise<string>((resolve, reject) => {
      this.commandQueue = this.commandQueue.catch(() => {}).then(async () => {
        try {
          resolve(await this.executeCommand(command, timeout, idleGap));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private async executeCommand(command: string, timeout: number, idleGap: number): Promise<string> {
    if (!this.serial) throw new Error('Not connected');
    const serial = this.serial;

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
        // no bytes available - wait to see if more data arrives
        await sleep(idleGap);
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
  async listParameters(): Promise<CliParameter[]> {
    const response = await this.sendCommand('pl', 8000);
    return parseParameterList(response);
  }

  /**
   * query available options for a single parameter
   */
  async queryParameterOptions(paramName: string): Promise<CliParameter | null> {
    const safeName = paramName.replace(/ /g, '_');
    const response = await this.sendCommand(`p ${safeName} = ?`, 3000, 50);
    return parseParameterOptions(response, paramName);
  }

  /**
   * set a parameter value
   */
  async setParameter(
    paramName: string,
    value: string
  ): Promise<{ success: boolean; response: string }> {
    const safeName = paramName.replace(/ /g, '_');
    const response = await this.sendCommand(`p ${safeName} = ${value}`, 3000, 50);

    const hasError = response.includes('err:');
    return { success: !hasError, response };
  }

  /**
   * store parameters to EEPROM
   */
  async storeParameters(): Promise<string> {
    return this.sendCommand('pstore', 3000);
  }

  /**
   * get device version info
   */
  async getVersion(): Promise<string> {
    return this.sendCommand('v', 3000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
