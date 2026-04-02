// shared MAVLink v2 connection handler
// extracted from ardupilotPassthrough.ts for reuse by multiple services

import { MavLinkPacketSplitter, MavLinkPacketParser, MavLinkData, MavLinkProtocolV2, minimal, common } from 'node-mavlink';
import type { MavLinkPacket } from 'node-mavlink';

// communication settings
export const PARAM_READ_TIMEOUT_MS = 500;
export const PARAM_READ_RETRIES = 2;

// registry of all known messages
export const REGISTRY: any = {
    ...minimal.REGISTRY,
    ...common.REGISTRY,
};

export class MavLinkConnection {
    private port: SerialPort;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

    // node-mavlink helpers
    private splitter = new MavLinkPacketSplitter();
    private parser = new MavLinkPacketParser();
    private onLog?: (msg: string) => void;

    // system ID for this GCS
    private mySysId = 255;
    private myCompId = 0; // 0 for GCS

    // target (auto-detected from heartbeat)
    public targetSysId = 1;
    public targetCompId = 1;

    private seq = 0;
    private readLoopActive = false;
    private readLoopPromise: Promise<void> | null = null;

    // packet queue - all received packets go here
    private packetQueue: MavLinkPacket[] = [];

    constructor(port: SerialPort, onLog?: (msg: string) => void) {
        this.port = port;
        this.onLog = onLog;
    }

    async connect(baudRate: number) {
        try {
            await this.port.open({ baudRate });
        } catch (e: any) {
            // port might already be open - check if it's usable
            if (!e?.message?.includes('already open')) {
                throw e;
            }
        }

        // create fresh splitter/parser to avoid corrupted state from previous connections
        this.splitter = new MavLinkPacketSplitter();
        this.parser = new MavLinkPacketParser();
        this.packetQueue = [];

        // wire up pipeline (must be done after creating fresh splitter/parser)
        this.initPipeline();

        if (this.port.readable && this.port.writable) {
            if (this.port.readable.locked) {
                throw new Error("Port readable stream is already locked!");
            }
            this.reader = this.port.readable.getReader();

            if (this.port.writable.locked) {
                 this.reader.releaseLock();
                 throw new Error("Port writable stream is already locked!");
            }
            this.writer = this.port.writable.getWriter();
            this.startReadLoop();
        } else {
            throw new Error("Failed to open port streams");
        }
    }

    async disconnect() {
        this.readLoopActive = false;

        // 1. cancel reader (unblocks reader.read())
        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch { }
        }

        // 2. wait for read loop to finish (with timeout)
        if (this.readLoopPromise) {
            try {
                await Promise.race([
                    this.readLoopPromise,
                    new Promise(r => setTimeout(r, 1000))
                ]);
            } catch { }
            this.readLoopPromise = null;
        }

        // 3. release locks
        if (this.reader) {
            try { this.reader.releaseLock(); } catch { }
            this.reader = null;
        }
        if (this.writer) {
            try { this.writer.releaseLock(); } catch { }
            this.writer = null;
        }

