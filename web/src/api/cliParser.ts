// CLI response parser for mLRS parameter output

export type ParamType = 'list' | 'int8' | 'str6';

export interface ListOption {
  index: number;
  label: string;
}

export interface CliParameter {
  name: string;
  type: ParamType;
  // current value
  currentValue: string;
  currentIndex?: number;
  // LIST type
  options?: ListOption[];
  unchangeable?: boolean;
  unavailable?: boolean;
  // INT8 type
  min?: number;
  max?: number;
  unit?: string;
  // STR6
  charset?: string;
}

/**
 * parse the output of the 'pl' command into structured parameters
 *
 * format examples:
 *   Mode = 50 Hz [0]
 *   Mode = 50 Hz [0](unchangeable)
 *   Mode = - (unavailable)
 *   Rx FS Ch1 = 0 %
 *   Bind Phrase = mlrs.0
 *   Bind Phrase = mlrs.0 /e6
 */
export function parseParameterList(response: string): CliParameter[] {
  const params: CliParameter[] = [];
  const lines = response.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    // parse ConfigId line (e.g. "ConfigId: 0") as a read-only parameter
    const configIdMatch = trimmed.match(/^ConfigId:\s*(\d+)$/);
    if (configIdMatch) {
      params.push({
        name: 'Config ID',
        type: 'list',
        currentValue: configIdMatch[1],
        unchangeable: true,
      });
      continue;
    }

    // parameter lines start with two spaces and contain ' = '
    if (!line.startsWith('  ') || !line.includes(' = ')) continue;

    // skip non-parameter lines
    if (trimmed.startsWith('warn:')) continue;
    if (trimmed.startsWith('err:')) continue;

    const eqIdx = trimmed.indexOf(' = ');
    if (eqIdx === -1) continue;

    const name = trimmed.substring(0, eqIdx);
    const valuePart = trimmed.substring(eqIdx + 3);

    // check for unavailable
    if (valuePart === '- (unavailable)') {
      params.push({
        name,
        type: 'list',
        currentValue: '-',
        unavailable: true,
      });
      continue;
    }

    // check for LIST type: value [index] or value [index](unchangeable)
    const listMatch = valuePart.match(/^(.+?)\s+\[(\d+)\](\(unchangeable\))?$/);
    if (listMatch) {
      params.push({
        name,
        type: 'list',
        currentValue: listMatch[1],
        currentIndex: parseInt(listMatch[2], 10),
        unchangeable: !!listMatch[3],
      });
      continue;
    }

    // check for INT8 type: value followed by a known unit like %
    // INT8 params have numeric values optionally followed by a unit
    const int8Match = valuePart.match(/^(-?\d+)\s*(%|dBm|us|ms|Hz)?$/);
    if (int8Match) {
      params.push({
        name,
        type: 'int8',
        currentValue: int8Match[1],
        unit: int8Match[2] || '',
      });
      continue;
    }

    // STR6 type: 6-character string (bind phrase), possibly with /exception suffix
    // strip any /-- or /eN suffix
    const str6Match = valuePart.match(/^([a-z0-9#\-._]{1,6})(\s+\/\S+)?$/);
    if (str6Match) {
      params.push({
        name,
        type: 'str6',
        currentValue: str6Match[1],
      });
      continue;
    }

    // fallback: treat as list with no index parsed
    params.push({
      name,
      type: 'list',
      currentValue: valuePart,
    });
  }

  return params;
}

/**
 * parse the output of 'p <name> = ?' which lists available options
 *
 * LIST format:
 *   Mode = 50 Hz [0]
 *   0 = 50 Hz
 *   1 = 31 Hz
 *   2 = 19 Hz
 *
 * INT8 format:
 *   Rx FS Ch1 = 0 %
 *   min: -120
 *   max: 120
 *
 * STR6 format:
 *   Bind Phrase = mlrs.0
 *   [a-z0-9#-._]
 */
export function parseParameterOptions(
  response: string,
  paramName: string
): CliParameter | null {
  const lines = response.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  // skip ConfigId line
  const dataLines = lines.filter(l => !l.startsWith('ConfigId:') && !l.startsWith('warn:'));
  if (dataLines.length === 0) return null;

  // first data line should be the current value
  const firstLine = dataLines[0];
  const eqIdx = firstLine.indexOf(' = ');
  if (eqIdx === -1) return null;

  const valuePart = firstLine.substring(eqIdx + 3);

  // check for LIST options: remaining lines are "index = label"
  const options: ListOption[] = [];
  let hasListOptions = false;
  for (let i = 1; i < dataLines.length; i++) {
    const optMatch = dataLines[i].match(/^(\d+)\s*=\s*(.+)$/);
    if (optMatch) {
      hasListOptions = true;
      options.push({
        index: parseInt(optMatch[1], 10),
        label: optMatch[2].trim(),
      });
    }
  }

  if (hasListOptions) {
    const listMatch = valuePart.match(/^(.+?)\s+\[(\d+)\](\(unchangeable\))?$/);
    return {
      name: paramName,
      type: 'list',
      currentValue: listMatch ? listMatch[1] : valuePart,
      currentIndex: listMatch ? parseInt(listMatch[2], 10) : 0,
      unchangeable: listMatch ? !!listMatch[3] : false,
      options,
    };
  }

  // check for INT8 min/max
  let min: number | undefined;
  let max: number | undefined;
  for (const dl of dataLines.slice(1)) {
    const minMatch = dl.match(/^min:\s*(-?\d+)$/);
    if (minMatch) min = parseInt(minMatch[1], 10);
    const maxMatch = dl.match(/^max:\s*(-?\d+)$/);
    if (maxMatch) max = parseInt(maxMatch[1], 10);
  }

  if (min !== undefined && max !== undefined) {
    const int8Match = valuePart.match(/^(-?\d+)\s*(%|dBm|us|ms|Hz)?$/);
    return {
      name: paramName,
      type: 'int8',
      currentValue: int8Match ? int8Match[1] : valuePart,
      unit: int8Match ? (int8Match[2] || '') : '',
      min,
      max,
    };
  }

  // check for STR6 charset
  const charsetLine = dataLines.find(l => l.startsWith('[') && l.endsWith(']'));
  if (charsetLine) {
    const str6Match = valuePart.match(/^([a-z0-9#\-._]{1,6})(\s+\/\S+)?$/);
    return {
      name: paramName,
      type: 'str6',
      currentValue: str6Match ? str6Match[1] : valuePart,
      charset: charsetLine,
    };
  }

  return null;
}
