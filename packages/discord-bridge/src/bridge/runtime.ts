import { EventEmitter } from "node:events";
import { CallbackErrors, type CallbackSite } from "../core/callback-errors.js";
import type { ClientDirectory, DirectoryEvent } from "../core/client-directory.js";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import { preferredOrder, slotBotId, type BotId } from "../core/ids.js";
import { isJoinCancelled } from "../core/join-errors.js";
import { isRebuildBudgetExhausted } from "../core/rebuild-budget.js";
import { OVERFLOW_NICKNAME, tsNickname } from "../core/nickname.js";
import type { OpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import type { Logger } from "../core/redact.js";
import type { Admission } from "../core/voice-admission.js";
import { SlotRouter, type SlotChange } from "../core/slot-router.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "../core/ts-to-discord.js";

export type NickResult = "ok" | "denied" | "failed";

/** 403 / missing-permissions are permanent for this desired value; everything else is transient. */
export function nickErrorKind(e: unknown): Exclude<NickResult, "ok"> {
  const err = e as { status?: number; code?: number | string };
  if (err.status === 403) return "denied";
  const code = Number(err.code);
  if (code === 50013 || code === 50001) return "denied";
  return "failed";
}

export interface BotPort extends DiscordSendSink {
  readonly id: BotId;
  /** Discord user id of this bot (so its audio is never re-forwarded). */
  readonly userId: string;
  readonly healthy: boolean;
  /** True when the current voice join is self-deafened (cannot receive). */
  readonly deaf: boolean;
  join(opts: { receive: boolean }): Promise<void>;
  leave(): void;
  setNickname(nick: string | null): Promise<NickResult>;
  startReceive(generation: number): boolean;
  stopReceive(): void;
  /** Is DAVE established on the live connection right now (read from the connection, not cached). Absent means yes. */
  daveEstablished?(): boolean;
  /**
   * Does this voice admission still let the user be heard: present in the source channel under this
   * bot's current receive generation, not departed since. The Discord adapter always provides it and
   * refuses a frame without an admission. Absent (test doubles that do not model Discord voice) means yes.
   */
  humanAdmitted?(userId: string, admission: Admission | undefined): boolean;
  on(event: "unhealthy", cb: (reason: string) => void): unknown;
  off(event: "unhealthy", cb: (reason: string) => void): unknown;
}

export interface TsPort {
  readonly directory: ClientDirectory;
  readonly clientId: number;
  readonly channelId: number;
  sendVoice(opus: Buffer): void;
  sendVoiceStop(): void;
  on(event: "voice", cb: (data: Buffer) => void): unknown;
  on(event: "directory", cb: (e: DirectoryEvent) => void): unknown;
  off(event: "voice", cb: (data: Buffer) => void): unknown;
  off(event: "directory", cb: (e: DirectoryEvent) => void): unknown;
}

export interface RetryPolicy {
  /** First retry delay; doubles each attempt up to `maxMs`. */
  baseMs: number;
  maxMs: number;
  /** Failed joins retried before giving up until the next membership event. */
  maxAttempts: number;
}

export type RuntimeState = "created" | "running" | "stopping" | "stopped";

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
  retry?: Partial<RetryPolicy>;
  /** How long `stop()` waits for in-flight work before giving up on it. */
  stopTimeoutMs?: number;
}

const DEFAULT_RETRY: RetryPolicy = { baseMs: 1_000, maxMs: 30_000, maxAttempts: 5 };

/**
 * Wires one shared TeamSpeak client to six Discord identities (5 slots + overflow) per the Bridge-K
 * contract.
 *
 * Membership changes (joins of the bots that must be present, departures, nicknames, election
 * reconciliation) run through one serial queue so they never interleave. Two things deliberately
 * do not wait on that queue: activating a newly elected receiver, and the Discord joins themselves
 * (each bot has at most one join in flight, and a hung or failed one is retried in the background).
 * A reconnect can therefore never delay receiver replacement or other bots' membership.
 *
 * Lifecycle: created, running, stopping, stopped. created is not live: Discord joins wait for
 * start(), which applies the current TeamSpeak directory. Once stopping, nothing is scheduled,
 * listeners are removed, reception is invalidated, queued work is skipped and in-flight joins
 * are aborted.
 */
