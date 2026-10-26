import { FrameMixer } from "./frame-mixer.js";
import type { BotId } from "./ids.js";
import { LatencyStats } from "./metrics.js";
import type { OpusCodec } from "./opus.js";
import type { ReceiverElection } from "./receiver-election.js";
import type { Admission } from "./voice-admission.js";

/** A decoder unused for this long is released; the sweep runs at most this often; the map is capped. */
const DECODER_IDLE_MS = 5_000;
const DECODER_SWEEP_MS = 1_000;
const MAX_DECODERS = 256;

interface Meta {
  bot: BotId;
  generation: number;
  userId: string;
  admission: Admission | undefined;
}

export interface TsVoiceOut {
  sendVoice(opus: Buffer): void;
  sendVoiceStop(): void;
}

interface Options {
  election: ReceiverElection;
  codecFactory: () => OpusCodec;
  out: TsVoiceOut;
  /** Discord user ids of the bridge's own bots. Their audio is never forwarded. */
  bridgeUserIds: () => ReadonlySet<string>;
  /**
   * Is DAVE established on that bot's live connection right now. Checked at push and again at every
   * mix, because the election's flag is only as fresh as the adapter's watchdog. Absent means yes.
   */
  daveLive?: (bot: BotId) => boolean;
  /**
   * Does the frame's voice admission still hold: the user is still in the source channel under that
   * bot's current receive generation and has not left since. Checked at push and again at every mix,
   * so a frame queued before a departure, teardown or replacement never reaches TeamSpeak.
   */
  admitted?: (bot: BotId, userId: string, admission: Admission | undefined) => boolean;
}

/**
 * Discord to TeamSpeak: one mix into the shared TeamSpeak client. The receiver generation, DAVE and
 * the speaker's voice admission are checked when a frame is pushed and again when it is mixed, so
 * frames from a bot that lost the receiver role, or from a user who left, never reach TeamSpeak even
 * if their callback fires late or they were already queued.
 */
export class DiscordToTsPipeline {
  private readonly mixer: FrameMixer<Meta>;
  private readonly decoders = new Map<string, { codec: OpusCodec; lastUsedMs: number }>();
  private encoder: OpusCodec | null = null;
  private speaking = false;
  private idleTicks = 0;
  private lastSweepMs = 0;
  private disposed = false;
  selfSourceDrops = 0;
  framesSent = 0;
  /** Packets the decoder rejected; each one was dropped and that user's decoder replaced. */
  decodeErrors = 0;
  encodeErrors = 0;
  /** Frames dropped because DAVE was not established on the live connection at push or mix time. */
  daveDropped = 0;
  /** Frames dropped because the speaker's voice admission had ended, at push or mix time. */
  admissionDropped = 0;
  readonly transitLatency = new LatencyStats();

  constructor(private readonly o: Options) {
    this.mixer = new FrameMixer<Meta>((m) => this.admit(m));
  }

  private admit(m: Meta): boolean {
    if (!this.o.election.admitFrame(m.bot, m.generation)) return false;
    if (this.o.admitted && !this.o.admitted(m.bot, m.userId, m.admission)) {
      this.admissionDropped += 1;
      return false;
    }
    if (this.o.daveLive && !this.o.daveLive(m.bot)) {
      this.daveDropped += 1;
      return false;
    }
    return true;
  }

  onDiscordOpus(bot: BotId, generation: number, userId: string, opus: Buffer, nowMs: number, admission?: Admission): void {
    if (this.disposed) return;
    if (this.o.bridgeUserIds().has(userId)) {
      this.selfSourceDrops += 1;
      return;
    }
    const meta: Meta = { bot, generation, userId, admission };
    if (!this.admit(meta)) return;
    const pcm = this.decode(userId, opus, nowMs);
    if (pcm) this.mixer.push(userId, pcm, meta, nowMs);
  }

  private decode(userId: string, opus: Buffer, nowMs: number): Buffer | null {
    let entry = this.decoders.get(userId);
    if (!entry) {
      if (this.decoders.size >= MAX_DECODERS) this.evictOldest();
      entry = { codec: this.o.codecFactory(), lastUsedMs: nowMs };
      this.decoders.set(userId, entry);
    }
    entry.lastUsedMs = nowMs;
    try {
      return entry.codec.decode(opus);
    } catch {
      this.decodeErrors += 1; // a corrupt packet must not take the receiver down
      this.release(userId, false);
      return null;
    }
  }

  /** Release a user's decoder; `finish` pads their partial tail so the last samples are still heard. */
  private release(userId: string, finish: boolean): void {
    if (finish) this.mixer.endSource(userId);
    this.decoders.get(userId)?.codec.dispose();
    this.decoders.delete(userId);
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let at = Number.POSITIVE_INFINITY;
    for (const [id, e] of this.decoders) {
      if (e.lastUsedMs < at) {
        at = e.lastUsedMs;
        oldest = id;
      }
    }
    if (oldest !== null) this.release(oldest, true);
  }

  /** A human's receive stream closed or they left: free their decoder now. */
  releaseUser(userId: string): void {
    this.release(userId, true);
  }

  get decoderCount(): number {
    return this.decoders.size;
  }

  /** Teardown of a bot's subscriptions: drop everything it queued and release every decoder. */
  flush(): void {
    this.mixer.flush();
    for (const e of this.decoders.values()) e.codec.dispose();
    this.decoders.clear();
  }

  /** Call every 20 ms. */
  tick(nowMs: number): void {
    if (this.disposed) return;
    this.sweepIdle(nowMs);
    const mixed = this.mixer.tick();
    if (!mixed) {
      if (this.speaking && ++this.idleTicks >= 3) {
        this.speaking = false;
        this.o.out.sendVoiceStop();
      }
      return;
    }
    this.idleTicks = 0;
    this.speaking = true;
    let packet: Buffer;
    try {
      this.encoder ??= this.o.codecFactory();
      packet = this.encoder.encode(mixed.pcm);
    } catch {
      this.encodeErrors += 1;
      this.encoder?.dispose();
      this.encoder = null; // rebuilt on the next tick
      return;
    }
    this.o.out.sendVoice(packet);
    this.framesSent += 1;
    this.transitLatency.record(nowMs - mixed.oldestArrivedMs);
  }

  /** Release decoders of users that went quiet without a close notification. */
  private sweepIdle(nowMs: number): void {
    if (nowMs - this.lastSweepMs < DECODER_SWEEP_MS) return;
    this.lastSweepMs = nowMs;
    for (const [userId, e] of [...this.decoders]) if (nowMs - e.lastUsedMs > DECODER_IDLE_MS) this.release(userId, true);
  }

  get fenceDroppedAtMix(): number {
    return this.mixer.droppedAdmit;
  }

  /** Terminal: discard everything queued, release every codec, and refuse all further audio. */
  dispose(): void {
    this.disposed = true;
    this.mixer.flush();
    for (const d of this.decoders.values()) d.codec.dispose();
    this.decoders.clear();
    this.encoder?.dispose();
    this.encoder = null;
    this.speaking = false;
  }
}
