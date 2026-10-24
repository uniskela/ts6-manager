import { EventEmitter } from "node:events";
import type { ClientDirectory, DirectoryEvent } from "../core/client-directory.js";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import { preferredOrder, slotBotId, type BotId } from "../core/ids.js";
import { OVERFLOW_NICKNAME, tsNickname } from "../core/nickname.js";
import type { OpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import type { Logger } from "../core/redact.js";
import { SlotRouter } from "../core/slot-router.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "../core/ts-to-discord.js";

export interface BotPort extends DiscordSendSink {
  readonly id: BotId;
  /** Discord user id of this bot (so its audio is never re-forwarded). */
  readonly userId: string;
  readonly healthy: boolean;
  /** True when the current voice join is self-deafened (cannot receive). */
  readonly deaf: boolean;
  join(opts: { receive: boolean }): Promise<void>;
  leave(): void;
  setNickname(nick: string | null): Promise<void>;
  startReceive(generation: number): boolean;
  stopReceive(): void;
  on(event: "unhealthy", cb: (reason: string) => void): unknown;
}

export interface TsPort {
  readonly directory: ClientDirectory;
  readonly clientId: number;
  readonly channelId: number;
  sendVoice(opus: Buffer): void;
  sendVoiceStop(): void;
  on(event: "voice", cb: (data: Buffer) => void): unknown;
  on(event: "directory", cb: (e: DirectoryEvent) => void): unknown;
}

export interface RuntimeOptions {
  ts: TsPort;
  bots: ReadonlyMap<BotId, BotPort>;
  slotCount?: number;
  /** Supply the election when the bots need it before the runtime exists. */
  election?: ReceiverElection;
  codecFactory: () => OpusCodec;
  log: Logger;
  excludedUniqueIds?: ReadonlySet<string>;
  now?: () => number;
}

/**
 * Wires one shared TeamSpeak client to six Discord identities (5 slots + overflow) per the Bridge-K
 * contract. All membership changes run through one serial queue so a join, a teardown and an
 * election never interleave.
 */
export class BridgeRuntime extends EventEmitter {
  readonly router: SlotRouter;
  readonly election: ReceiverElection;
  readonly t2d: TsToDiscordPipeline;
  readonly d2t: DiscordToTsPipeline;
  private readonly inChannel = new Set<BotId>();
  private chain: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly slotCount: number;

  constructor(private readonly o: RuntimeOptions) {
    super();
    this.slotCount = o.slotCount ?? 5;
    this.now = o.now ?? (() => performance.now());
    this.router = new SlotRouter(this.slotCount);
    this.election = o.election ?? new ReceiverElection(preferredOrder(this.slotCount));
    this.t2d = new TsToDiscordPipeline({
      directory: o.ts.directory,
      router: this.router,
      sinks: o.bots,
      codecFactory: o.codecFactory,
      channelId: () => o.ts.channelId,
      ownClid: () => o.ts.clientId,
      excludedUniqueIds: o.excludedUniqueIds,
    });
    this.d2t = new DiscordToTsPipeline({
      election: this.election,
      codecFactory: o.codecFactory,
      out: o.ts,
      bridgeUserIds: () => new Set([...o.bots.values()].map((b) => b.userId).filter(Boolean)),
    });

    // Teardown happens before the successor is elected: drop subscriptions and queued frames now.
    this.election.on("teardown", ({ bot }: { bot: BotId }) => {
      o.bots.get(bot)?.stopReceive();
      this.d2t.flush();
    });
    this.election.on("elected", ({ bot, generation }: { bot: BotId; generation: number }) => {
      this.enqueue(() => this.startReceiving(bot, generation));
    });
    for (const bot of o.bots.values()) {
      bot.on("unhealthy", (reason) => this.enqueue(async () => this.onBotUnhealthy(bot.id, reason)));
    }
    o.ts.on("voice", (data) => this.t2d.onVoice(data, this.now()));
    o.ts.on("directory", (e) => this.enqueue(async () => this.onDirectory(e)));
  }

  /** Called by the bot adapters for each human Opus packet. */
  readonly onHumanOpus = (bot: BotId, generation: number, userId: string, opus: Buffer): void => {
    this.d2t.onDiscordOpus(bot, generation, userId, opus, this.now());
  };

  async start(): Promise<void> {
    for (const c of this.o.ts.directory.inChannel(this.o.ts.channelId)) {
      if (c.clid !== this.o.ts.clientId) this.router.join(c.uniqueId);
    }
    this.ticker = setInterval(() => {
      const t = this.now();
      this.t2d.tickOverflow(t);
      this.d2t.tick(t);
    }, 20);
    await this.enqueue(() => this.sync("start"));
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    await this.chain;
    for (const bot of this.o.bots.values()) bot.leave();
    this.t2d.dispose();
    this.d2t.dispose();
  }

  /** Run `fn` after everything queued before it; errors are logged, never thrown into the caller. */
  enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn).catch((e) => this.o.log.error(`runtime step failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.chain;
  }

  private async onDirectory(e: DirectoryEvent): Promise<void> {
    const ownChannel = this.o.ts.channelId;
    const uid = e.client.uniqueId;
    if (e.client.clid === this.o.ts.clientId || e.client.isQuery) return;
    const present = e.type !== "leave" && e.client.channelId === ownChannel;
    const changes = present ? this.router.join(uid) : this.router.leave(uid);
    for (const c of changes) {
      this.t2d.forget(c.uniqueId);
      this.emit("slotChange", c);
    }
    await this.sync(`ts ${e.type}`);
  }

  private async onBotUnhealthy(bot: BotId, reason: string): Promise<void> {
    this.o.log.warn(`${bot} unhealthy: ${reason}`);
    this.inChannel.delete(bot);
    this.election.setState(bot, { healthy: false, inChannel: false });
    // A non-receiver failure leaves the receiver alone; a receiver failure elects a successor.
    this.election.fail(bot, reason);
    await this.sync(`unhealthy ${bot}`);
  }

  /** Who should be in the Discord channel, per the idle-overflow rules. */
  private desiredMembers(): Set<BotId> {
    const want = new Set<BotId>();
    for (let i = 0; i < this.slotCount; i++) if (this.router.botCarriesAudio(slotBotId(i))) want.add(slotBotId(i));
    if (this.router.botCarriesAudio("overflow")) want.add("overflow");
    if (this.router.occupiedSlots() === 0) want.add(slotBotId(0)); // idle receiver keeps its application name
    return want;
  }

  private async sync(reason: string): Promise<void> {
    const want = this.desiredMembers();
    const idleSlot0 = this.router.occupiedSlots() === 0;

    // 1. Join the bots that must be present, then publish their eligibility.
    for (const id of want) {
      const bot = this.o.bots.get(id)!;
      if (!this.inChannel.has(id) || !bot.healthy) {
        try {
          await bot.join({ receive: id === "overflow" || id === this.election.receiver });
          this.inChannel.add(id);
        } catch (e) {
          this.o.log.warn(`${id} could not join: ${e instanceof Error ? e.message : String(e)}`);
          this.election.setState(id, { healthy: false, inChannel: false });
          continue;
        }
      }
      this.election.setState(id, { healthy: bot.healthy, inChannel: true });
    }
    // 2. Move the receiver off any bot that is about to leave BEFORE it leaves.
    const leaving = [...this.inChannel].filter((id) => !want.has(id));
    for (const id of leaving) this.election.setState(id, { inChannel: false });
    this.election.reconcile(reason);
    // 3. Nicknames, then departures.
    for (const id of want) await this.applyNickname(id, idleSlot0);
    for (const id of leaving) {
      this.o.bots.get(id)?.leave();
      this.inChannel.delete(id);
      void this.o.bots.get(id)?.setNickname(null);
    }
  }

  private async applyNickname(id: BotId, idleSlot0: boolean): Promise<void> {
    const bot = this.o.bots.get(id)!;
    if (id === "overflow") return void (await bot.setNickname(OVERFLOW_NICKNAME));
    if (idleSlot0 && id === "slot-0") return void (await bot.setNickname(null));
    const uid = this.router.slotOccupant(Number(id.slice(5)));
    const name = uid ? this.o.ts.directory.inChannel(this.o.ts.channelId).find((c) => c.uniqueId === uid)?.nickname : undefined;
    await bot.setNickname(tsNickname(name ?? "Unknown"));
  }

  private async startReceiving(bot: BotId, generation: number): Promise<void> {
    const port = this.o.bots.get(bot);
    if (!port || this.election.receiver !== bot || this.election.generation !== generation) return;
    try {
      if (port.deaf) await port.join({ receive: true }); // senders join deaf; a receiver must be undeafened
      if (this.election.receiver !== bot || this.election.generation !== generation) return; // superseded while joining
      if (!port.startReceive(generation)) this.o.log.warn(`${bot} refused to start receiving`);
    } catch (e) {
      this.o.log.warn(`${bot} could not become receiver: ${e instanceof Error ? e.message : String(e)}`);
      this.election.fail(bot, "receive start failed");
    }
  }

  status() {
    return {
      receiver: this.election.receiver,
      generation: this.election.generation,
      inChannel: [...this.inChannel].sort(),
      slots: Array.from({ length: this.slotCount }, (_, i) => this.router.slotOccupant(i) !== null),
      overflowMembers: this.router.overflowMembers().length,
      election: this.election.status(),
      duplicateReceivers: this.election.duplicateReceivers(),
      d2t: { framesSent: this.d2t.framesSent, selfSourceDrops: this.d2t.selfSourceDrops, fenceDroppedAtMix: this.d2t.fenceDroppedAtMix, transitLatencyMs: this.d2t.transitLatency.summary() },
      t2dOverflowLatencyMs: this.t2d.overflowLatency.summary(),
    };
  }
}
