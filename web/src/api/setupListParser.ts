// parse mLRS setup_list.h from GitHub to extract parameter metadata
// this gives the MAVLink parameter editor display names, option labels, ranges, and units

export type SetupParamType = 'LIST' | 'INT8' | 'STR6';

export interface SetupParamMetadata {
    mavlinkName: string;       // "MODE", "TX_POWER", etc.
    displayName: string;       // "Mode", "Tx Power", etc.
    type: SetupParamType;
    defaultValue: number;
    min: number;
    max: number;
    unit: string;
    options: string[];         // comma-split option labels for LIST type
    isDynamicOptions: boolean; // true for TX_POWER, RX_POWER (hardware-specific)
}

const SETUP_LIST_URL = 'https://raw.githubusercontent.com/olliw42/mLRS/main/mLRS/Common/setup_list.h';

// cache
let cachedMetadata: Map<string, SetupParamMetadata> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// extract #define SETUP_OPT_* "value" macros
function parseOptionDefines(source: string): Map<string, string> {
    const map = new Map<string, string>();
    const regex = /#define\s+(SETUP_OPT_\w+)\s+"([^"]+)"/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        map.set(match[1], match[2]);
    }
    return map;
}

// identify dynamic option references (e.g. SetupMetaData.Tx_Power_optstr)
function parseDynamicOptionDefines(source: string): Set<string> {
    const dynamicSet = new Set<string>();
    const regex = /#define\s+(SETUP_OPT_\w+)\s+SetupMetaData\.\w+/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        dynamicSet.add(match[1]);
    }
    return dynamicSet;
}

// resolve an option string reference from the X-macro
// it can be: a quoted inline string, a SETUP_OPT_* reference, or empty
function resolveOptions(
    optRef: string,
    optionDefines: Map<string, string>,
    dynamicDefines: Set<string>
): { options: string[]; isDynamic: boolean } {
    const trimmed = optRef.trim();

    // inline quoted string: "off,1/3,2/3,3/3"
    const quotedMatch = trimmed.match(/^"([^"]*)"$/);
    if (quotedMatch) {
        const str = quotedMatch[1];
        return {
            options: str ? str.split(',') : [],
            isDynamic: false,
        };
    }

    // SETUP_OPT_* reference
    if (trimmed.startsWith('SETUP_OPT_')) {
        // check if it's dynamic first
        if (dynamicDefines.has(trimmed)) {
            return { options: [], isDynamic: true };
        }
        // look up in static defines
        const value = optionDefines.get(trimmed);
        if (value) {
            return { options: value.split(','), isDynamic: false };
        }
        // not found -- treat as dynamic/unknown
        return { options: [], isDynamic: true };
    }

    // empty or unrecognized
    return { options: [], isDynamic: false };
}

// parse X-macro lines from setup_list.h
// format: X( ptr, TYPE, "Display Name", "MAV_NAME", default, min, max, "unit", optionRef, mask )
function parseXMacros(
    source: string,
    optionDefines: Map<string, string>,
    dynamicDefines: Set<string>
): SetupParamMetadata[] {
    const results: SetupParamMetadata[] = [];

    // match X-macro invocations -- handle multiline with backslash continuations
    // first, join backslash-continued lines
    const joined = source.replace(/\\\n/g, ' ');

    // regex to capture X-macro fields
    // X( ptr, TYPE, "displayName", "mavName", default, min, max, "unit", optionRef, mask )
    // note: optionRef can be a quoted string with commas like "off,1/3,2/3,3/3" or a bare identifier like SETUP_OPT_MODE
    const xRegex = /X\(\s*[^,]+,\s*(LIST|INT8|STR6),\s*"([^"]*)",\s*"([^"]*)",\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*"([^"]*)",\s*("[^"]*"|\S+),\s*[^)]+?\)/g;

    let match;
    while ((match = xRegex.exec(joined)) !== null) {
        const type = match[1] as SetupParamType;
        const displayName = match[2];
        const mavlinkName = match[3];
        const defaultValue = parseInt(match[4], 10);
        const min = parseInt(match[5], 10);
        const max = parseInt(match[6], 10);
        const unit = match[7];
        const optRef = match[8];

        const { options, isDynamic } = resolveOptions(optRef, optionDefines, dynamicDefines);

        results.push({
            mavlinkName,
            displayName,
            type,
            defaultValue,
            min,
            max,
            unit,
            options,
            isDynamicOptions: isDynamic,
        });
    }

    return results;
}

// build the full metadata map including hardcoded MAVLink-only params
function buildMetadataMap(parsed: SetupParamMetadata[]): Map<string, SetupParamMetadata> {
    const map = new Map<string, SetupParamMetadata>();

    // hardcoded MAVLink-only parameters (not in setup_list.h X-macros)
    // these are prepended to fmav_param_list in mavlink_interface_tx.h
    map.set('PSTORE', {
        mavlinkName: 'PSTORE',
        displayName: 'Parameter Store',
        type: 'LIST',
        defaultValue: 0,
        min: 0, max: 1,
        unit: '',
        options: ['idle', 'store'],
        isDynamicOptions: false,
    });

    map.set('CONFIG ID', {
        mavlinkName: 'CONFIG ID',
        displayName: 'Config ID',
        type: 'LIST',
        defaultValue: 0,
        min: 0, max: 0,
        unit: '',
        options: [],
        isDynamicOptions: false,
    });

    map.set('BIND_PHRASE_U32', {
        mavlinkName: 'BIND_PHRASE_U32',
        displayName: 'Bind Phrase',
        type: 'STR6',
        defaultValue: 0,
        min: 0, max: 0,
        unit: '',
        options: [],
        isDynamicOptions: false,
    });

    // add parsed parameters from setup_list.h
    for (const param of parsed) {
        map.set(param.mavlinkName, param);
    }

    return map;
}

export async function fetchParameterMetadata(): Promise<Map<string, SetupParamMetadata>> {
    // return cached if fresh
    if (cachedMetadata && (Date.now() - cacheTime) < CACHE_TTL_MS) {
        return cachedMetadata;
    }

    const response = await fetch(SETUP_LIST_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch setup_list.h: ${response.status} ${response.statusText}`);
    }
    const source = await response.text();

    const optionDefines = parseOptionDefines(source);
    const dynamicDefines = parseDynamicOptionDefines(source);
    const parsed = parseXMacros(source, optionDefines, dynamicDefines);
    const metadataMap = buildMetadataMap(parsed);

    cachedMetadata = metadataMap;
    cacheTime = Date.now();

    return metadataMap;
}
