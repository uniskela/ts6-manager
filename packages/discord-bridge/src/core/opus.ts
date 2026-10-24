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
  const enc = new OpusEncoder(SAMPLE_RATE, channels);
  return {
    name: "native",
    encode: (pcm) => Buffer.from(enc.encode(pcm)),
    decode: (packet) => Buffer.from(enc.decode(packet)),
    dispose: () => undefined,
  };
}

function createScript(channels: number): OpusCodec {
  const OpusScript = require("opusscript") as {
    new (rate: number, channels: number, app: number): ScriptEncoder;
    Application: { AUDIO: number };
  };
  const enc = new OpusScript(SAMPLE_RATE, channels, OpusScript.Application.AUDIO);
  return {
    name: "opusscript",
    encode: (pcm) => Buffer.from(enc.encode(pcm, pcm.length / (2 * channels))),
    decode: (packet) => Buffer.from(enc.decode(packet)),
    dispose: () => enc.delete(),
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
