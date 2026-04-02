import { MavLinkConnection, PARAM_READ_TIMEOUT_MS, PARAM_READ_RETRIES } from './mavlinkConnection';

const REBOOT_WAIT_MS = 2000;

// constants
const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246;

const MLRS_SYS_ID = 51;
const MLRS_COMP_ID = 68;
const MLRS_MAGIC_NUMBER = 1234321;

// ArduPilot passthrough service (port scanning)

export interface ArduPilotSerialPort {
    index: number;        // 1-8 (SERIAL number)
    name: string;         // "SERIAL2 (MAVLink2, 57600)"
    protocol: number;     // 1=MAVLink1, 2=MAVLink2, 28=Scripting
    baudRate: number;     // actual baud rate
}

const FC_SETTLE_TIME_MS = 500;

// baud rate lookup table (ArduPilot SERIAL_BAUD values)
const BAUD_LOOKUP: Record<number, number> = {
    1: 1200,
    2: 2400,
    4: 4800,
    9: 9600,
    19: 19200,
    38: 38400,
    57: 57600,
    111: 111100,
    115: 115200,
    230: 230400,
    256: 256000,
    460: 460800,
    500: 500000,
    921: 921600,
    1500: 1500000,
};

export class ArduPilotPassthroughService {
    private mav: MavLinkConnection;
    private onLog?: (msg: string) => void;

    constructor(port: SerialPort, onLog?: (msg: string) => void) {
        this.mav = new MavLinkConnection(port, onLog);
        this.onLog = onLog;
    }

    async connect(): Promise<boolean> {
        try {
            await this.mav.connect(57600);
            const got = await this.mav.waitForHeartbeat(5000);
            if (got) await new Promise(r => setTimeout(r, FC_SETTLE_TIME_MS)); // let FC settle
            return got;
        } catch (e) {
            this.onLog?.(`ArduPilot connect error: ${e}`);
            return false;
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.mav.disconnect();
        } catch (e) {
            // ignore disconnect errors
        }
    }

    async getMavLinkPorts(onProgress?: (msg: string) => void): Promise<ArduPilotSerialPort[]> {
        const result: ArduPilotSerialPort[] = [];

        // scan SERIAL1 through SERIAL8
        for (let i = 1; i <= 8; i++) {
            onProgress?.(`Scanning SERIAL${i}...`);
            const protocolParam = `SERIAL${i}_PROTOCOL`;
            const baudParam = `SERIAL${i}_BAUD`;

            let protocol: number;
            try {
                // common timeout/retry for scanning
                protocol = await this.mav.paramRead(protocolParam, PARAM_READ_TIMEOUT_MS, PARAM_READ_RETRIES);
            } catch {
                continue;
            }

            // filter to MAVLink-compatible protocols: 1=MAVLink1, 2=MAVLink2, 28=Scripting
            if (protocol !== 1 && protocol !== 2 && protocol !== 28) continue;

            let baudRate = 57600;
            try {
                const baudVal = await this.mav.paramRead(baudParam, PARAM_READ_TIMEOUT_MS, PARAM_READ_RETRIES);
                baudRate = BAUD_LOOKUP[baudVal] || baudVal * 1000;
            } catch { /* use default */ }

            let protocolName = 'MAVLink';
            if (protocol === 1) protocolName = 'MAVLink1';
            else if (protocol === 2) protocolName = 'MAVLink2';
            else if (protocol === 28) protocolName = 'Scripting';

            result.push({
                index: i,
                name: `SERIAL${i} (${protocolName}, ${baudRate})`,
                protocol,
                baudRate,
            });
        }

        return result;
    }
}

// public API

