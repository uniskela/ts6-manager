import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import OpusScript from "opusscript";
import { validateUrl } from "../../utils/url-validator.js";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960; // 20ms at 48kHz
export const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 16-bit = 2 bytes per sample
export const FRAME_MS = 20;
const BITRATE = 96000;

export function buildPcmFileArgs(filePath: string, startSeconds = 0): string[] {
  const args: string[] = [];
  if (startSeconds > 0) {
    args.push("-ss", startSeconds.toFixed(3));
  }
  args.push(
    "-re",
    "-i", filePath,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-loglevel", "error",
    "pipe:1",
  );
  return args;
}

export class AudioPipeline {
  private encoder: OpusScript;
  private opusPeak = 0;
  private lastOpusPeakLog = 0;

  constructor() {
    this.encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.encoder.setBitrate(BITRATE);
    // After this.encoder.setBitrate(BITRATE);

    const OPUS_SET_VBR = 4006;
    const OPUS_SET_VBR_CONSTRAINT = 4020;
    const OPUS_SET_SIGNAL = 4024;

    const OPUS_SIGNAL_MUSIC = 3002;

    // Hard CBR (reduces spikes)
    this.encoder.encoderCTL(OPUS_SET_VBR, 0);

    // (Optional; CBR ignores it, but harmless)
    this.encoder.encoderCTL(OPUS_SET_VBR_CONSTRAINT, 1);

    // Tell encoder it’s music (helps tuning)
    this.encoder.encoderCTL(OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
  }

  /**
   * Decode a local audio file to PCM incrementally at media speed.
   *
   * `-re` prevents ffmpeg from racing through a finite file faster than the
   * 20 ms playback clock, while stream pause/backpressure stops the pipe when
   * the user pauses. This keeps memory bounded for multi-hour tracks.
   */
  async toPcmFileStream(
    filePath: string,
    startSeconds = 0,
  ): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void }> {
    const ffmpeg = spawn("ffmpeg", buildPcmFileArgs(filePath, startSeconds), { shell: false });
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill("SIGKILL"); } catch { }
      },
    };
  }

  /**
   * Encode a single PCM frame to Opus, applying volume scaling in real-time.
   */
  encodeFrame(pcmFrame: Buffer, volume: number): Buffer {
    let input = pcmFrame;
    if (volume !== 100) {
      const scaled = Buffer.alloc(pcmFrame.length);
      const factor = volume / 100;
      for (let i = 0; i < pcmFrame.length; i += 2) {
        const sample = pcmFrame.readInt16LE(i);
        const v = Math.round(sample * factor);
        scaled.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
      }
      input = scaled;
    }
    const encoded = this.encoder.encode(input, FRAME_SIZE);
    const opusFrame = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);

    this.opusPeak = Math.max(this.opusPeak, opusFrame.length);

    //const now = Date.now();
    //if (now - this.lastOpusPeakLog > 1000) {
    //  console.log(`[voice] opus peak (1s): ${this.opusPeak} bytes`);
    //  this.opusPeak = 0;
    //  this.lastOpusPeakLog = now;
    //}

    return opusFrame;
  }

  /**
   * Stream audio from a URL to raw PCM (for live radio streams).
   * Returns a readable stdout stream + kill function. Does NOT buffer the entire stream.
   */
  async toPcmStream(url: string): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void }> {
    // C4: Validate URL before passing to ffmpeg
    const urlCheck = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
    if (!urlCheck.valid) {
      throw new Error(`Stream URL blocked: ${urlCheck.error}`);
    }

    const args = [
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", url,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-loglevel", "error",
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", args, { shell: false });
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill("SIGKILL"); } catch { }
      },
    };
  }
}
