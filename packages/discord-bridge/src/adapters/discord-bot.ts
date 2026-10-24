import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { daveEnforced, readDaveInfo } from "../core/dave-gate.js";
import { FrameFeed } from "../core/frame-feed.js";
import type { BotId } from "../core/ids.js";
import { JoinCancelled } from "../core/join-errors.js";
import { RebuildBudget } from "../core/rebuild-budget.js";
import { registerSecret, safeError, type Logger } from "../core/redact.js";
import { ReceiveSupervisor } from "../core/receive-supervisor.js";
import type { ReceiverElection } from "../core/receiver-election.js";
import type { BotPort } from "../bridge/runtime.js";

/** Where a bot joins and which gateway adapter carries its voice signalling. */
export interface VoiceTarget {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
}

export interface BotTiming {
  /** How long a join waits for the voice connection to become Ready. */
  readyMs: number;
  /** How long a Ready connection may take to establish DAVE before the bot leaves (fail closed). */
  daveWaitMs: number;
  /** Poll interval while waiting for DAVE. */
  pollMs: number;
  /** How often a joined bot re-reads the live DAVE state (the library has no event for it). */
  watchdogMs: number;
  /** How long DAVE may stay unavailable (an MLS transition) before the bot is declared unhealthy. */
  daveGraceMs: number;
  /**
   * The one budget for failure-driven reconnects: this many connection rebuild attempts per window,
   * whichever path asks (gateway destruction, a poisoned DAVE session, DAVE lost for good, a failed
   * join, a refused rejoin, the runtime's own retries). Planned joins are free. It recovers by time
   * only. When it is spent, `join()` rejects with `RebuildBudgetExhausted` and builds nothing.
   */
  maxRecoveries: number;
  recoveryWindowMs: number;
  /** Clock for the budget (tests inject one). */
  now?: () => number;
}

export interface DiscordBotOptions {
  id: BotId;
  token: string;
  guildId: string;
  channelId: string;
  election: ReceiverElection;
  log: Logger;
  /** Called for each decoded-ready Opus packet from a human while this bot is the admitted receiver. */
  onHumanOpus: (bot: BotId, generation: number, userId: string, opus: Buffer) => void;
  /** Ids of the bridge's own bots, never subscribed to. */
  bridgeUserIds: () => ReadonlySet<string>;
  /** Resolve the join target. Defaults to this bot's own discord.js guild and its voice adapter. */
  voiceTarget?: () => Promise<VoiceTarget>;
  /** A human's receive stream closed: release anything held for that user (decoders). */
  onHumanClosed?: (bot: BotId, userId: string) => void;
  timing?: Partial<BotTiming>;
  /**
   * Scopes this bot's `@discordjs/voice` connection group. All bots of one bridge session share a
   * value; it defaults to one id per process. Two sessions in one process must use different ids.
   */
  sessionId?: string;
}

/** Fallback so two bridges started in one process never share a connection group by accident. */
const PROCESS_SESSION_ID = randomUUID();

interface ParsingReceiver {
  parsePacket(buffer: Buffer, mode: string, nonce: Buffer, secretKey: Uint8Array, userId: string): Buffer | null;
}

const REQUIRED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
const DEFAULT_TIMING: BotTiming = { readyMs: 20_000, daveWaitMs: 10_000, pollMs: 200, watchdogMs: 100, daveGraceMs: 5_000, maxRecoveries: 3, recoveryWindowMs: 60_000 };
/** A feed with no frame for this long ends the current speech turn. */
const TURN_GAP_MS = 120;

/**
 * One official Discord bot identity. Sends Opus passthrough for its assigned TeamSpeak speaker and,
 * when it is the elected receiver, subscribes to humans. Fails closed unless DAVE is negotiated.
 *
 * D1 lab code: the send/receive wiring below is verified live only when the operator provides bot
 * tokens (see README). Unit tests cover the pure pieces it is built from.
 */
