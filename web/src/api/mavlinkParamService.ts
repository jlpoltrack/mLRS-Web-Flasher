// MAVLink parameter protocol service for mLRS component
// handles param list/read/set/store via the standard MAVLink parameter microservice

import { common } from 'node-mavlink';
import { MavLinkConnection } from './mavlinkConnection';

// mLRS component identification
const MAV_COMP_ID_TELEMETRY_RADIO = 68;

// MAVLink param types
export const MAV_PARAM_TYPE_UINT8 = 1;
export const MAV_PARAM_TYPE_INT8 = 2;
export const MAV_PARAM_TYPE_UINT32 = 5;

export interface MavParam {
    index: number;
    paramId: string;        // MAVLink param name (max 16 chars)
    value: number;          // raw float value from MAVLink
    paramType: number;      // MAV_PARAM_TYPE_*
    paramCount: number;     // total params reported by device
}

// --- bind phrase conversion (port of mLRS common_types.cpp) ---

const BINDPHRASE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789_#-.';
const BINDPHRASE_BASE = BINDPHRASE_CHARS.length; // 40

export function u32FromBindphrase(phrase: string): number {
    let v = 0;
    let base = 1;
    for (let i = 0; i < 6; i++) {
        const ch = i < phrase.length ? phrase[i] : BINDPHRASE_CHARS[0];
        let n = BINDPHRASE_CHARS.indexOf(ch);
        if (n < 0) n = 0; // invalid char, default to 'a'
        v += n * base;
        base *= BINDPHRASE_BASE;
    }
    // v fits in uint32 (max = 39 * (40^0 + 40^1 + ... + 40^5) = 39 * 104857599 ≈ 4.09B < 2^32)
    return v >>> 0; // ensure unsigned
}

export function bindphraseFromU32(u32: number): string {
    let base = Math.pow(BINDPHRASE_BASE, 5); // 40^5
    const chars: string[] = [];
    let remaining = u32 >>> 0;
    for (let i = 0; i < 6; i++) {
        const v = Math.floor(remaining / base);
        chars.push(v < BINDPHRASE_BASE ? BINDPHRASE_CHARS[v] : '0');
        remaining -= v * base;
        base = Math.floor(base / BINDPHRASE_BASE);
    }
    chars.reverse();
    return chars.join('');
}

// --- float <-> uint32 bitwise reinterpretation ---
// MAVLink transmits all param values as float32.
// For UINT32 params, the bits of the float ARE the uint32 value (not a numeric cast).

const reinterpretBuf = new ArrayBuffer(4);
const reinterpretF32 = new Float32Array(reinterpretBuf);
const reinterpretU32 = new Uint32Array(reinterpretBuf);

export function floatBitsToUint32(f: number): number {
    reinterpretF32[0] = f;
    return reinterpretU32[0];
}

export function uint32ToFloatBits(u: number): number {
    reinterpretU32[0] = u;
    return reinterpretF32[0];
}

// --- extract typed value from raw float using bytewise encoding ---
// mLRS uses MAV_PROTOCOL_CAPABILITY_PARAM_ENCODE_BYTEWISE:
// the parameter's raw bytes are placed into the float field (not a numeric cast)

const extractBuf = new ArrayBuffer(4);
const extractF32 = new Float32Array(extractBuf);
const extractU8 = new Uint8Array(extractBuf);
const extractI8 = new Int8Array(extractBuf);

export function valueToFloatBytewise(value: number, paramType: number): number {
    extractU8[0] = 0; extractU8[1] = 0; extractU8[2] = 0; extractU8[3] = 0;
    switch (paramType) {
        case MAV_PARAM_TYPE_UINT8:
            extractU8[0] = value & 0xFF;
            return extractF32[0];
        case MAV_PARAM_TYPE_INT8:
            extractI8[0] = value;
            return extractF32[0];
        case MAV_PARAM_TYPE_UINT32:
            return uint32ToFloatBits(value);
        default:
            return value;
    }
}

export function paramValueFromFloat(rawFloat: number, paramType: number): number {
    extractF32[0] = rawFloat;
    switch (paramType) {
        case MAV_PARAM_TYPE_UINT8:
            return extractU8[0];
        case MAV_PARAM_TYPE_INT8:
            return extractI8[0];
        case MAV_PARAM_TYPE_UINT32:
            return floatBitsToUint32(rawFloat);
        default:
            return rawFloat;
    }
}

// --- connection ---

export async function connectToMlrs(
    port: SerialPort,
    baudRate: number,
    onLog?: (msg: string) => void
): Promise<MavLinkConnection> {
    const mav = new MavLinkConnection(port, onLog);
    await mav.connect(baudRate);

    onLog?.('Waiting for mLRS heartbeat (compid=68)...');

    // wait for any heartbeat first, logging what we see
    let mlrsPacket = null;
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
        const pkt = await mav.waitForPacket(0, 2000); // any heartbeat
        if (!pkt) continue;

        const hb = pkt.payload as any;
        onLog?.(`HEARTBEAT from sysid=${pkt.header.sysid} compid=${pkt.header.compid} autopilot=${hb.autopilot} type=${hb.type}`);

        if (pkt.header.compid === MAV_COMP_ID_TELEMETRY_RADIO) {
            mlrsPacket = pkt;
            break;
        }
    }
    const packet = mlrsPacket;

    if (!packet) {
        await mav.disconnect();
        throw new Error(
            'No mLRS heartbeat detected (compid=68).\n' +
            'Ensure the Tx module has MAVLink Component enabled\n' +
            'and that the serial link is in MAVLink mode.'
        );
    }

    const hb = packet.payload as any;
    onLog?.(`mLRS HEARTBEAT (sysid=${packet.header.sysid}, compid=${packet.header.compid}, type=${hb.type})`);

    // set target IDs for subsequent messages
    mav.targetSysId = packet.header.sysid;
    mav.targetCompId = packet.header.compid;

    return mav;
}

