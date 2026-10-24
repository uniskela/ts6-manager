/**
 * Opus packet framing (RFC 6716 section 3). Discord plays one packet per 20 ms player tick, so a
 * packet carrying more than 20 ms must be cut into 20 ms packets, and a packet that cannot be cut
 * (one 40 ms or 60 ms frame, or sub-20 ms frames that do not add up to 20 ms) must not be forwarded
 * as if it were 20 ms of audio.
 */
export type SplitResult =
  /** Whole 20 ms packets, in order. A plain 20 ms packet comes back as itself, byte for byte. */
  | { kind: "frames"; frames: Buffer[] }
  /** Well formed, but its frames cannot be carried as 20 ms packets without re-encoding. */
  | { kind: "unsupported"; durationMs: number }
  | { kind: "invalid" };

const MAX_FRAME_BYTES = 1275;
const MAX_PACKET_MS = 120;

/** Frame duration in ms for a TOC configuration number. */
function frameMs(config: number): number {
  if (config < 12) return [10, 20, 40, 60][config & 3]; // SILK-only
  if (config < 16) return config & 1 ? 20 : 10; // hybrid
  return [2.5, 5, 10, 20][config & 3]; // CELT-only
}

/** A frame length: one byte below 252, otherwise two bytes. */
function readLength(buf: Buffer, at: number): { len: number; size: number } | null {
  const first = buf[at];
  if (first === undefined) return null;
  if (first < 252) return { len: first, size: 1 };
  const second = buf[at + 1];
  return second === undefined ? null : { len: 4 * second + first, size: 2 };
}

function frameData(packet: Buffer): Buffer[] | null {
  const code = packet[0] & 3;
  const ms = frameMs(packet[0] >> 3);
  if (code === 0) return [packet.subarray(1)];
  if (code === 1) {
    const rest = packet.length - 1;
    if (rest % 2 !== 0) return null;
    return [packet.subarray(1, 1 + rest / 2), packet.subarray(1 + rest / 2)];
  }
  if (code === 2) {
    const first = readLength(packet, 1);
    if (!first) return null;
    const start = 1 + first.size;
    if (first.len > packet.length - start) return null;
    return [packet.subarray(start, start + first.len), packet.subarray(start + first.len)];
  }
  // code 3: an arbitrary number of frames
  if (packet.length < 2) return null;
  const header = packet[1];
  const vbr = (header & 0x80) !== 0;
  const padded = (header & 0x40) !== 0;
  const count = header & 0x3f;
  if (count === 0 || count * ms > MAX_PACKET_MS) return null;
  let at = 2;
  let padding = 0;
  if (padded) {
    for (;;) {
      const b = packet[at++];
      if (b === undefined) return null;
      padding += b === 255 ? 254 : b;
      if (b !== 255) break;
    }
  }
  const end = packet.length - padding;
  if (end < at) return null;
  const frames: Buffer[] = [];
  if (vbr) {
    const lengths: number[] = [];
    for (let i = 0; i < count - 1; i++) {
      const l = readLength(packet, at);
      if (!l) return null;
      lengths.push(l.len);
      at += l.size;
    }
    const used = lengths.reduce((a, b) => a + b, 0);
    if (at + used > end) return null;
    lengths.push(end - at - used);
    for (const len of lengths) {
      frames.push(packet.subarray(at, at + len));
      at += len;
    }
  } else {
    const rest = end - at;
    if (rest % count !== 0) return null;
    for (let i = 0; i < count; i++) frames.push(packet.subarray(at + (i * rest) / count, at + ((i + 1) * rest) / count));
  }
  return frames;
}

export function splitOpusPacket(packet: Buffer): SplitResult {
  if (packet.length < 1) return { kind: "invalid" };
  const frames = frameData(packet);
  if (!frames || frames.some((f) => f.length > MAX_FRAME_BYTES)) return { kind: "invalid" };
  const ms = frameMs(packet[0] >> 3);
  const total = frames.length * ms;
  if (total > MAX_PACKET_MS) return { kind: "invalid" };
  if (total === 20) return { kind: "frames", frames: [packet] }; // already one 20 ms packet
  if (ms !== 20) return { kind: "unsupported", durationMs: total };
  const toc = Buffer.from([packet[0] & 0xfc]); // same configuration and channel bit, one frame
  return { kind: "frames", frames: frames.map((f) => Buffer.concat([toc, f])) };
}