export class BridgeRuntime extends EventEmitter {
  readonly router: SlotRouter;
  readonly election: ReceiverElection;
  readonly t2d: TsToDiscordPipeline;
  readonly d2t: DiscordToTsPipeline;
  private readonly inChannel = new Set<BotId>();
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly inflightJoins = new Map<BotId, Promise<void>>();
  private readonly activations = new Set<Promise<void>>();
  private readonly tracked = new Set<Promise<unknown>>();
  private readonly retryTimers = new Map<BotId, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<BotId, number>();
  /** maxRecoveries=0 never recovers by time or membership churn; only a new runtime/bot can retry. */
  private readonly permanentlyRefused = new Set<BotId>();
  /** Last name Discord actually accepted. */
  private readonly appliedNick = new Map<BotId, string | null>();
  /** Current TeamSpeak-derived intent. Distinct from applied and from the in-flight REST name. */
  private readonly desiredNick = new Map<BotId, string | null>();
  /** Name of the latest queued REST call; a different pending name must not suppress a compensating update. */
  private readonly pendingNick = new Map<BotId, string | null>();
  /** Permission-denied value: do not retry this (bot, name) until leave/unhealthy or a different desired name succeeds. */
  private readonly nickDenied = new Map<BotId, string | null>();
  /** Transient failures already spent for this desired value (max 2 across unrelated syncs). */
  private readonly nickFailCount = new Map<BotId, { value: string | null; n: number }>();
  /** Last Discord nick request submitted per bot; stale in-flight calls must not apply. */
  private readonly nickEpoch = new Map<BotId, number>();
  private readonly nickChain = new Map<BotId, Promise<void>>();
  private readonly detach: (() => void)[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private lifecycle: RuntimeState = "created";
  private stopping: Promise<void> | null = null;
  /** Failures caught at the network and timer boundaries, per site, with bounded logging. */
  private readonly callbackErrors: CallbackErrors;
  private readonly now: () => number;
  private readonly slotCount: number;
  private readonly retry: RetryPolicy;

  constructor(private readonly o: RuntimeOptions) {
    super();
    this.callbackErrors = new CallbackErrors((line) => o.log.warn(line));
    this.slotCount = o.slotCount ?? 5;
    this.now = o.now ?? (() => performance.now());
    this.retry = { ...DEFAULT_RETRY, ...o.retry };
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
      daveLive: (bot) => o.bots.get(bot)?.daveEstablished?.() ?? true,
      admitted: (bot, userId, admission) => {
        const port = o.bots.get(bot);
        return port?.humanAdmitted ? port.humanAdmitted(userId, admission) : true;
      },
    });

