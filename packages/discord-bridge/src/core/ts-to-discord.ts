import type { ClientDirectory } from "./client-directory.js";
import { FrameMixer } from "./frame-mixer.js";
import type { BotId } from "./ids.js";
import { LatencyStats } from "./metrics.js";
import type { OpusCodec } from "./opus.js";
import { splitOpusPacket } from "./opus-packet.js";
import { parseS2CVoice } from "./ts-voice-packet.js";
import type { SlotRouter } from "./slot-router.js";

export interface DiscordSendSink {
  /** One 20 ms Opus frame for this bot to play into Discord. */
  sendOpus(frame: Buffer, nowMs: number): void;
  /** The speaker(s) feeding this bot stopped. */
  endSpeech(): void;
}

export type RouteResult =
  | { kind: "slot"; bot: BotId; uniqueId: string }
  | { kind: "overflow"; uniqueId: string }
  | { kind: "end"; uniqueId: string }
  | { kind: "dropped"; reason: "malformed" | "unknown-speaker" | "excluded" | "not-in-channel" | "own-voice" | "undecodable" | "unsupported-frame" };

/** A decoder unused for this long is released; the sweep runs at most this often. */
const DECODER_IDLE_MS = 5_000;
const DECODER_SWEEP_MS = 1_000;

interface Options {
  directory: ClientDirectory;
  router: SlotRouter;
  sinks: ReadonlyMap<BotId, DiscordSendSink>;
  codecFactory: () => OpusCodec;
  channelId: () => number;
  ownClid: () => number;
  excludedUniqueIds?: ReadonlySet<string>;
}

/**
 * TeamSpeak to Discord. A speaker on an individual slot is forwarded as untouched Opus to that
 * slot's bot only. Overflow speakers are decoded, mixed with a peak limiter, and re-encoded onto
 * the overflow bot. No path sends one uniqueId to two destinations.
 */
export class TsToDiscordPipeline {
  private readonly overflowMixer = new FrameMixer<null>();
  private readonly decoders = new Map<string, { codec: OpusCodec; lastUsedMs: number }>();
  private overflowEncoder: OpusCodec | null = null;
  private overflowActive = false;
  private lastSweepMs = 0;
  /** Packets the decoder or framing rejected; each one was dropped and the speaker's decoder reset. */
  decodeErrors = 0;
  encodeErrors = 0;
  /** Well formed packets whose frame duration cannot be carried to a slot bot without re-encoding. */
  unsupportedFrames = 0;
  /** bot -> uniqueId -> frames, the per-speaker routing evidence. */
  readonly routed = new Map<BotId, Map<string, number>>();
  readonly overflowLatency = new LatencyStats();

  constructor(private readonly o: Options) {}

  onVoice(data: Buffer, nowMs: number): RouteResult {
    const pkt = parseS2CVoice(data);
    if (!pkt) return { kind: "dropped", reason: "malformed" };
    if (pkt.clid === this.o.ownClid()) return { kind: "dropped", reason: "own-voice" };
    const client = this.o.directory.byClientId(pkt.clid);
    if (!client) return { kind: "dropped", reason: "unknown-speaker" };
    if (client.isQuery || this.o.excludedUniqueIds?.has(client.uniqueId)) return { kind: "dropped", reason: "excluded" };
    if (client.channelId !== this.o.channelId()) return { kind: "dropped", reason: "not-in-channel" };

    const dest = this.o.router.destinationFor(client.uniqueId);
    if (!dest) return { kind: "dropped", reason: "not-in-channel" };

    if (pkt.opus.length === 0) {
      this.disposeDecoder(client.uniqueId);
      this.overflowMixer.endSource(client.uniqueId);
      if (dest !== "overflow") this.o.sinks.get(dest)?.endSpeech();
      return { kind: "end", uniqueId: client.uniqueId };
    }

    if (dest === "overflow") {
      const pcm = this.decode(client.uniqueId, pkt.opus, nowMs);
      if (!pcm) return { kind: "dropped", reason: "undecodable" };
      this.overflowMixer.push(client.uniqueId, pcm, null, nowMs);
      this.count("overflow", client.uniqueId);
      return { kind: "overflow", uniqueId: client.uniqueId };
    }

    // Slot path: untouched Opus, one 20 ms packet per player tick. Multi-frame packets are cut.
    const split = splitOpusPacket(pkt.opus);
    if (split.kind === "invalid") {
      this.decodeErrors += 1;
      return { kind: "dropped", reason: "undecodable" };
    }
    if (split.kind === "unsupported") {
      this.unsupportedFrames += 1;
      return { kind: "dropped", reason: "unsupported-frame" };
    }
    for (const frame of split.frames) this.o.sinks.get(dest)?.sendOpus(frame, nowMs);
    this.count(dest, client.uniqueId, split.frames.length);
    return { kind: "slot", bot: dest, uniqueId: client.uniqueId };
  }

