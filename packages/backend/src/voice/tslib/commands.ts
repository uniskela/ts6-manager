// TS3 command format: "commandname key=value key=value|key=value"

const ESCAPE_MAP: Record<string, string> = {
  "\\": "\\\\",
  "/": "\\/",
  " ": "\\s",
  "|": "\\p",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};

const UNESCAPE_MAP: Record<string, string> = {
  "\\": "\\",
  "/": "/",
  s: " ",
  p: "|",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

export function tsEscape(str: string): string {
  let result = "";
  for (const ch of str) {
    result += ESCAPE_MAP[ch] ?? ch;
  }
  return result;
}

export function tsUnescape(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\") {
      i++;
      if (i >= str.length) throw new Error("Invalid escape sequence");
      const mapped = UNESCAPE_MAP[str[i]];
      // Unknown escapes (e.g. \H on some TS6 builds) — keep the following char
      result += mapped !== undefined ? mapped : str[i];
    } else {
      result += str[i];
    }
  }
  return result;
}

export interface ParsedCommand {
  name: string;
  params: Record<string, string>;
  groups?: Record<string, string>[]; // For pipe-separated multi-params
}

/**
 * Largest client→server command payload, in UTF-8 bytes.
 * A voice packet is at most 500 bytes: 8 byte MAC + 5 byte header + 487 payload.
 * Anything longer is split across UDP fragments. TeamSpeak shows an in-channel
 * `sendtextmessage` only when that reassembly succeeds; a multi-fragment !help
 * (about 2 KB, five fragments) never appears, while the same text over
 * ServerQuery does. Keep each chat command inside one packet.
 */
export const MAX_TS_COMMAND_BYTES = 487;

/**
 * One or more `sendtextmessage` commands whose UTF-8 size each fits in a
 * single voice packet. Pieces prefer a newline boundary and concatenate back
 * to `msg` with no added separators.
 */
export function buildSendTextCommands(
  msg: string,
  targetmode: 1 | 2,
  target?: number,
): string[] {
  const build = (piece: string) =>
    buildCommand("sendtextmessage", {
      targetmode,
      target: targetmode === 1 ? target : undefined,
      msg: piece,
    });
  return chunkCommandText(msg, build);
}

function chunkCommandText(msg: string, build: (piece: string) => string): string[] {
  if (Buffer.byteLength(build(msg), "utf8") <= MAX_TS_COMMAND_BYTES) {
    return [build(msg)];
  }

  const pieces: string[] = [];
  let rest = msg;
  while (rest.length > 0) {
    let take = largestFittingPrefix(rest, build);
    if (take < rest.length) {
      const nl = rest.lastIndexOf("\n", take - 1);
      // Keep list lines intact when the boundary is not at the very start.
      if (nl >= 40) take = nl + 1;
    }
    if (take < rest.length) {
      const prev = rest.charCodeAt(take - 1);
      const next = rest.charCodeAt(take);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        take -= 1;
      }
    }
    if (take <= 0) take = 1;
    pieces.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return pieces.map(build);
}

/** Longest prefix of `text` whose built command fits in one packet. */
function largestFittingPrefix(text: string, build: (piece: string) => string): number {
  let lo = 1;
  let hi = text.length;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(build(text.slice(0, mid)), "utf8") <= MAX_TS_COMMAND_BYTES) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function buildCommand(
  name: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  let cmd = tsEscape(name);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const strVal =
      typeof value === "boolean"
        ? value
          ? "1"
          : "0"
        : String(value);
    cmd += ` ${key}=${tsEscape(strVal)}`;
  }
  return cmd;
}

export function parseCommand(raw: string): ParsedCommand {
  const parts = raw.split("|");
  const firstPart = parts[0].trim();
  const tokens = firstPart.split(" ");
  const name = tsUnescape(tokens[0]);
  const params: Record<string, string> = {};

  for (let i = 1; i < tokens.length; i++) {
    const eqIdx = tokens[i].indexOf("=");
    if (eqIdx >= 0) {
      const key = tokens[i].substring(0, eqIdx);
      const value = tsUnescape(tokens[i].substring(eqIdx + 1));
      params[key] = value;
    } else {
      params[tokens[i]] = "";
    }
  }

  let groups: Record<string, string>[] | undefined;
  if (parts.length > 1) {
    groups = [params];
    for (let g = 1; g < parts.length; g++) {
      const gTokens = parts[g].trim().split(" ");
      const gParams: Record<string, string> = {};
      for (const token of gTokens) {
        const eqIdx = token.indexOf("=");
        if (eqIdx >= 0) {
          gParams[token.substring(0, eqIdx)] = tsUnescape(
            token.substring(eqIdx + 1)
          );
        } else {
          gParams[token] = "";
        }
      }
      groups.push(gParams);
    }
  }

  return { name, params, groups };
}
