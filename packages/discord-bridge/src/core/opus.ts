import { createRequire } from "node:module";
import { CHANNELS, SAMPLE_RATE } from "./constants.js";

export interface OpusCodec {
  readonly name: "native" | "opusscript";
  encode(pcm: Buffer): Buffer;
  decode(packet: Buffer): Buffer;
  dispose(): void;
}

export type OpusPreference = "native" | "opusscript" | "auto";

const require = createRequire(import.meta.url);

interface NativeEncoder {
  encode(pcm: Buffer): Buffer;
  decode(packet: Buffer): Buffer;
}

interface ScriptEncoder {
  encode(pcm: Buffer, frameSize: number): Buffer;
  decode(packet: Buffer): Buffer;
  delete(): void;
}

function createNative(channels: number): OpusCodec {
  const { OpusEncoder } = require("@discordjs/opus") as { OpusEncoder: new (rate: number, channels: number) => NativeEncoder };
  let enc: NativeEncoder | null = new OpusEncoder(SAMPLE_RATE, channels);
  const live = () => {
    if (!enc) throw new Error("opus codec is disposed");
    return enc;
  };
  return {
    name: "native",
    encode: (pcm) => Buffer.from(live().encode(pcm)),
    decode: (packet) => Buffer.from(live().decode(packet)),
    // The addon has no explicit free: dropping the only reference lets its finalizer release the state.
    dispose: () => void (enc = null),
  };
}

function createScript(channels: number): OpusCodec {
  const OpusScript = require("opusscript") as {
    new (rate: number, channels: number, app: number): ScriptEncoder;
    Application: { AUDIO: number };
  };
  let enc: ScriptEncoder | null = new OpusScript(SAMPLE_RATE, channels, OpusScript.Application.AUDIO);
  const live = () => {
    if (!enc) throw new Error("opus codec is disposed");
    return enc;
  };
  return {
    name: "opusscript",
    encode: (pcm) => Buffer.from(live().encode(pcm, pcm.length / (2 * channels))),
    decode: (packet) => Buffer.from(live().decode(packet)),
    dispose: () => {
      enc?.delete();
      enc = null;
    },
  };
}

/**
 * Native Opus is preferred. `auto` falls back to opusscript only if the native addon fails to
 * load, and the caller can read `codec.name` to record which one ran.
 */
export function createOpusCodec(preference: OpusPreference = "auto", channels = CHANNELS): OpusCodec {
  if (preference === "opusscript") return createScript(channels);
  if (preference === "native") return createNative(channels);
  try {
    return createNative(channels);
  } catch {
    return createScript(channels);
  }
}
