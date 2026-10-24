import type { ClientDirectory } from "./client-directory.js";
import { FrameMixer } from "./frame-mixer.js";
import type { BotId } from "./ids.js";
import { LatencyStats } from "./metrics.js";
import type { OpusCodec } from "./opus.js";
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
  | { kind: "dropped"; reason: "malformed" | "unknown-speaker" | "excluded" | "not-in-channel" | "own-voice" };

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
  private readonly decoders = new Map<string, OpusCodec>();
  private overflowEncoder: OpusCodec | null = null;
  private overflowActive = false;
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
      if (dest !== "overflow") this.o.sinks.get(dest)?.endSpeech();
      return { kind: "end", uniqueId: client.uniqueId };
    }

    if (dest === "overflow") {
      let dec = this.decoders.get(client.uniqueId);
      if (!dec) {
        dec = this.o.codecFactory();
        this.decoders.set(client.uniqueId, dec);
      }
      this.overflowMixer.push(client.uniqueId, dec.decode(pkt.opus), null, nowMs);
      this.count("overflow", client.uniqueId);
      return { kind: "overflow", uniqueId: client.uniqueId };
    }

    this.o.sinks.get(dest)?.sendOpus(pkt.opus, nowMs);
    this.count(dest, client.uniqueId);
    return { kind: "slot", bot: dest, uniqueId: client.uniqueId };
  }

  /** Call every 20 ms. Mixes the overflow speakers and plays them on the overflow bot. */
  tickOverflow(nowMs: number): void {
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
    this.overflowEncoder ??= this.o.codecFactory();
    sink?.sendOpus(this.overflowEncoder.encode(mixed.pcm), nowMs);
    this.overflowLatency.record(nowMs - mixed.oldestArrivedMs);
  }

  /** A uniqueId left or was reassigned: stop decoding it and drop what is queued for it. */
  forget(uniqueId: string): void {
    this.disposeDecoder(uniqueId);
    this.overflowMixer.flush((s) => s === uniqueId);
  }

  private disposeDecoder(uniqueId: string): void {
    this.decoders.get(uniqueId)?.dispose();
    this.decoders.delete(uniqueId);
  }

  private count(bot: BotId, uniqueId: string): void {
    let m = this.routed.get(bot);
    if (!m) {
      m = new Map();
      this.routed.set(bot, m);
    }
    m.set(uniqueId, (m.get(uniqueId) ?? 0) + 1);
  }

  dispose(): void {
    for (const d of this.decoders.values()) d.dispose();
    this.decoders.clear();
    this.overflowEncoder?.dispose();
  }
}