    // Teardown happens before the successor is elected: drop subscriptions and queued frames now.
    const onTeardown = ({ bot }: { bot: BotId }) => {
      if (!this.live()) return;
      o.bots.get(bot)?.stopReceive();
      this.d2t.flush();
    };
    // Activation never waits for the membership queue.
    const onElected = ({ bot, generation }: { bot: BotId; generation: number }) => {
      if (this.live()) this.activate(bot, generation);
    };
    this.election.on("teardown", onTeardown);
    this.election.on("elected", onElected);
    this.detach.push(() => this.election.off("teardown", onTeardown), () => this.election.off("elected", onElected));
    for (const bot of o.bots.values()) {
      const onUnhealthy = (reason: string) => this.onBotUnhealthy(bot.id, reason);
      bot.on("unhealthy", onUnhealthy);
      this.detach.push(() => bot.off("unhealthy", onUnhealthy));
    }
    // Network callbacks: a failure while handling one packet must never reach the UDP socket.
    const onVoice = (data: Buffer) => {
      if (this.lifecycle !== "running") return;
      try {
        this.t2d.onVoice(data, this.now());
      } catch (e) {
        this.noteCallbackError("teamspeak voice", e);
      }
    };
    const onDirectory = (e: DirectoryEvent) => this.schedule(async () => this.onDirectory(e));
    o.ts.on("voice", onVoice);
    o.ts.on("directory", onDirectory);
    this.detach.push(() => o.ts.off("voice", onVoice), () => o.ts.off("directory", onDirectory));
  }

  private live(): boolean {
    return this.lifecycle === "running";
  }

  private noteCallbackError(where: CallbackSite, e: unknown): void {
    this.callbackErrors.note(where, e);
  }

  /** Called by the bot adapters for each human Opus packet, with the voice admission it was received under. */
  readonly onHumanOpus = (bot: BotId, generation: number, userId: string, opus: Buffer, admission?: Admission): void => {
    if (this.lifecycle !== "running") return;
    try {
      this.d2t.onDiscordOpus(bot, generation, userId, opus, this.now(), admission);
    } catch (e) {
      this.noteCallbackError("discord opus", e);
    }
  };

  /** A human's receive stream closed: free their decoder (only the current receiver's streams count). */
  readonly onHumanClosed = (bot: BotId, userId: string): void => {
    if (this.lifecycle === "running" && this.election.receiver === bot) this.d2t.releaseUser(userId);
  };

  async start(): Promise<void> {
    if (this.lifecycle === "stopping" || this.lifecycle === "stopped") throw new Error("runtime is stopped and cannot be restarted");
    if (this.lifecycle === "running") return;
    this.lifecycle = "running";
    for (const c of this.o.ts.directory.inChannel(this.o.ts.channelId)) {
      if (c.clid !== this.o.ts.clientId && !this.isExcluded(c)) this.router.join(c.uniqueId);
    }
    this.ticker = setInterval(() => {
      if (this.lifecycle !== "running") return;
      const t = this.now();
      // One boundary per direction: a failure in one, even on every tick, must not stop the other.
      try {
        this.t2d.tickOverflow(t);
      } catch (e) {
        this.noteCallbackError("tick: TeamSpeak to Discord overflow", e);
      }
      if (this.lifecycle !== "running") return;
      try {
        this.d2t.tick(t);
      } catch (e) {
        this.noteCallbackError("tick: Discord to TeamSpeak mix", e);
      }
    }, 20);
    await this.enqueue(() => this.sync("start"));
  }

  /** Stop for good. Idempotent. Nothing is scheduled afterwards and no bot joins again. */
  async stop(): Promise<void> {
    if (this.lifecycle === "stopped") return;
    if (this.stopping) return this.stopping;
    this.lifecycle = "stopping";
    this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.invalidateNicks();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const off of this.detach) off(); // no more events reach the runtime
    this.detach.length = 0;
    for (const bot of this.o.bots.values()) {
      try {
        bot.stopReceive(); // invalidate reception
        bot.leave(); // also aborts a join that is still in flight
      } catch (e) {
        this.o.log.warn(`${bot.id} did not stop cleanly: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.d2t.flush();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([this.chain, ...this.inflightJoins.values(), ...this.activations, ...this.tracked]),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, this.o.stopTimeoutMs ?? 5_000))),
    ]);
    clearTimeout(timer);
    this.t2d.dispose();
    this.d2t.dispose();
    this.lifecycle = "stopped";
  }

  /** Wait until every queued step, join, activation and nickname change has finished. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.chain, ...this.inflightJoins.values(), ...this.activations, ...this.tracked]);
      await Promise.resolve();
      if (this.queued === 0 && this.inflightJoins.size === 0 && this.activations.size === 0 && this.tracked.size === 0) return;
    }
  }

  /** Fire-and-forget form of `enqueue` for event handlers; failures are already logged by the queue. */
  private schedule(fn: () => Promise<void>): void {
    if (!this.live()) return;
    this.enqueue(fn).catch(() => undefined);
  }

  /** Run `fn` after everything queued before it; errors are logged, never thrown into the caller. Skipped once stopping. */
  enqueue(fn: () => Promise<void>): Promise<void> {
    this.queued += 1;
    this.chain = this.chain
      .then(() => (this.live() ? fn() : undefined))
      .catch((e) => this.o.log.error(`runtime step failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => void (this.queued -= 1));
    return this.chain;
  }

  private track<T>(p: Promise<T>): void {
    const done = p.then(
      () => undefined,
      () => undefined,
    );
    this.tracked.add(done);
    void done.then(() => this.tracked.delete(done));
  }

  /** Query clients and configured MusicBots are not people: they take no slot and never cause overflow. */
  private isExcluded(c: { uniqueId: string; isQuery: boolean }): boolean {
    return c.isQuery || (this.o.excludedUniqueIds?.has(c.uniqueId) ?? false);
  }

  /**
   * Re-apply the exclusion list after it changed: clients that are now excluded give up their place
   * (the longest-waiting human is promoted into a freed slot) and clients no longer excluded take one.
   */
  refreshExclusions(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.live()) return;
      const present = this.o.ts.directory.inChannel(this.o.ts.channelId).filter((c) => c.clid !== this.o.ts.clientId);
      const changes: SlotChange[] = [];
      for (const c of present) changes.push(...(this.isExcluded(c) ? this.router.leave(c.uniqueId) : this.router.join(c.uniqueId)));
      for (const c of changes) {
        this.t2d.forget(c.uniqueId);
        this.emit("slotChange", c);
      }
      await this.sync("exclusions changed");
    });
  }

  private async onDirectory(e: DirectoryEvent): Promise<void> {
    const ownChannel = this.o.ts.channelId;
    const uid = e.client.uniqueId;
    if (e.client.clid === this.o.ts.clientId || this.isExcluded(e.client)) return;
    const present = e.type !== "leave" && e.client.channelId === ownChannel;
    const changes = present ? this.router.join(uid) : this.router.leave(uid);
    for (const c of changes) {
      this.t2d.forget(c.uniqueId);
      this.emit("slotChange", c);
    }
    await this.sync(`ts ${e.type}`);
  }

  /**
   * A bot failed. Election first, synchronously: a receiver failure elects its successor and starts
   * activating it right now. Only then is the reconnect queued, so it cannot delay the replacement.
   */
  private onBotUnhealthy(bot: BotId, reason: string): void {
    if (!this.live()) return;
    this.o.log.warn(`${bot} unhealthy: ${reason}`);
    this.inChannel.delete(bot);
    this.clearNickState(bot);
    // Keep nickChain: dropping it lets a stale Discord REST call race a rejoin's newer name.
    this.nickEpoch.set(bot, (this.nickEpoch.get(bot) ?? 0) + 1);
    this.election.setState(bot, { healthy: false, inChannel: false });
    this.election.fail(bot, reason); // a non-receiver failure leaves the receiver alone
    this.schedule(() => this.sync(`unhealthy ${bot}`));
  }

  /** Who should be in the Discord channel, per the idle-overflow rules. */
  private desiredMembers(): Set<BotId> {
    const want = new Set<BotId>();
    for (let i = 0; i < this.slotCount; i++) if (this.router.botCarriesAudio(slotBotId(i))) want.add(slotBotId(i));
    if (this.router.botCarriesAudio("overflow")) want.add("overflow");
    if (this.router.occupiedSlots() === 0) want.add(slotBotId(0)); // idle receiver keeps its application name
    return want;
  }

  /**
   * Bring the Discord side in line with TeamSpeak. It never waits on a join: joins run in the
   * background and call back into `sync` when they land, so this step is always short.
   */
  private async sync(reason: string): Promise<void> {
    const want = this.desiredMembers();
    const idleSlot0 = this.router.occupiedSlots() === 0;

    // 1. Start the joins that are needed and publish the eligibility of bots already present.
    for (const id of want) {
      const bot = this.o.bots.get(id)!;
      if (!this.inChannel.has(id) || !bot.healthy) this.ensureJoined(id);
      else this.election.setState(id, { healthy: bot.healthy, inChannel: true });
    }
    // 2. Move the receiver off any bot that is about to leave BEFORE it leaves.
    const leaving = [...new Set([...this.inChannel, ...this.inflightJoins.keys(), ...this.retryTimers.keys()])].filter((id) => !want.has(id));
    for (const id of leaving) this.election.setState(id, { inChannel: false });
    this.election.reconcile(reason);
    // 3. Nicknames, then departures.
    for (const id of want) if (this.inChannel.has(id)) this.applyNickname(id, idleSlot0);
    for (const id of leaving) {
      this.o.bots.get(id)?.leave();
      this.inChannel.delete(id);
      this.clearNickState(id);
      this.cancelRetry(id);
      this.queueNick(id, null);
    }
  }

  /** Join `id` in the background. At most one join per bot is in flight. */
  private ensureJoined(id: BotId): void {
    if (!this.live() || this.inflightJoins.has(id) || this.permanentlyRefused.has(id)) return;
    const bot = this.o.bots.get(id)!;
    const attempt = (async () => {
      try {
        await bot.join({ receive: id === "overflow" || id === this.election.receiver });
        if (!this.live() || !this.desiredMembers().has(id)) {
          bot.leave(); // a late completion must still satisfy shutdown AND current membership intent
          return;
        }
        this.inChannel.add(id);
        this.retryAttempts.delete(id);
        this.election.setState(id, { healthy: bot.healthy, inChannel: true });
        this.schedule(() => this.sync(`joined ${id}`));
      } catch (e) {
        if (!this.live()) return;
        if (isJoinCancelled(e)) {
          // Told to leave while joining (not a failure, nothing to retry). Re-evaluate: if the bot is
          // wanted again by now, this attempt was the one in flight and nobody else would start it.
          this.schedule(() => this.sync(`join cancelled ${id}`));
        } else if (isRebuildBudgetExhausted(e)) {
          // The bot's one rebuild budget is spent. max=0 never frees; otherwise wake once, when it does.
          this.o.log.warn(`${id} reconnect refused: ${e.message}`);
          this.election.setState(id, { healthy: false, inChannel: false });
          if (e.max === 0) {
            this.permanentlyRefused.add(id);
            this.clearRetryTimer(id);
            return;
          }
          this.scheduleWake(id, e.retryInMs);
        } else {
          this.o.log.warn(`${id} could not join: ${e instanceof Error ? e.message : String(e)}`);
          this.election.setState(id, { healthy: false, inChannel: false });
          this.scheduleRetry(id);
        }
      } finally {
        this.inflightJoins.delete(id);
      }
    })();
    this.inflightJoins.set(id, attempt);
  }

  private scheduleRetry(id: BotId): void {
    const attempts = (this.retryAttempts.get(id) ?? 0) + 1;
    this.retryAttempts.set(id, attempts);
    if (attempts >= this.retry.maxAttempts) {
      this.o.log.warn(`${id} join failed ${attempts} times; waiting for the next membership change`);
      return;
    }
    this.clearRetryTimer(id);
    const delay = Math.min(this.retry.baseMs * 2 ** (attempts - 1), this.retry.maxMs);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      this.schedule(() => this.sync(`retry ${id}`));
    }, delay);
    timer.unref();
    this.retryTimers.set(id, timer);
  }

  /** One wake-up when the bot's rebuild budget frees. Attempt counting is the bot's business, not ours. */
  private scheduleWake(id: BotId, inMs: number): void {
    this.clearRetryTimer(id);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      this.schedule(() => this.sync(`budget free ${id}`));
    }, Math.min(Math.max(inMs, 1) + 20, 2 ** 31 - 1));
    timer.unref();
    this.retryTimers.set(id, timer);
  }

  private clearRetryTimer(id: BotId): void {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
  }

  /** The bot is no longer wanted: forget its retries entirely. */
  private cancelRetry(id: BotId): void {
    this.clearRetryTimer(id);
    this.retryAttempts.delete(id);
  }

  private applyNickname(id: BotId, idleSlot0: boolean): void {
    let name: string | null;
    if (id === "overflow") name = OVERFLOW_NICKNAME;
    else if (idleSlot0 && id === "slot-0") name = null;
    else {
      const uid = this.router.slotOccupant(Number(id.slice(5)));
      const nick = uid ? this.o.ts.directory.inChannel(this.o.ts.channelId).find((c) => c.uniqueId === uid)?.nickname : undefined;
      name = tsNickname(nick ?? "Unknown");
    }
    this.desiredNick.set(id, name);
    if (this.pendingNick.get(id) === name) return;
    if (this.appliedNick.get(id) === name && !this.pendingNick.has(id)) return;
    if (this.nickDenied.get(id) === name) return;
    const spent = this.nickFailCount.get(id);
    if (spent && spent.value === name && spent.n >= 2) return;
    this.queueNick(id, name);
  }

  /**
   * One Discord nick queue per bot. Epoch is never reset, so leave/rejoin cannot drop an in-flight
   * REST call off the chain. discord.js REST already queues and waits out 429s. Permission denials
   * are not retried for the same desired value; transient failures get two attempts then wait for
   * a new desired name or a leave/unhealthy.
   */
  private queueNick(id: BotId, name: string | null): void {
    const bot = this.o.bots.get(id)!;
    const epoch = (this.nickEpoch.get(id) ?? 0) + 1;
    this.nickEpoch.set(id, epoch);
    this.pendingNick.set(id, name);
    const prev = this.nickChain.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      let attempts = 0;
      for (;;) {
        if (!this.live() || this.nickEpoch.get(id) !== epoch) return;
        const result = await bot.setNickname(name);
        if (!this.live() || this.nickEpoch.get(id) !== epoch) return;
        if (result === "ok") {
          this.appliedNick.set(id, name);
          this.nickFailCount.delete(id);
          this.nickDenied.delete(id);
          if (this.pendingNick.get(id) === name) this.pendingNick.delete(id);
          return;
        }
        if (result === "denied") {
          this.nickDenied.set(id, name);
          if (this.pendingNick.get(id) === name) this.pendingNick.delete(id);
          return;
        }
        attempts += 1;
        if (attempts >= 2) {
          this.nickFailCount.set(id, { value: name, n: 2 });
          if (this.pendingNick.get(id) === name) this.pendingNick.delete(id);
          return;
        }
      }
    });
    this.nickChain.set(id, next.then(() => undefined, () => undefined));
    this.track(next);
  }

  private clearNickState(id: BotId): void {
    this.appliedNick.delete(id);
    this.desiredNick.delete(id);
    this.pendingNick.delete(id);
    this.nickDenied.delete(id);
    this.nickFailCount.delete(id);
  }

  private invalidateNicks(): void {
    for (const id of this.o.bots.keys()) {
      this.nickEpoch.set(id, (this.nickEpoch.get(id) ?? 0) + 1);
      this.pendingNick.delete(id);
      this.desiredNick.delete(id);
    }
  }

  private activate(bot: BotId, generation: number): void {
    const run = this.startReceiving(bot, generation)
      .catch((e) => this.o.log.warn(`${bot} activation failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.activations.delete(run));
    this.activations.add(run);
  }

  private async startReceiving(bot: BotId, generation: number): Promise<void> {
    const port = this.o.bots.get(bot);
    if (!port || this.election.receiver !== bot || this.election.generation !== generation) return;
    try {
      if (port.deaf) await port.join({ receive: true }); // senders join deaf; a receiver must be undeafened
      if (!this.live() || this.election.receiver !== bot || this.election.generation !== generation) return; // superseded while joining
      if (!port.startReceive(generation)) this.o.log.warn(`${bot} refused to start receiving`);
    } catch (e) {
      if (!this.live()) return;
      this.o.log.warn(`${bot} could not become receiver: ${e instanceof Error ? e.message : String(e)}`);
      this.election.fail(bot, "receive start failed");
    }
  }

  status() {
    return {
      state: this.lifecycle,
      callbackErrors: this.callbackErrors.total,
      /** Failures of the 20 ms ticker, per direction (also counted in `callbackErrors`). */
      tickErrors: { tsToDiscord: this.callbackErrors.count("tick: TeamSpeak to Discord overflow"), discordToTs: this.callbackErrors.count("tick: Discord to TeamSpeak mix") },
      /** Reconnects waiting on a timer (a backoff retry or a budget wake-up); at most one per bot. */
      scheduledReconnects: this.retryTimers.size,
      receiver: this.election.receiver,
      generation: this.election.generation,
      inChannel: [...this.inChannel].sort((a, b) => a.localeCompare(b)),
      slots: Array.from({ length: this.slotCount }, (_, i) => this.router.slotOccupant(i) !== null),
      overflowMembers: this.router.overflowMembers().length,
      election: this.election.status(),
      duplicateReceivers: this.election.duplicateReceivers(),
      d2t: {
        incoming: this.d2t.incoming,
        framesSent: this.d2t.framesSent,
        voiceStops: this.d2t.voiceStops,
        encodeErrors: this.d2t.encodeErrors,
        arrivalGaps: this.d2t.arrivalGaps,
        mixerOverflow: this.d2t.mixerOverflow,
        paddedTails: this.d2t.paddedTails,
        selfSourceDrops: this.d2t.selfSourceDrops,
        fenceDroppedAtMix: this.d2t.fenceDroppedAtMix,
        daveDropped: this.d2t.daveDropped,
        admissionDropped: this.d2t.admissionDropped,
        decodeErrors: this.d2t.decodeErrors,
        decoders: this.d2t.decoderCount,
        transitLatencyMs: this.d2t.transitLatency.summary(),
      },
      t2dOverflowLatencyMs: this.t2d.overflowLatency.summary(),
      t2d: {
        received: this.t2d.received,
        forwarded: this.t2d.forwarded,
        voiceStops: this.t2d.voiceStops,
        invalidFrames: this.t2d.invalidFrames,
        decoderFailures: this.t2d.decoderFailures,
        encodeErrors: this.t2d.encodeErrors,
        arrivalGaps: this.t2d.arrivalGaps,
        mixerOverflow: this.t2d.mixerOverflow,
        paddedTails: this.t2d.paddedTails,
        decodeErrors: this.t2d.decodeErrors,
        unsupportedFrames: this.t2d.unsupportedFrames,
        malformed: this.t2d.malformed,
        unknownSpeakers: this.t2d.unknownSpeakers,
        ownVoice: this.t2d.ownVoice,
        excluded: this.t2d.excluded,
        notInChannel: this.t2d.notInChannel,
        decoders: this.t2d.decoderCount,
        routedIdentities: this.t2d.routedIdentities,
      },
    };
  }
}