// --- request all parameters ---

export async function requestAllParams(
    mav: MavLinkConnection,
    onParam?: (param: MavParam) => void,
    onLog?: (msg: string) => void
): Promise<MavParam[]> {
    // send PARAM_REQUEST_LIST
    const msg = new common.ParamRequestList();
    msg.targetSystem = mav.targetSysId;
    msg.targetComponent = mav.targetCompId;
    await mav.send(msg);

    onLog?.('Requesting parameter list...');

    // collect PARAM_VALUE responses
    const params = new Map<number, MavParam>();
    let expectedCount = -1;
    let noResponseCount = 0;
    const MAX_NO_RESPONSE = 10; // give up after 10 consecutive empty polls

    while (noResponseCount < MAX_NO_RESPONSE) {
        // device sends at 50ms intervals; use 200ms timeout per message
        const pkt = await mav.waitForPacket(22, 200); // 22 = PARAM_VALUE
        if (!pkt) {
            noResponseCount++;
            // if we have all params, stop early
            if (expectedCount > 0 && params.size >= expectedCount) break;
            continue;
        }
        noResponseCount = 0;

        const payload = pkt.payload as any;
        const param: MavParam = {
            index: payload.paramIndex,
            paramId: (payload.paramId as string).replace(/\0/g, ''),
            value: payload.paramValue,
            paramType: payload.paramType,
            paramCount: payload.paramCount,
        };

        if (expectedCount < 0) {
            expectedCount = payload.paramCount;
            onLog?.(`Device reports ${expectedCount} parameters`);
        }

        params.set(param.index, param);
        onParam?.(param);

        // check completion
        if (params.size >= expectedCount) break;
    }

    // re-request any missing indices
    if (expectedCount > 0 && params.size < expectedCount) {
        onLog?.(`Received ${params.size}/${expectedCount}, re-requesting missing...`);
        for (let i = 0; i < expectedCount; i++) {
            if (params.has(i)) continue;

            const readMsg = new common.ParamRequestRead();
            readMsg.paramIndex = i;
            readMsg.targetSystem = mav.targetSysId;
            readMsg.targetComponent = mav.targetCompId;
            readMsg.paramId = '';
            await mav.send(readMsg);

            const pkt = await mav.waitForPacket(22, 500);
            if (pkt) {
                const payload = pkt.payload as any;
                const param: MavParam = {
                    index: payload.paramIndex,
                    paramId: (payload.paramId as string).replace(/\0/g, ''),
                    value: payload.paramValue,
                    paramType: payload.paramType,
                    paramCount: payload.paramCount,
                };
                params.set(param.index, param);
                onParam?.(param);
            }
        }
    }

    // sort by index
    const sorted = Array.from(params.values()).sort((a, b) => a.index - b.index);
    onLog?.(`Loaded ${sorted.length} parameters`);
    return sorted;
}

// --- set a single parameter ---

export async function setParam(
    mav: MavLinkConnection,
    paramId: string,
    value: number,
    paramType: number,
    onLog?: (msg: string) => void
): Promise<MavParam | null> {
    const msg = new common.ParamSet();
    msg.targetSystem = mav.targetSysId;
    msg.targetComponent = mav.targetCompId;
    msg.paramId = paramId;
    msg.paramType = paramType;

    // bytewise encoding: place raw bytes into the float field
    msg.paramValue = valueToFloatBytewise(value, paramType);

    await mav.send(msg);

    // wait for PARAM_VALUE confirmation
    const pkt = await mav.waitForPacket(22, 1000, (p) => {
        const pl = p.payload as any;
        const id = (pl.paramId as string).replace(/\0/g, '');
        return id === paramId;
    });

    if (!pkt) {
        onLog?.(`No confirmation for ${paramId}`);
        return null;
    }

    const payload = pkt.payload as any;
    return {
        index: payload.paramIndex,
        paramId: (payload.paramId as string).replace(/\0/g, ''),
        value: payload.paramValue,
        paramType: payload.paramType,
        paramCount: payload.paramCount,
    };
}

// --- store parameters (set PSTORE = 1) ---

export async function storeParams(
    mav: MavLinkConnection,
    onLog?: (msg: string) => void
): Promise<boolean> {
    // wait for firmware to finish propagating the last param change to the RX
    onLog?.('Waiting for parameter sync...');
    await new Promise(r => setTimeout(r, 1000));

    onLog?.('Storing parameters...');
    const result = await setParam(mav, 'PSTORE', 1, MAV_PARAM_TYPE_UINT8, onLog);
    if (result) {
        // firmware needs time to send params to receiver (TX_TASK_RX_PARAM_SET)
        // and write to EEPROM (TX_TASK_PARAM_STORE) before disconnecting
        onLog?.('Waiting for store to complete...');
        await new Promise(r => setTimeout(r, 1000));
        onLog?.('Parameters stored');
        return true;
    }
    onLog?.('Store command failed');
    return false;
}

// --- disconnect ---

export async function disconnectMlrs(mav: MavLinkConnection): Promise<void> {
    await mav.disconnect();
}