        // 4. close port
        if (this.port) {
            try {
                await this.port.close();
            } catch { }
        }
    }

    private startReadLoop() {
        if (this.readLoopActive) return;
        this.readLoopActive = true;

        if (!this.reader) return;

        this.readLoopPromise = (async () => {
            try {
                while (this.readLoopActive && this.reader) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value) {
                        this.splitter.write(value);
                    }
                }
            } catch {
                // ignore errors on close/cancel
            } finally {
                this.readLoopActive = false;
            }
        })();
    }

    // hook up pipeline
    private initPipeline() {
        // wiring: splitter -> parser -> packet listeners
        this.splitter.on('data', (data: Uint8Array) => {
            this.parser.write(data);
        });

        this.parser.on('data', (packet: MavLinkPacket) => {
            // deserialization: convert raw bytes to typed objects
            const clazz = REGISTRY[packet.header.msgid];
            if (clazz && packet.protocol) {
                (packet as any).payload = packet.protocol.data(packet.payload, clazz);
            }

            // push to queue (cap size to prevent memory leaks from idle connections)
            this.packetQueue.push(packet);
            if (this.packetQueue.length > 200) this.packetQueue.shift();
        });
    }

    // send MAVLink message
    async send(msg: MavLinkData) {
        if (!this.writer) return;

        // use MavLinkProtocolV2 to serialize
        const protocol = new MavLinkProtocolV2(this.mySysId, this.myCompId);
        const buffer = protocol.serialize(msg, this.seq);

        await this.writer.write(buffer);
        this.seq = (this.seq + 1) % 256;
    }

    // poll packet queue for matching packet
    async waitForPacket(msgId: number, timeoutMs = 2000, predicate?: (p: MavLinkPacket) => boolean): Promise<MavLinkPacket | null> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            // exit early if connection is dead
            if (!this.readLoopActive) return null;

            // check queue for matching packet
            for (let i = 0; i < this.packetQueue.length; i++) {
                const packet = this.packetQueue[i];
                if (packet.header.msgid === msgId) {
                    if (predicate && !predicate(packet)) continue;

                    // found it - remove from queue and return
                    this.packetQueue.splice(i, 1);
                    return packet;
                }
            }

            // sleep 10ms then check again
            await new Promise(r => setTimeout(r, 10));
        }

        return null;
    }

    // helpers
    async waitForHeartbeat(timeoutMs = 10000): Promise<boolean> {
        this.onLog?.("wait for heartbeat...");
        const packet = await this.waitForPacket(0, timeoutMs); // 0 = HEARTBEAT
        if (packet) {
            const hb = packet.payload as any;
            this.onLog?.(`HEARTBEAT {type : ${hb.type}, autopilot : ${hb.autopilot}, base_mode : ${hb.baseMode}, custom_mode : ${hb.customMode}, system_status : ${hb.systemStatus}, mavlink_version : ${hb.mavlinkVersion}}`);

            if (hb.autopilot === 3) { // MAV_AUTOPILOT_ARDUPILOTMEGA
                this.targetSysId = packet.header.sysid;
                this.targetCompId = packet.header.compid;
                return true;
            }
        }
        return false;
    }

    async paramRead(paramId: string, timeoutMs: number = PARAM_READ_TIMEOUT_MS, retries: number = PARAM_READ_RETRIES): Promise<number> {
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            const msg = new common.ParamRequestRead();
            msg.paramIndex = -1;
            msg.targetSystem = this.targetSysId;
            msg.targetComponent = this.targetCompId;
            msg.paramId = paramId;

            await this.send(msg);

            // poll queue for PARAM_VALUE
            const pkt = await this.waitForPacket(22, timeoutMs);
            if (pkt) {
                const payload = pkt.payload as any;
                return payload.paramValue;
            }

            // timeout - retry if attempts remain
            if (attempt <= retries) {
                this.onLog?.(`paramRead '${paramId}' timeout, retrying (${attempt}/${retries})...`);
            }
        }

        throw new Error(`No response for ${paramId}`);
    }

    async paramSet(paramId: string, value: number) {
        const msg = new common.ParamSet();
        msg.paramValue = value;
        msg.targetSystem = this.targetSysId;
        msg.targetComponent = this.targetCompId;
        msg.paramId = paramId;
        // paramType is missing in some type definitions but required by ArduPilot
        (msg as any).paramType = 0;

        await this.send(msg);
        // wait for confirmation (poll queue)
        await this.waitForPacket(22, 500); // 22 = PARAM_VALUE
    }

    // poll for COMMAND_ACK with matching command and magic number
    async waitForMwAck(expectedCmd: number, magic: number, timeoutMs = 2000): Promise<boolean> {
        const pkt = await this.waitForPacket(77, timeoutMs, (packet) => {
            const payload = packet.payload as any;
            return payload?.command === expectedCmd && payload?.resultParam2 === magic;
        });
        return pkt !== null;
    }

    async commandLong(cmd: number, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0, p7=0, targetSys?: number, targetComp?: number, confirmation=0) {
        const msg = new common.CommandLong();
        // helper to set params to avoid excessive TS ignores
        const setParams = (m: any) => {
             m._param1 = p1; m._param2 = p2; m._param3 = p3; m._param4 = p4;
             m._param5 = p5; m._param6 = p6; m._param7 = p7;
        };
        setParams(msg);

        msg.command = cmd;
        msg.targetSystem = targetSys ?? this.targetSysId;
        msg.targetComponent = targetComp ?? this.targetCompId;
        msg.confirmation = confirmation;

        await this.send(msg);
    }
}
