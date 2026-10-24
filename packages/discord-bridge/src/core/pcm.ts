import { CHANNELS, FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE } from "./constants.js";

/** Mono s16le to interleaved stereo s16le. */
export function monoToStereo(mono: Buffer): Buffer {
  const out = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length / 2; i++) {
    const s = mono.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

/**
 * Sum interleaved stereo s16le frames. If the sum would clip, the whole frame is scaled down
 * so the peak lands at full scale (attenuate, never hard-clip a naive sum).
 */
export function mixFrames(frames: readonly Buffer[]): Buffer {
  const acc = new Int32Array(FRAME_SAMPLES * CHANNELS);
  for (const f of frames) {
    const n = Math.min(acc.length, Math.floor(f.length / 2));
    for (let i = 0; i < n; i++) acc[i] += f.readInt16LE(i * 2);
  }
  let peak = 0;
  for (let i = 0; i < acc.length; i++) peak = Math.max(peak, Math.abs(acc[i]));
  const scale = peak > 32767 ? 32767 / peak : 1;
  const out = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < acc.length; i++) out.writeInt16LE(Math.round(acc[i] * scale), i * 2);
  return out;
}

/** One 20 ms stereo frame of a sine tone, continuing from `phaseSamples`. */
export function toneFrame(freqHz: number, phaseSamples: number, amplitude = 0.4): Buffer {
  const out = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freqHz * (phaseSamples + i)) / SAMPLE_RATE) * amplitude * 32767);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** Goertzel power of `freqHz` in an interleaved stereo buffer (left channel). */
export function goertzelPower(pcm: Buffer, freqHz: number): number {
  const n = Math.floor(pcm.length / 4);
  const k = (2 * Math.cos((2 * Math.PI * freqHz) / SAMPLE_RATE));
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = pcm.readInt16LE(i * 4) / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n);
}

export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}
