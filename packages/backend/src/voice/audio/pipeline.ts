import { spawn, spawnSync, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import OpusScript from "opusscript";
import { validateUrl } from "../../utils/url-validator.js";
import { RADIO_EGRESS_PORTS } from "../egress/egress-policy.js";
import { acquireMediaEgress, egressEnvironment, MediaEgressError, mediaEgressEnabled } from "../egress/media-egress.js";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SIZE = 960; // 20ms at 48kHz
export const BYTES_PER_FRAME = FRAME_SIZE * CHANNELS * 2; // 16-bit = 2 bytes per sample
export const FRAME_MS = 20;
const BITRATE = 96000;

export function isRemoteInput(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Protocols ffmpeg may open for a resolved track URL: HTTP(S) to the media
 * egress proxy only, so a playlist or redirect cannot open anything else.
 */
const REMOTE_PROTOCOLS = "http,https,tls,tcp,httpproxy,crypto";

/**
 * Containers a resolved track may be in. Playlist formats (HLS, DASH, concat)
 * are refused, so ffmpeg never opens addresses named inside the response.
 */
const REMOTE_FORMATS = "matroska,webm,mov,mp4,m4a,mp3,ogg,aac,flac,wav";

/**
 * Radio may be Icecast or HLS. Segment and redirect fetches still go through
 * the media egress proxy, so addresses named in a playlist are checked again.
 */
const RADIO_FORMATS = `${REMOTE_FORMATS},hls,mpegts`;

/** Longest a resolved track may stream through one proxy token. */
const FILE_STREAM_EGRESS_TTL_MS = 12 * 60 * 60_000;

export function buildPcmFileArgs(input: string, startSeconds = 0): string[] {
  const args: string[] = [];
  if (startSeconds > 0) {
    args.push("-ss", startSeconds.toFixed(3));
  }
  if (isRemoteInput(input)) {
    args.push(
      "-protocol_whitelist", REMOTE_PROTOCOLS, "-format_whitelist", REMOTE_FORMATS,
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    );
  }
  args.push(
    "-re",
    "-i", input,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-loglevel", "error",
    "pipe:1",
  );
  return args;
}

/** ffmpeg TLS defaults to verify=0; this is required for every HTTPS hop including HLS. */
export const RADIO_TLS_VERIFY_ARGS = ["-tls_verify", "1"] as const;

let cachedHttpsVerify: Error | true | undefined;

/**
 * Refuse HTTPS radio unless this ffmpeg can verify certificates and host names
 * on each request (GnuTLS/libtls/mbedtls). OpenSSL-only builds skip hostname
 * checks unless a single -verifyhost is set, which breaks multi-host HLS.
 */
export function assertFfmpegHttpsVerification(run = spawnSync): void {
  if (cachedHttpsVerify === true) return;
  if (cachedHttpsVerify instanceof Error) throw cachedHttpsVerify;
  const help = run("ffmpeg", ["-hide_banner", "-h", "protocol=tls"], { encoding: "utf8", timeout: 8_000 });
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  if (help.error || help.status !== 0 || !/^\s+-tls_verify\b/m.test(text)) {
    cachedHttpsVerify = new Error("HTTPS radio requires an ffmpeg build that supports -tls_verify");
    throw cachedHttpsVerify;
  }
  const version = run("ffmpeg", ["-hide_banner", "-version"], { encoding: "utf8", timeout: 8_000 });
  const config = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  const opensslOnly = /--enable-openssl\b/.test(config)
    && !/--enable-gnutls\b/.test(config)
    && !/--enable-libtls\b/.test(config)
    && !/--enable-mbedtls\b/.test(config)
    && !/--enable-libcurl\b/.test(config);
  if (opensslOnly) {
    cachedHttpsVerify = new Error("HTTPS radio requires an ffmpeg TLS backend that verifies host names on each request");
    throw cachedHttpsVerify;
  }
  cachedHttpsVerify = true;
}

export function resetFfmpegHttpsVerificationForTests(): void {
  cachedHttpsVerify = undefined;
}

export function buildPcmStreamArgs(input: string): string[] {
  return [
    "-protocol_whitelist", REMOTE_PROTOCOLS, "-format_whitelist", RADIO_FORMATS,
    ...(/^https:/i.test(input) ? RADIO_TLS_VERIFY_ARGS : []),
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-i", input,
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", String(CHANNELS),
    "-loglevel", "error",
    "pipe:1",
  ];
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
   * Decode a finite track (a local file, or a resolved YouTube audio URL) to
   * PCM incrementally at media speed.
   *
   * `-re` prevents ffmpeg from racing through a finite track faster than the
   * 20 ms playback clock, while stream pause/backpressure stops the pipe when
   * the user pauses. This keeps memory bounded for multi-hour tracks.
   */
  async toPcmFileStream(
    input: string,
    startSeconds = 0,
  ): Promise<{ stdout: Readable; process: ChildProcess; kill: () => void }> {
    const remote = isRemoteInput(input);
    if (remote) {
      const urlCheck = await validateUrl(input, { allowedProtocols: ['http:', 'https:'] });
      if (!urlCheck.valid) {
        throw new Error(`Stream URL blocked: ${urlCheck.error}`);
      }
    }
    // A remote input is a URL yt-dlp resolved: ffmpeg reaches it through the media egress proxy.
    const job = remote && mediaEgressEnabled() ? await acquireMediaEgress(input, FILE_STREAM_EGRESS_TTL_MS) : null;
    // ffmpeg is found on PATH as before; the environment only replaces proxy variables.
    const ffmpeg = spawn("ffmpeg", buildPcmFileArgs(input, startSeconds), { // NOSONAR: same PATH lookup as the other ffmpeg spawns
      shell: false,
      env: job ? egressEnvironment(job.proxyUrl) : process.env,
    });
    ffmpeg.once("close", () => job?.release());
    ffmpeg.once("error", () => job?.release());
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
    const urlCheck = await validateUrl(url, { allowedProtocols: ['http:', 'https:'] });
    if (!urlCheck.valid) {
      throw new Error(`Stream URL blocked: ${urlCheck.error}`);
    }
    if (/^https:/i.test(url)) assertFfmpegHttpsVerification();
    const job = await acquireMediaEgress(url, FILE_STREAM_EGRESS_TTL_MS, { ports: RADIO_EGRESS_PORTS });
    if (!job) throw new MediaEgressError();
    const ffmpeg = spawn("ffmpeg", buildPcmStreamArgs(url), {
      shell: false,
      env: egressEnvironment(job.proxyUrl),
    });
    ffmpeg.once("close", () => job?.release());
    ffmpeg.once("error", () => job?.release());
    return {
      stdout: ffmpeg.stdout,
      process: ffmpeg,
      kill: () => {
        try { ffmpeg.kill("SIGKILL"); } catch { }
      },
    };
  }
}
