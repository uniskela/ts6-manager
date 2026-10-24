import { FrameMixer } from "./frame-mixer.js";
import type { BotId } from "./ids.js";
import { LatencyStats } from "./metrics.js";
import type { OpusCodec } from "./opus.js";
import type { ReceiverElection } from "./receiver-election.js";

interface Meta {
  bot: BotId;
  generation: number;
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
}

/**
 * Discord to TeamSpeak: one mix into the shared TeamSpeak client. The receiver generation is
 * checked when a frame is pushed and again when it is mixed, so frames from a bot that lost the
 * receiver role never reach TeamSpeak even if their callback fires late.
 */
export class DiscordToTsPipeline {
  private readonly mixer: FrameMixer<Meta>;
  private readonly decoders = new Map<string, OpusCodec>();
  private encoder: OpusCodec | null = null;
  private speaking = false;
  private idleTicks = 0;
  selfSourceDrops = 0;
  framesSent = 0;
  readonly transitLatency = new LatencyStats();

  constructor(private readonly o: Options) {
    this.mixer = new FrameMixer<Meta>((m) => o.election.admitFrame(m.bot, m.generation));
  }

  onDiscordOpus(bot: BotId, generation: number, userId: string, opus: Buffer, nowMs: number): void {
    if (this.o.bridgeUserIds().has(userId)) {
      this.selfSourceDrops += 1;
      return;
    }
    if (!this.o.election.admitFrame(bot, generation)) return;
    let dec = this.decoders.get(userId);
    if (!dec) {
      dec = this.o.codecFactory();
      this.decoders.set(userId, dec);
    }
    let pcm: Buffer;
    try {
      pcm = dec.decode(opus);
    } catch {
      return; // a corrupt packet must not take the receiver down
    }
    this.mixer.push(userId, pcm, { bot, generation }, nowMs);
  }

  /** Teardown of a bot's subscriptions: drop everything it queued. */
  flush(): void {
    this.mixer.flush();
  }

  /** Call every 20 ms. */
  tick(nowMs: number): void {
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
    this.encoder ??= this.o.codecFactory();
    this.o.out.sendVoice(this.encoder.encode(mixed.pcm));
    this.framesSent += 1;
    this.transitLatency.record(nowMs - mixed.oldestArrivedMs);
  }

  get fenceDroppedAtMix(): number {
    return this.mixer.droppedAdmit;
  }

  dispose(): void {
    for (const d of this.decoders.values()) d.dispose();
    this.decoders.clear();
    this.encoder?.dispose();
  }
}