export class DiscordBot extends EventEmitter implements BotPort {
  readonly client: Client;
  private connection: VoiceConnection | null = null;
  private readonly player: AudioPlayer;
  private feed: FrameFeed | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private supervisor: ReceiveSupervisor | null = null;
  private receiveOnSpeaking: ((userId: string) => void) | null = null;
  private selfDeaf = true;
  private readonly timing: BotTiming;
  /** Last observed DAVE state of the live connection (true only after an established session). */
  private daveOk = false;
  private watchdog: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  /** Set by `destroy()`: a stopped bot never joins again. */
  private stopped = false;
  /** Joins run one at a time per bot; `abortJoin` cuts a pending one short when the connection is discarded. */
  private joinLock: Promise<void> = Promise.resolve();
  private abortJoin: AbortController | null = null;
  /**
   * The intent a join was submitted under. `leave()` and `destroy()` end it, so every join submitted
   * before them is cancelled at its next checkpoint, including one still waiting for the target.
   */
  private epoch = 0;
  /** The last connection failed and has not been replaced by a Ready one yet: the next join is a rebuild. */
  private failed = false;
  /** The DAVE session that was poisoned. The replacement must be a different object. */
  private poisonedDave: object | null = null;
  /** The DAVE session the packet waiting for dispatch was encrypted under. */
  private preparedFor: object | null = null;
  private readonly budget: RebuildBudget;
  /**
   * `@discordjs/voice` keys connections by (group, guildId) and the default group is shared, so two
   * bots in one guild would be handed the same connection. Every bot gets its own group, scoped by
   * bridge session and bot identity, and it stays the same across rejoins.
   */
  readonly voiceGroup: string;
  userId = "";
  healthy = false;
  framesSent = 0;
  rejoins = 0;