  /** Decode one packet for a speaker. A corrupt packet is dropped and that speaker's decoder is replaced. */
  private decode(uniqueId: string, opus: Buffer, nowMs: number): Buffer | null {
    let entry = this.decoders.get(uniqueId);
    if (!entry) {
      entry = { codec: this.o.codecFactory(), lastUsedMs: nowMs };
      this.decoders.set(uniqueId, entry);
    }
    entry.lastUsedMs = nowMs;
    try {
      return entry.codec.decode(opus);
    } catch {
      this.decodeErrors += 1;
      this.disposeDecoder(uniqueId); // a fresh decoder for the next packet; other speakers are untouched
      return null;
    }
  }

  /** Call every 20 ms. Mixes the overflow speakers and plays them on the overflow bot. */
  tickOverflow(nowMs: number): void {
    this.sweepIdle(nowMs);
    const mixed = this.overflowMixer.tick();
    const sink = this.o.sinks.get("overflow");
    if (!mixed) {
      if (this.overflowActive) {
        this.overflowActive = false;
        sink?.endSpeech();
      }
      return;
    }
    this.overflowActive = true;
    let packet: Buffer;
    try {
      this.overflowEncoder ??= this.o.codecFactory();
      packet = this.overflowEncoder.encode(mixed.pcm);
    } catch {
      this.encodeErrors += 1;
      this.overflowEncoder?.dispose();
      this.overflowEncoder = null; // rebuilt on the next tick
      return;
    }
    sink?.sendOpus(packet, nowMs);
    this.overflowLatency.record(nowMs - mixed.oldestArrivedMs);
  }

  /** Release decoders of speakers that went quiet without an end-of-voice packet. */
  private sweepIdle(nowMs: number): void {
    if (nowMs - this.lastSweepMs < DECODER_SWEEP_MS) return;
    this.lastSweepMs = nowMs;
    for (const [uniqueId, e] of this.decoders) {
      if (nowMs - e.lastUsedMs > DECODER_IDLE_MS) {
        this.overflowMixer.endSource(uniqueId);
        this.disposeDecoder(uniqueId);
      }
    }
  }

  /** A uniqueId left or was reassigned: stop decoding it and drop what is queued for it. */
  forget(uniqueId: string): void {
    this.disposeDecoder(uniqueId);
    this.overflowMixer.flush((s) => s === uniqueId);
  }

  private disposeDecoder(uniqueId: string): void {
    this.decoders.get(uniqueId)?.codec.dispose();
    this.decoders.delete(uniqueId);
  }

  get decoderCount(): number {
    return this.decoders.size;
  }

  private count(bot: BotId, uniqueId: string, frames = 1): void {
    let m = this.routed.get(bot);
    if (!m) {
      m = new Map();
      this.routed.set(bot, m);
    }
    m.set(uniqueId, (m.get(uniqueId) ?? 0) + frames);
  }

  dispose(): void {
    for (const d of this.decoders.values()) d.codec.dispose();
    this.decoders.clear();
    this.overflowEncoder?.dispose();
  }
}