export async function initArduPilotPassthrough(
    port: SerialPort,
    passthroughSerialStr: string,
    isEsp: boolean,
    onLog?: (msg: string) => void
): Promise<{ port: SerialPort, baudRate: number }> {

    // parse target SERIAL index
    const match = passthroughSerialStr.match(/SERIAL(\d+)/i);
    let serialIndex = 2; // default
    if (match) serialIndex = parseInt(match[1]);
    const pProtocolName = `SERIAL${serialIndex}_PROTOCOL`;

    // for ESP reconnection flow
    const info = port.getInfo();
    const targetVid = info.usbVendorId;
    const targetPid = info.usbProductId;

    onLog?.("------------------------------------------------------------");
    onLog?.(`ArduPilot Passthrough - ${passthroughSerialStr}`);
    onLog?.("------------------------------------------------------------");

    // connect to the port (already verified by autoscan)
    let mav: MavLinkConnection | null = new MavLinkConnection(port, onLog);
    let activePort = port;

    try {
        await mav.connect(57600);

        if (!await mav.waitForHeartbeat(5000)) {
            throw new Error(
                "Connection failed: No MAVLink heartbeat detected.\n" +
                "Please ensure the Flight Controller is connected and powered."
            );
        }
        onLog?.("Heartbeat detected!");
        await new Promise(r => setTimeout(r, FC_SETTLE_TIME_MS)); // let FC settle

        // initial setup checks

        // perform parameter checks

        const pBaudName = `SERIAL${serialIndex}_BAUD`;
        const protocol = await mav.paramRead(pProtocolName);
        const baudVal = await mav.paramRead(pBaudName);

        // strict mode validation
        if (protocol !== 2 && protocol !== 28) {
             throw new Error(`Invalid ${pProtocolName}=${protocol}. Must be 2 (MAVLink2) or 28 (Scripting).`);
        }

        // baud rate check — reuse the full lookup table
        const receiverBaud = BAUD_LOOKUP[baudVal] || baudVal * 1000;

        if (receiverBaud !== 57600) {
            onLog?.(`Receiver baud is ${receiverBaud}. Switching link...`);
            await mav.disconnect();
            await new Promise(r => setTimeout(r, 500));
            await mav.connect(receiverBaud);
            // quick verify
            if (!await mav.waitForHeartbeat(5000)) {
                 throw new Error(`Failed to reconnect at ${receiverBaud}.`);
            }
            await new Promise(r => setTimeout(r, FC_SETTLE_TIME_MS)); // let FC settle
        }

        // ESP workflow
        if (isEsp) {
            // assume we always need to force bootloader mode for ESP
            if (protocol !== 28) {
                 onLog?.(`ESP: Setting ${pProtocolName} -> 28 (Scripting)...`);
                 try { await mav.paramSet(pProtocolName, 28); } catch(e) {}

                 onLog?.("---------------------------------------------------");
                 onLog?.("1. Power down the flight controller.");
                 onLog?.("2. Hold down the receiver BOOT button.");
                 onLog?.("3. Power up the flight controller and plug in USB.");
                 onLog?.("   You have 60 seconds to reconnect.");
                 onLog?.("---------------------------------------------------");

                 await mav.disconnect();

                 onLog?.("Please disconnect the flight controller within 60 seconds...");
                 // wait for physical unplug (with 60s timeout)
                 const disconnectStart = Date.now();
                 let disconnected = false;
                 while (Date.now() - disconnectStart < 60000) {
                     try {
                         await activePort.open({ baudRate: 57600 });
                         await activePort.close();
                         // if open worked, device is still here.
                         await new Promise(r => setTimeout(r, 500));
                     } catch (e) {
                         onLog?.("Flight controller disconnected.");
                         disconnected = true;
                         break;
                     }
                 }

                 if (!disconnected) {
                     throw new Error("Timed out waiting for flight controller disconnect.");
                 }

                 onLog?.("Scanning for Reconnection (Active)...");

                 let reconnectedMav: MavLinkConnection | null = null;
                 let reconnectedPort: any = null;
                 const startTime = Date.now();

                 // 60s reconnect loop
                 while (Date.now() - startTime < 60000) {
                     // refresh candidates
                     const allPorts = await (navigator.serial as any).getPorts();
                     const freshCandidates = allPorts.filter((p: any) => {
                         const i = p.getInfo();
                         return i.usbVendorId === targetVid && i.usbProductId === targetPid;
                     });

                     for (let i=0; i<freshCandidates.length; i++) {
                         const p = freshCandidates[i];
                         const m = new MavLinkConnection(p, onLog);
                         try {
                             await m.connect(57600);
                             // quick check 2s
                             if (await m.waitForHeartbeat(2000)) {
                                 onLog?.(`[Candidate ${i+1}] Reconnected & Active!`);
                                 reconnectedMav = m;
                                 reconnectedPort = p;
                                 break;
                             }
                             await m.disconnect();
                         } catch(e) {
                            await m.disconnect().catch(() => {});
                        }
                     }
                     if (reconnectedMav) break;
                     await new Promise(r => setTimeout(r, 500));
                 }

                 if (!reconnectedMav) throw new Error("Timed out waiting for flight controller reconnection.");

                 mav = reconnectedMav;
                 activePort = reconnectedPort;

                 // restore passthrough
                 onLog?.("Restoring passthrough...");
                 await new Promise(r => setTimeout(r, 500)); // boot settle
                 await mav.paramSet(pProtocolName, 2);
                 await mav.paramSet("SERIAL_PASSTIMO", 0);
                 await mav.paramSet("SERIAL_PASS2", serialIndex);
                 await new Promise(r => setTimeout(r, 500));
            } else {
                 // already in 28 - ensure passthrough
                 onLog?.("ESP in Scripting mode. Resetting to passthrough...");
                 await mav.paramSet(pProtocolName, 2);
                 await mav.paramSet("SERIAL_PASSTIMO", 0);
                 await mav.paramSet("SERIAL_PASS2", serialIndex);
                 await new Promise(r => setTimeout(r, 500));
            }

            onLog?.("ESP ready for flashing.");
            // mav will be disconnected in finally
            await new Promise(r => setTimeout(r, 500));
            return { port: activePort, baudRate: receiverBaud };

        } else {
            // STM32
            onLog?.("Activating passthrough...");
            await mav.paramSet(pProtocolName, 2);
            await mav.paramSet("SERIAL_PASSTIMO", 0);
            await mav.paramSet("SERIAL_PASS2", serialIndex);
            await new Promise(r => setTimeout(r, 500));
        }


        onLog?.("check connection to mLRS receiver...");
        // step 1: probe/ping (Conf=0, Action=0)
        let ack = false;
        // try 3 times (reduced from 5 to save time if ACKs are missing)
        for (let i = 0; i < 3; i++) {
             const ackPromise = mav.waitForMwAck(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, MLRS_MAGIC_NUMBER, 500);
             await mav.commandLong(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 0, 0, 0, MLRS_COMP_ID, 0, 0, MLRS_MAGIC_NUMBER, MLRS_SYS_ID, MLRS_COMP_ID, 0);
             if (await ackPromise) {
                 ack = true;
                 break;
             }
             onLog?.(`  Probe retry ${i+1}...`);
        }
        if (!ack) {
             onLog?.("No response to probe. Attempting to proceed...");
        } else {
             onLog?.("mLRS receiver connected");
        }

        // step 2: arm (Conf=1, Action=3)
        onLog?.("arm mLRS receiver for reboot shutdown...");
        ack = false;
        for (let i = 0; i < 3; i++) {
             const ackPromise = mav.waitForMwAck(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, MLRS_MAGIC_NUMBER, 500);
             await mav.commandLong(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 1, 0, 3, MLRS_COMP_ID, 0, 0, MLRS_MAGIC_NUMBER, MLRS_SYS_ID, MLRS_COMP_ID, 1);
             if (await ackPromise) {
                 ack = true;
                 break;
             }

        }
        if (!ack) onLog?.("No response to arm command. Proceeding...");
        else onLog?.("mLRS receiver armed for reboot shutdown");

        // step 3: execute (Conf=2, Action=3)
        onLog?.("mLRS receiver reboot shutdown...");
        await mav.commandLong(MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 2, 0, 3, MLRS_COMP_ID, 0, 0, MLRS_MAGIC_NUMBER, MLRS_SYS_ID, MLRS_COMP_ID, 2);

        onLog?.("mLRS receiver reboot shutdown DONE");
        onLog?.("mLRS receiver jumps to system bootloader in 2 seconds");

        // wait for reboot
        await new Promise(r => setTimeout(r, REBOOT_WAIT_MS));

        onLog?.("PASSTHROUGH READY FOR PROGRAMMING TOOL");
        return { port: activePort, baudRate: receiverBaud };

    } finally {
        if (mav) {
            await mav.disconnect();
        }
    }
}