  constructor(private readonly o: DiscordBotOptions) {
    super();
    registerSecret(o.token);
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.budget = new RebuildBudget(this.timing.maxRecoveries, this.timing.recoveryWindowMs, this.timing.now);
    this.voiceGroup = `ts6-bridge:${o.sessionId ?? PROCESS_SESSION_ID}:${o.id}`;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 5 } });
    this.player.on("error", (e) => this.o.log.warn(`${this.o.id} player error: ${safeError(e)}`));
  }

  async login(): Promise<void> {
    await this.client.login(this.o.token);
    await new Promise<void>((resolve) => (this.client.isReady() ? resolve() : this.client.once("clientReady", () => resolve())));
    this.userId = this.client.user!.id;
  }

  /** Verify guild membership and channel permissions without joining voice. */
  async verify(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const guild = await this.client.guilds.fetch(this.o.guildId);
      const channel = await guild.channels.fetch(this.o.channelId);
      if (!channel?.isVoiceBased()) return { ok: false, reason: "not a voice channel" };
      const me = await guild.members.fetchMe();
      const perms = channel.permissionsFor(me);
      const missing = REQUIRED.filter((p) => !perms?.has(p));
      return missing.length ? { ok: false, reason: `missing ${missing.length} channel permission(s)` } : { ok: true };
    } catch (e) {
      return { ok: false, reason: safeError(e) };
    }
  }

  get id(): BotId {
    return this.o.id;
  }

  get deaf(): boolean {
    return this.selfDeaf;
  }

  /** `null` resets to the application name. */
  async setNickname(nick: string | null): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.o.guildId);
      await guild.members.me?.setNickname(nick === null ? null : nick.slice(0, 32));
    } catch (e) {
      // Contract: a nickname failure warns and keeps the old nick; it never stops the bridge.
      this.o.log.warn(`${this.o.id} nickname not changed: ${safeError(e)}`);
    }
  }

  private async resolveTarget(): Promise<VoiceTarget> {
    if (this.o.voiceTarget) return this.o.voiceTarget();
    const guild = await this.client.guilds.fetch(this.o.guildId);
    const channel = await guild.channels.fetch(this.o.channelId);
    if (!channel?.isVoiceBased()) throw new Error("not a voice channel");
    return { guildId: guild.id, channelId: channel.id, adapterCreator: guild.voiceAdapterCreator };
  }

  /**
   * Join the approved voice channel. A receiver must be undeafened; senders deafen themselves.
   *
   * Cancellable by `leave()`/`destroy()` at every asynchronous boundary. A join that follows a
   * failure is a rebuild and spends the one budget before it does anything else, so no caller can
   * reconnect faster than the budget allows.
   */
  join(opts: { receive: boolean }): Promise<void> {
    if (this.stopped) return Promise.reject(new JoinCancelled("bot is stopped; it never joins again"));
    const epoch = this.epoch; // captured now, not when the join gets its turn
    const run = this.joinLock.then(() => this.joinNow(opts, epoch));
    this.joinLock = run.catch(() => undefined);
    return run;
  }

  /**
   * Throws when this join must stop: its intent ended (cancelled, never a failure), or the
   * connection it is working on is no longer the live one (a failure). A connection that a
   * cancelled join created is destroyed here, so a late join never leaves resources behind.
   */
  private checkpoint(epoch: number, conn?: VoiceConnection): void {
    if (this.stopped || this.epoch !== epoch) {
      if (conn) this.destroyQuietly(conn);
      throw new JoinCancelled();
    }
    if (conn && conn !== this.connection) throw new Error("join aborted: the connection was discarded");
  }

  private destroyQuietly(conn: VoiceConnection): void {
    try {
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    } catch {
      /* already destroyed */
    }
  }

  /** A connection broke without us asking: the next join must build it again, and that costs a token. */
  private noteUnplannedRebuild(): void {
    if (this.failed) return; // this attempt already paid
    this.failed = true;
    this.spendRebuild();
  }

  private spendRebuild(): void {
    this.budget.spend();
    this.rejoins += 1;
  }

  private async joinNow(opts: { receive: boolean }, epoch: number): Promise<void> {
    this.checkpoint(epoch);
    if (this.failed) this.spendRebuild();
    const target = await this.resolveTarget();
    this.checkpoint(epoch);
    this.selfDeaf = !opts.receive;
    let conn = this.connection;
    if (conn && conn.state.status === VoiceConnectionStatus.Destroyed) {
      // The library cannot revive a destroyed connection, and `rejoin()` on one only returns false.
      this.discardConnection();
      conn = null;
      this.noteUnplannedRebuild();
    }
    if (conn && !conn.rejoin({ channelId: target.channelId, selfDeaf: this.selfDeaf, selfMute: false })) {
      this.o.log.warn(`${this.o.id} the library refused a rejoin; building a new connection`);
      this.discardConnection();
      conn = null;
      this.noteUnplannedRebuild();
    }
    if (!conn) {
      const squatter = getVoiceConnection(target.guildId, this.voiceGroup);
      if (squatter && squatter.state.status !== VoiceConnectionStatus.Destroyed) {
        throw new Error(`voice group ${this.voiceGroup} is already in use by another bot instance; refusing to share a connection`);
      }
      const created = joinVoiceChannel({
        channelId: target.channelId,
        guildId: target.guildId,
        group: this.voiceGroup,
        adapterCreator: target.adapterCreator,
        selfDeaf: this.selfDeaf,
        selfMute: false,
        daveEncryption: true,
        decryptionFailureTolerance: 36,
      });
      conn = created;
      this.connection = created;
      this.installDaveGuards(created);
      created.subscribe(this.player);
      created.on("stateChange", (_o, n) => {
        // Only an unexpected change on the live connection is a failure; our own teardown detaches first.
        if (created !== this.connection) return;
        if (n.status === VoiceConnectionStatus.Disconnected) this.markUnhealthy(`voice ${n.status}`);
        // Destroyed cannot be revived: drop it so the next join builds a new connection and DAVE session.
        else if (n.status === VoiceConnectionStatus.Destroyed) this.markUnhealthy(`voice ${n.status}`, { fresh: true });
      });
      created.on("error", (e) => this.o.log.warn(`${this.o.id} voice error: ${safeError(e)}`));
    }
    const abort = new AbortController();
    this.abortJoin = abort;
    const timer = setTimeout(() => abort.abort(), this.timing.readyMs);
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, abort.signal);
    } catch (e) {
      this.checkpoint(epoch, conn); // cancelled on purpose, or the connection was discarded under us
      this.failed = true;
      this.discardConnection(); // never retry on a connection that did not come up
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.abortJoin === abort) this.abortJoin = null;
    }
    this.checkpoint(epoch, conn);
    await this.requireDave(conn, epoch);
    this.checkpoint(epoch, conn);
    if (this.poisonedDave && this.currentDave(conn) === this.poisonedDave) {
      this.failed = true;
      this.discardConnection();
      throw new Error("recovery did not produce a fresh DAVE session");
    }
    // No await below: nothing can cancel the join between the last checkpoint and these assignments.
    this.poisonedDave = null;
    this.failed = false;
    this.daveOk = true;
    this.healthy = true;
    this.clearGraceTimer();
    this.watchdog ??= setInterval(() => this.observeDave(), this.timing.watchdogMs);
    this.watchdog.unref();
    this.o.election.setState(this.o.id, { healthy: true });
    this.o.election.daveRestored(this.o.id); // no-op unless a previous session had lost DAVE
    this.emit("healthy");
  }

  private currentDave(conn: VoiceConnection): object | null {
    const state = conn.state;
    return state.status === VoiceConnectionStatus.Ready ? ((state.networking.state as { dave?: object }).dave ?? null) : null;
  }

  private enforced(conn: VoiceConnection | null = this.connection): boolean {
    return conn !== null && daveEnforced(readDaveInfo(conn));
  }

  /**
   * The library passes media through unencrypted at protocol 0, while the MLS group is not ready,
   * and (inside davey's transition window) at protocol 1. The bridge requires an established DAVE
   * session at every boundary, so these guards sit on the two places audio crosses the connection:
   * the packet about to be encrypted for sending and the packet just received for decryption.
   */
  private installDaveGuards(conn: VoiceConnection): void {
    const prepare = conn.prepareAudioPacket.bind(conn);
    conn.prepareAudioPacket = (buffer) => {
      if (!this.sendAllowed(conn)) return undefined;
      const packet = prepare(buffer);
      this.preparedFor = this.currentDave(conn);
      return packet;
    };
    // The player prepares on one tick and dispatches on the next. DAVE can be lost in between, so
    // the prepared packet is re-checked against the live session when it is about to leave.
    const dispatch = conn.dispatchAudio.bind(conn);
    conn.dispatchAudio = () => {
      const preparedFor = this.preparedFor;
      this.preparedFor = null;
      if (!this.sendAllowed(conn) || preparedFor === null || preparedFor !== this.currentDave(conn)) return false;
      return dispatch();
    };
    const play = conn.playOpusPacket.bind(conn);
    conn.playOpusPacket = (buffer) => (this.sendAllowed(conn) ? play(buffer) : undefined);
    // `parsePacket` is private in the typings but is the single place a received packet is decrypted.
    const receiver = conn.receiver as unknown as ParsingReceiver;
    const parse = receiver.parsePacket.bind(receiver);
    receiver.parsePacket = (buffer, mode, nonce, secretKey, userId) => {
      if (conn !== this.connection || !this.enforced(conn)) {
        queueMicrotask(() => this.observeDave());
        return null; // dropped: VoiceReceiver does not push a null packet
      }
      this.refusePlaintext(conn, userId);
      return parse(buffer, mode, nonce, secretKey, userId);
    };
  }

  private sendAllowed(conn: VoiceConnection): boolean {
    if (conn === this.connection && this.enforced(conn)) return true;
    queueMicrotask(() => this.observeDave()); // never stop the player from inside its own tick
    return false;
  }

  /** An established session must not accept unencrypted media, even in davey's transition window. */
  private refusePlaintext(conn: VoiceConnection, userId: string): void {
    const state = conn.state;
    if (state.status !== VoiceConnectionStatus.Ready) return;
    const session = (state.networking.state as { dave?: { session?: { canPassthrough?(u: string): boolean; setPassthroughMode?(on: boolean, expiry?: number): void } } }).dave?.session;
    if (session?.canPassthrough?.(userId)) session.setPassthroughMode?.(false, 0);
  }

  /** Read the live DAVE state and act on a change. Returns whether DAVE is established now. */
  private observeDave(): boolean {
    if (!this.connection) return false;
    const ok = this.enforced();
    if (ok === this.daveOk) return ok;
    this.daveOk = ok;
    if (!this.healthy) return ok; // a join in progress is governed by requireDave
    if (ok) this.handleDaveRestored();
    else this.handleDaveLost();
    return ok;
  }

  private handleDaveLost(): void {
    this.o.log.warn(`${this.o.id} DAVE unavailable: stopping send and receive until it is established again`);
    this.dropOutbound();
    this.stopReceive();
    this.o.election.daveLost(this.o.id, "dave unavailable");
    this.clearGraceTimer();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.daveOk) this.markUnhealthy("DAVE unavailable after the grace window", { fresh: true });
    }, this.timing.daveGraceMs);
    this.graceTimer.unref();
  }

  private handleDaveRestored(): void {
    this.clearGraceTimer();
    this.o.log.info(`${this.o.id} DAVE established again`);
    this.o.election.daveRestored(this.o.id);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** Discard everything buffered for playback now (not drained, unlike `endSpeech`). */
  private dropOutbound(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.feed?.destroy();
    this.feed = null;
    this.player.stop(true);
  }

  /** Enforce DAVE: wait for an established session, otherwise drop the connection and fail closed. */
  private async requireDave(conn: VoiceConnection, epoch: number): Promise<void> {
    const deadline = Date.now() + this.timing.daveWaitMs;
    while (Date.now() < deadline) {
      this.checkpoint(epoch, conn);
      if (daveEnforced(readDaveInfo(conn))) return;
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    const info = readDaveInfo(conn);
    this.failed = true;
    this.discardConnection();
    throw new Error(`DAVE not negotiated (protocolVersion=${info?.protocolVersion ?? "n/a"}, ready=${info?.ready ?? false}); failing closed`);
  }

  /** The TeamSpeak speaker assigned to this bot: Opus passthrough, one turn per stretch of speech. */
  sendOpus(frame: Buffer): void {
    if (!this.healthy || !this.observeDave()) return;
    if (!this.feed || this.feed.destroyed) {
      this.feed = new FrameFeed();
      this.player.play(createAudioResource(this.feed, { inputType: StreamType.Opus }));
    }
    this.feed.offer(frame);
    this.framesSent += 1;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.endSpeech(), TURN_GAP_MS);
  }

  endSpeech(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.feed?.finish();
    this.feed = null;
  }

  /** Start human subscriptions under `generation`. Only the admitted receiver may call this. */
  startReceive(generation: number): boolean {
    const conn = this.connection;
    if (!conn || this.selfDeaf || !this.o.election.admitSubscribe(this.o.id, generation)) return false;
    this.stopReceive();
    const receiver = conn.receiver;
    // Never subscribe to a bridge bot (including this one): that would re-forward bridge audio.
    const isHuman = (userId: string) => !this.o.bridgeUserIds().has(userId) && userId !== this.userId;
    const sup: ReceiveSupervisor = new ReceiveSupervisor({
      bot: this.o.id,
      generation,
      election: this.o.election,
      subscribe: (userId) => receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 200 } }),
      activeSpeakers: () => [...receiver.speaking.users.keys()].filter(isHuman),
      onFrame: (userId, opus, gen) => {
        if (this.supervisor !== sup || !this.observeDave()) return; // stale reception or DAVE unavailable
        this.o.onHumanOpus(this.o.id, gen, userId, opus);
      },
      onUserClosed: (userId) => this.o.onHumanClosed?.(this.o.id, userId),
      onNeedRecovery: (reason) => {
        if (this.supervisor === sup) this.requestRecovery(reason);
      },
      log: (m) => this.o.log.warn(`${this.o.id} ${m}`),
    });
    this.supervisor = sup;
    this.receiveOnSpeaking = (userId) => {
      if (isHuman(userId)) sup.open(userId);
    };
    receiver.speaking.on("start", this.receiveOnSpeaking);
    sup.start(); // opens everyone already speaking: a start event is never the only trigger
    return true;
  }

  /** Drop every human subscription immediately (teardown before a new election). */
  stopReceive(from: VoiceConnection | null = this.connection): void {
    if (this.receiveOnSpeaking && from) from.receiver.speaking.off("start", this.receiveOnSpeaking);
    this.receiveOnSpeaking = null;
    this.supervisor?.closeAll();
    this.supervisor = null;
  }

  get openSubscriptions(): number {
    return this.supervisor?.openCount ?? 0;
  }

  get decryptErrors(): number {
    return this.supervisor?.decryptErrors ?? 0;
  }

  /**
   * Reception failed closed after repeated decrypt failures: the DAVE session is poisoned. Fence
   * everything received so far, drop the connection and report at once. The runtime elects a
   * successor in the same turn and is the only thing that rebuilds this bot, through `join()` and
   * its budget; nothing here waits for a replacement connection.
   */
  private requestRecovery(reason: string): void {
    this.stopReceive();
    this.emit("recoveryRequested", reason);
    this.o.election.daveLost(this.o.id, `recovery: ${reason}`);
    this.o.log.warn(`${this.o.id} DAVE session poisoned (${reason}); the connection will be rebuilt by the next join`);
    this.markUnhealthy(`DAVE session poisoned: ${reason}`, { fresh: true, force: true });
  }

  /** `force` reports even when the bot already has no connection. */
  markUnhealthy(reason: string, opts: { fresh?: boolean; force?: boolean } = {}): void {
    if (this.stopped) return;
    if (!opts.force && !this.healthy && !this.connection) return;
    this.healthy = false;
    this.failed = true;
    this.stopReceive();
    this.o.log.warn(`${this.o.id} unhealthy: ${reason}`);
    // After a DAVE failure the next join must build a new session, not reuse the poisoned one.
    if (opts.fresh) {
      if (this.connection) this.poisonedDave = this.currentDave(this.connection) ?? this.poisonedDave;
      this.discardConnection();
    }
    this.emit("unhealthy", reason);
  }

  /** Hard-kill the voice connection (used by the receiver-kill scenario). */
  kill(reason: string): void {
    this.leave();
    this.failed = true;
    this.emit("unhealthy", reason);
  }

  /**
   * Tear the live connection down on purpose. The connection is detached before it is destroyed, so
   * the resulting state change is not mistaken for a failure and never triggers a fresh join.
   */
  private discardConnection(): void {
    const conn = this.connection;
    this.connection = null;
    this.daveOk = false;
    this.preparedFor = null;
    this.abortJoin?.abort();
    this.stopReceive(conn);
    this.dropOutbound();
    if (!conn) return;
    try {
      if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    } catch {
      /* already destroyed */
    }
  }

  /**
   * Leave the channel on purpose. The bot can join again later. Every join submitted before this
   * call is cancelled, including one that is still resolving its target. `failed` is kept: a bot
   * that failed still pays for its next rebuild even if it was told to leave in between.
   */
  leave(): void {
    this.epoch += 1;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearGraceTimer();
    this.healthy = false;
    this.discardConnection();
  }

  /** Stop for good: leave, refuse every later join, and release the Discord client. */
  async destroy(): Promise<void> {
    this.stopped = true;
    this.leave();
    await this.client.destroy();
  }

  get playerStatus(): AudioPlayerStatus {
    return this.player.state.status;
  }

  /** The live voice connection, for diagnostics and tests. */
  get voiceConnection(): VoiceConnection | null {
    return this.connection;
  }

  get daveInfo() {
    return this.connection ? readDaveInfo(this.connection) : null;
  }
}
