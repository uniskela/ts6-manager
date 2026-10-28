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
import { emptyDaveSnapshot, formatDaveSnapshot, observeDave, observeDaveWs, type DaveSnapshot } from "../core/dave-observe.js";
import { DaveSessionEpochs, daveSessionIdentity } from "../core/dave-session.js";
import { FrameFeed } from "../core/frame-feed.js";
import type { BotId } from "../core/ids.js";
import { HumanFilter, type DiscordUserInfo, type HumanFilterOptions } from "../core/human-filter.js";
import { processIdentityRequests, type IdentityRequests } from "../core/identity-requests.js";
import { JoinCancelled } from "../core/join-errors.js";
import { RebuildBudget } from "../core/rebuild-budget.js";
import { registerSecret, safeError, type Logger } from "../core/redact.js";
import { ReceiveSupervisor } from "../core/receive-supervisor.js";
import type { ReceiverElection } from "../core/receiver-election.js";
import { VoiceAdmission, type Admission } from "../core/voice-admission.js";
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
   * join, a refused rejoin, a connection that cannot be constructed, the runtime's own retries).
   * Planned joins are free. It recovers by time only. When it is spent, `join()` rejects with
   * `RebuildBudgetExhausted` and builds nothing.
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
  /**
   * Called for each Opus packet from an admitted human while this bot is the admitted receiver. The
   * admission must travel with the packet: the pipeline re-checks it (`humanAdmitted`) when the frame
   * is queued and again immediately before it is mixed into TeamSpeak.
   */
  onHumanOpus: (bot: BotId, generation: number, userId: string, opus: Buffer, admission: Admission) => void;
  /** Ids of the bridge's own bots, never subscribed to. */
  bridgeUserIds: () => ReadonlySet<string>;
  /** Resolve the join target. Defaults to this bot's own discord.js guild and its voice adapter. */
  voiceTarget?: () => Promise<VoiceTarget>;
  /**
   * Ask Discord whether a user is a bot (default: the REST user lookup). Resolve `null` or reject when
   * it cannot be established; the user then stays excluded. Tests inject this; production does not.
   */
  userLookup?: (userId: string) => Promise<DiscordUserInfo | null>;
  /** Timing of the identity lookups (`HumanFilter` defaults: 6 s timeout, 5 s to 60 s cooldown). */
  identityLookup?: Pick<HumanFilterOptions, "lookupTimeoutMs" | "retryMs" | "maxRetryMs">;
  /**
   * Where identity requests are counted and capped. Default: the one registry of the process (8
   * unsettled, one per user), shared by every bot so that replacing a bot cannot add requests on top
   * of those its predecessors left out. Tests inject their own.
   */
  identityRequests?: IdentityRequests;
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
  /**
   * A connection failed since the last join that reached Ready: the next attempt that rejoins or
   * builds a connection owes one recovery token. This is only the debt. Whether a given attempt has
   * paid is that attempt's own business (`joinNow`), never inferred from this flag, which a
   * connection event can change at any moment, including from inside `rejoin()`.
   */
  private rebuildOwed = false;
  /** Counts every failure, so an attempt can tell that one happened while it was waiting. */
  private failures = 0;
  /** The DAVE session that was poisoned. The replacement must be a different object. */
  private poisonedDave: object | null = null;
  /** The DAVE session the packet waiting for dispatch was encrypted under. */
  private preparedFor: object | null = null;
  private readonly budget: RebuildBudget;
  private readonly humans: HumanFilter;
  /** Who may be heard under the current receive generation; null while not receiving. */
  private admission: VoiceAdmission | null = null;
  /** Numbers the DAVE sessions this bot has seen on its connections; an epoch never comes back. */
  private readonly daveEpochs = new DaveSessionEpochs();
  /** The DAVE session epoch the current receive generation is bound to; null while not receiving. */
  private receiveSession: number | null = null;
  /** The voiceStateUpdate listener on the client, removed by `destroy()` so the client does not keep this bot. */
  private readonly onVoiceState: (before: { channelId: string | null }, after: { id: string; channelId: string | null }) => void;
  /**
   * `@discordjs/voice` keys connections by (group, guildId) and the default group is shared, so two
   * bots in one guild would be handed the same connection. Every bot gets its own group, scoped by
   * bridge session and bot identity, and it stays the same across rejoins.
   */
  readonly voiceGroup: string;
  userId = "";
  healthy = false;
  framesSent = 0;
  private feedDropped = 0;
  private feedStarved = 0;
  rejoins = 0;
  /** Privacy-safe MLS negotiation trace for the live wrapper (null when none). */
  private daveTrace: DaveSnapshot | null = null;
  /** Last DAVE lifecycle log identity (phase + protocol/status/membership/trace, not elapsedMs). */
  private lastDaveLifecycleKey: string | null = null;
  /** When the live voice connection last became Ready; used only for elapsedMs diagnostics. */
  private connectedAt: number | null = null;
  /** Established DAVE sessions replaced by another while receiving (each one ended a receive generation). */
  daveReplacements = 0;

  constructor(private readonly o: DiscordBotOptions) {
    super();
    registerSecret(o.token);
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.budget = new RebuildBudget(this.timing.maxRecoveries, this.timing.recoveryWindowMs, this.timing.now);
    this.voiceGroup = `ts6-bridge:${o.sessionId ?? PROCESS_SESSION_ID}:${o.id}`;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.humans = new HumanFilter({
      cached: (id) => {
        const u = this.client.users.cache.get(id);
        return u && typeof u.bot === "boolean" ? { bot: u.bot } : undefined; // a partial user is not an answer
      },
      // Not a method of this bot: a request that never settles holds this function, and must not hold the bot.
      lookup: o.userLookup ?? userLookupVia(this.client),
      excluded: (id) => this.excluded(id),
      requests: o.identityRequests ?? processIdentityRequests,
      ...o.identityLookup,
    });
    // Leaving the source channel (disconnecting or moving) ends the user's admission at once. discord.js
    // updates the guild's voice-state cache before it emits this, so every later check agrees.
    this.onVoiceState = (before, after) => {
      if (before.channelId === this.o.channelId && after.channelId !== this.o.channelId) this.admission?.revoke(after.id);
    };
    this.client.on("voiceStateUpdate", this.onVoiceState);
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 5 } });
    this.player.on("error", (e) => this.o.log.warn(`${this.o.id} player error: ${safeError(e)}`));
  }

  async login(): Promise<void> {
    await this.client.login(this.o.token);
    await new Promise<void>((resolve) => (this.client.isReady() ? resolve() : this.client.once("clientReady", () => resolve())));
    this.userId = this.client.user!.id;
  }

  private excluded(userId: string): boolean {
    return this.o.bridgeUserIds().has(userId) || userId === this.userId;
  }

  /** The voice channel the gateway says a user is in now (the guild's voice-state cache), or null. */
  private channelOf(userId: string): string | null {
    return this.client.guilds.cache.get(this.o.guildId)?.voiceStates.cache.get(userId)?.channelId ?? null;
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
   * Cancellable by `leave()`/`destroy()` at every asynchronous boundary. A join that rejoins or
   * builds a connection while a failure is owed spends one token of the one budget first, and what is
   * owed is read after the target is resolved, not when the join was submitted, so no caller can
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

  /** A connection broke without us asking: until a join reaches Ready, the next attempt owes a recovery token. */
  private noteFailure(): void {
    this.rebuildOwed = true;
    this.failures += 1;
  }

  private async joinNow(opts: { receive: boolean }, epoch: number): Promise<void> {
    this.checkpoint(epoch);
    // Refuse early, before a lookup that would be wasted. This is only a shortcut: the charge below is what counts.
    if (this.rebuildOwed) this.budget.assertAvailable();
    const target = await this.resolveTarget();
    this.checkpoint(epoch);
    // Nothing read before the await above is trusted from here on: the connection may have been
    // destroyed or dropped while the target was being resolved. This attempt pays at most one token,
    // at the first moment it rejoins or builds a connection while a failure is owed, and the debt it
    // pays is read now, not when the attempt started.
    let paid = false;
    const charge = (): void => {
      if (paid || !this.rebuildOwed) return;
      this.budget.spend(); // throws RebuildBudgetExhausted before anything is rejoined or created
      this.rejoins += 1;
      paid = true;
    };
    this.selfDeaf = !opts.receive;
    let conn = this.connection;
    if (conn && conn.state.status === VoiceConnectionStatus.Destroyed) {
      // The library cannot revive a destroyed connection, and `rejoin()` on one only returns false.
      this.discardConnection();
      conn = null;
      this.noteFailure();
    }
    if (conn) {
      charge();
      // The library can report Disconnected from inside `rejoin()` and then return false; both signal
      // the same failure, and the one `charge` above or below covers them.
      if (!conn.rejoin({ channelId: target.channelId, selfDeaf: this.selfDeaf, selfMute: false })) {
        this.o.log.warn(`${this.o.id} the library refused a rejoin; building a new connection`);
        this.discardConnection();
        conn = null;
        this.noteFailure();
      }
    }
    if (!conn) {
      charge();
      conn = this.buildConnection(target);
    }
    const settled = this.failures; // a failure after this point happened while the join was completing
    const abort = new AbortController();
    this.abortJoin = abort;
    const timer = setTimeout(() => abort.abort(), this.timing.readyMs);
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, abort.signal);
    } catch (e) {
      this.checkpoint(epoch, conn); // cancelled on purpose, or the connection was discarded under us
      this.noteFailure();
      this.discardConnection(); // never retry on a connection that did not come up
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.abortJoin === abort) this.abortJoin = null;
    }
    this.checkpoint(epoch, conn);
    this.connectedAt = Date.now();
    await this.requireDave(conn, epoch);
    this.checkpoint(epoch, conn);
    if (this.failures !== settled) {
      // The connection failed after it was built, while this join was waiting (a drop the library may
      // have repaired by itself). The failure was already reported; do not report health over it.
      this.discardConnection();
      throw new Error("the connection failed while the join was completing");
    }
    if (this.poisonedDave && this.currentDave(conn) === this.poisonedDave) {
      this.noteFailure();
      this.discardConnection();
      throw new Error("recovery did not produce a fresh DAVE session");
    }
    // No await below: nothing can cancel the join between the last checkpoint and these assignments.
    this.poisonedDave = null;
    this.rebuildOwed = false;
    this.daveOk = true;
    this.healthy = true;
    this.clearGraceTimer();
    this.watchdog ??= setInterval(() => this.observeDave(), this.timing.watchdogMs);
    this.watchdog.unref();
    this.o.election.setState(this.o.id, { healthy: true });
    this.o.election.daveRestored(this.o.id); // no-op unless a previous session had lost DAVE
    this.emit("healthy");
  }

  /**
   * Create and wire a new connection. Anything that goes wrong here is a failed attempt: the debt is
   * recorded and a half-built connection is destroyed, so retrying construction in a loop is paid for
   * like any other rebuild instead of looking like a series of planned joins.
   */
  private buildConnection(target: VoiceTarget): VoiceConnection {
    let created: VoiceConnection | null = null;
    try {
      const squatter = getVoiceConnection(target.guildId, this.voiceGroup);
      if (squatter && squatter.state.status !== VoiceConnectionStatus.Destroyed) {
        throw new Error(`voice group ${this.voiceGroup} is already in use by another bot instance; refusing to share a connection`);
      }
      const fresh = joinVoiceChannel({
        channelId: target.channelId,
        guildId: target.guildId,
        group: this.voiceGroup,
        adapterCreator: target.adapterCreator,
        selfDeaf: this.selfDeaf,
        selfMute: false,
        daveEncryption: true,
        decryptionFailureTolerance: 36,
      });
      created = fresh;
      this.connection = fresh;
      this.installDaveGuards(fresh);
      this.watchDave(fresh);
      fresh.subscribe(this.player);
      fresh.on("stateChange", (o, n) => {
        // Only an unexpected change on the live connection is a failure; our own teardown detaches first.
        if (fresh !== this.connection) return;
        this.watchDave(fresh);
        if (o.status !== n.status) this.logDaveLifecycle(fresh, `voice-${n.status}`);
        if (n.status === VoiceConnectionStatus.Disconnected) this.markUnhealthy(`voice ${n.status}`);
        // Destroyed cannot be revived: drop it so the next join builds a new connection and DAVE session.
        else if (n.status === VoiceConnectionStatus.Destroyed) this.markUnhealthy(`voice ${n.status}`, { fresh: true });
      });
      fresh.on("error", (e) => this.o.log.warn(`${this.o.id} voice error: ${safeError(e)}`));
      return fresh;
    } catch (e) {
      this.noteFailure();
      if (created) {
        if (this.connection === created) this.discardConnection();
        else this.destroyQuietly(created);
      }
      throw e;
    }
  }

  private currentDave(conn: VoiceConnection): object | null {
    const state = conn.state;
    return state.status === VoiceConnectionStatus.Ready ? ((state.networking.state as { dave?: object }).dave ?? null) : null;
  }

  /** DAVE wrapper if present, including before Voice Ready (SelectingProtocol send of opcode 26). */
  private daveObject(conn: VoiceConnection): object | null {
    const net = (conn.state as { networking?: { state?: { dave?: object; ws?: object } } }).networking?.state;
    return net?.dave ?? null;
  }

  private voiceWs(conn: VoiceConnection): object | null {
    return (conn.state as { networking?: { state?: { ws?: object } } }).networking?.state?.ws ?? null;
  }

  /**
   * DAVE established on this connection, and the session in force can be identified (fail closed:
   * a session the bot cannot tell apart from the next one is treated as no session).
   */
  private enforced(conn: VoiceConnection | null = this.connection): boolean {
    return conn !== null && daveEnforced(readDaveInfo(conn)) && this.sessionEpoch(conn) !== null;
  }

  /** The epoch of the DAVE session in force on this connection now, or null when there is none. */
  private sessionEpoch(conn: VoiceConnection): number | null {
    return this.daveEpochs.of(daveSessionIdentity(conn));
  }

  /** Is the session the current receive generation is bound to still the one in force on the live connection. */
  private receiveSessionHolds(conn: VoiceConnection, epoch: number): boolean {
    return conn === this.connection && this.sessionEpoch(conn) === epoch;
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
      const under = this.currentDave(conn); // the session in force when encryption starts, not when it ends
      const packet = prepare(buffer);
      this.preparedFor = under;
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
      // Dropped (VoiceReceiver does not push a null packet) unless DAVE is established and, while
      // receiving, it is still the session the receive generation was started under.
      if (conn !== this.connection || !this.enforced(conn) || (this.receiveSession !== null && !this.receiveSessionHolds(conn, this.receiveSession))) {
        queueMicrotask(() => this.observeDave());
        return null;
      }
      this.refusePlaintext(conn, userId);
      return parse(buffer, mode, nonce, secretKey, userId);
    };
  }

  /**
   * Is DAVE established on the live connection right now. For the pipelines' last boundary before
   * TeamSpeak: it reads the connection, not a cached flag, and leaves the reaction to a microtask so
   * it can be called from inside a mix tick without re-entering the pipeline.
   */
  daveEstablished(): boolean {
    const ok = this.enforced();
    if (!ok) queueMicrotask(() => this.observeDave());
    return ok;
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

  /**
   * Read the live DAVE state and act on a change: lost, established again, or (while receiving)
   * replaced by a different established session. Returns whether DAVE is established now.
   *
   * This is the reaction, not the boundary: a replaced session is refused at packet reception and at
   * the mix by the admission's own session check, whether or not this has run yet.
   */
  private observeDave(): boolean {
    const conn = this.connection;
    if (!conn) return false;
    const ok = this.enforced(conn);
    if (ok !== this.daveOk) {
      this.daveOk = ok;
      if (!this.healthy) return ok; // a join in progress is governed by requireDave
      if (ok) this.handleDaveRestored();
      else this.handleDaveLost();
      return ok;
    }
    if (ok && this.healthy && this.admission && (this.admission.isClosed || this.receiveSession === null || !this.receiveSessionHolds(conn, this.receiveSession))) {
      this.handleDaveReplaced();
    }
    return ok;
  }

  /**
   * The established session the receive generation was bound to was replaced by another established
   * one. Every admission of the old session has already ended (the first check that saw the change
   * closed them) or ends here. Reception stops now, which closes every old subscription and makes
   * their callbacks stale, and the election moves this bot to a new generation: everything queued
   * under the old one is flushed and fenced, and the new generation subscribes under the new
   * session, with new admissions. The connection is kept, since the new session is healthy.
   */
  private handleDaveReplaced(): void {
    this.daveReplacements += 1;
    this.o.log.warn(`${this.o.id} DAVE session replaced: ending every admission of the old session and receiving again under a new generation`);
    this.stopReceive();
    this.o.election.daveLost(this.o.id, "dave session replaced");
    this.o.election.daveRestored(this.o.id);
  }

  private handleDaveLost(): void {
    this.logDaveLifecycle(this.connection, "lost");
    this.dropOutbound();
    this.stopReceive();
    this.o.election.daveLost(this.o.id, "dave unavailable");
    this.clearGraceTimer();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.daveOk) {
        this.logDaveLifecycle(this.connection, "grace-expired");
        this.markUnhealthy("DAVE unavailable after the grace window", { fresh: true });
      }
    }, this.timing.daveGraceMs);
    this.graceTimer.unref();
  }

  private handleDaveRestored(): void {
    this.clearGraceTimer();
    this.logDaveLifecycle(this.connection, "restored");
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
    this.detachFeed(false);
    this.player.stop(true);
  }

  /** Enforce DAVE: wait for an established session, otherwise drop the connection and fail closed. */
  private async requireDave(conn: VoiceConnection, epoch: number): Promise<void> {
    const deadline = Date.now() + this.timing.daveWaitMs;
    let lastLog = 0;
    this.watchDave(conn);
    this.logDaveLifecycle(conn, "wait");
    while (Date.now() < deadline) {
      this.checkpoint(epoch, conn);
      this.watchDave(conn);
      if (this.enforced(conn)) {
        this.logDaveLifecycle(conn, "ready");
        return;
      }
      const now = Date.now();
      if (now - lastLog >= 2_000) {
        lastLog = now;
        this.logDaveLifecycle(conn, "wait");
      }
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    const info = readDaveInfo(conn);
    this.logDaveLifecycle(conn, "timeout");
    this.noteFailure();
    this.discardConnection();
    throw new Error(`DAVE not negotiated (protocolVersion=${info?.protocolVersion ?? "n/a"}, ready=${info?.ready ?? false}); failing closed`);
  }

  /** Attach the negotiation trace as soon as the library creates a DAVE wrapper. */
  private watchDave(conn: VoiceConnection): void {
    this.daveTrace ??= emptyDaveSnapshot();
    const ws = this.voiceWs(conn);
    if (ws) observeDaveWs(ws, () => this.daveTrace ?? emptyDaveSnapshot());
    const dave = this.daveObject(conn);
    if (!dave) return;
    const live = observeDave(dave);
    if (!live) return;
    if (live !== this.daveTrace) {
      const shared = this.daveTrace.wsOut;
      Object.assign(shared, live.wsOut);
      live.wsOut = shared;
    }
    this.daveTrace = live;
  }

  /** Integers only: Discord voice members in the configured channel, and how many are bots. */
  private voiceMemberCounts(): { members: number; bots: number } {
    const guild = this.client.guilds.cache.get(this.o.guildId);
    if (!guild) return { members: 0, bots: 0 };
    let members = 0;
    let bots = 0;
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.channelId !== this.o.channelId) continue;
      members += 1;
      if (vs.member?.user?.bot === true) bots += 1;
    }
    return { members, bots };
  }

  /**
   * One privacy-safe line for a DAVE or voice-connection lifecycle event. Skips a repeat of the
   * same phase/protocol/ready/connection/membership/trace (elapsedMs is observational only).
   */
  private logDaveLifecycle(conn: VoiceConnection | null, phase: string): void {
    const info = conn ? readDaveInfo(conn) : null;
    const trace = this.daveTrace ? formatDaveSnapshot(this.daveTrace) : "no-wrapper";
    const elapsedMs = this.connectedAt === null ? "n/a" : Date.now() - this.connectedAt;
    const status = conn?.state.status ?? "none";
    const { members, bots } = this.voiceMemberCounts();
    const key = `${phase} ${status} protocol=${info?.protocolVersion ?? "n/a"} ready=${info?.ready ?? false} voiceMembers=${members} voiceBots=${bots} ${trace}`;
    if (key === this.lastDaveLifecycleKey) return;
    this.lastDaveLifecycleKey = key;
    const line = `${this.o.id} DAVE ${phase}: protocol=${info?.protocolVersion ?? "n/a"} ready=${info?.ready ?? false} conn=${status} elapsedMs=${elapsedMs} voiceMembers=${members} voiceBots=${bots} failures=${this.failures} ${trace}`;
    if (phase === "lost" || phase === "grace-expired" || phase.startsWith("voice-")) this.o.log.warn(line);
    else this.o.log.info(line);
  }

  /** The TeamSpeak speaker assigned to this bot: Opus passthrough, one turn per stretch of speech. */
  sendOpus(frame: Buffer): void {
    if (!this.healthy || !this.observeDave()) return;
    if (!this.feed || this.feed.destroyed) {
      this.detachFeed(false);
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
    this.detachFeed(true);
  }

  private detachFeed(finish: boolean): void {
    const feed = this.feed;
    if (!feed) return;
    this.feedDropped += feed.dropped;
    this.feedStarved += feed.starved;
    this.feed = null;
    if (finish) feed.finish();
    else feed.destroy();
  }

  /** Start human subscriptions under `generation`. Only the admitted receiver may call this. */
  startReceive(generation: number): boolean {
    const conn = this.connection;
    if (!conn || this.selfDeaf || !this.o.election.admitSubscribe(this.o.id, generation)) return false;
    this.stopReceive();
    // The generation is bound to the DAVE session in force now; with no identifiable session, nobody is heard.
    const session = this.enforced(conn) ? this.sessionEpoch(conn) : null;
    if (session === null) {
      queueMicrotask(() => this.observeDave());
      return false;
    }
    const receiver = conn.receiver;
    // Heard only while present in the source channel AND known to be human: never a bridge bot (that
    // would re-forward bridge audio), never another bot account, never someone we cannot identify yet,
    // never someone who has left. The admissions end with this generation (`stopReceive`).
    const admission = new VoiceAdmission({
      channelId: this.o.channelId,
      channelOf: (userId) => this.channelOf(userId),
      isHuman: (userId) => this.humans.isHuman(userId),
      excluded: (userId) => this.excluded(userId),
      // Deferred: a revocation found during a mix tick must not tear streams down inside that tick.
      onRevoked: (userId) => queueMicrotask(() => sup.closeUser(userId)),
      session,
      sessionLive: () => this.receiveSessionHolds(conn, session),
      // Deferred for the same reason. The admissions are already closed; this starts the new generation.
      onSessionEnded: () =>
        queueMicrotask(() => {
          if (this.admission === admission) this.observeDave();
        }),
    });
    const sup: ReceiveSupervisor = new ReceiveSupervisor({
      bot: this.o.id,
      generation,
      election: this.o.election,
      subscribe: (userId) => receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 200 } }),
      admit: (userId) => admission.admit(userId),
      admitted: (a) => admission.valid(a),
      activeSpeakers: () => receiver.speaking.users.keys(),
      onFrame: (userId, opus, gen, a) => {
        // DAVE unavailable (or replaced: observing it ends this generation), stale reception, or an ended admission.
        if (!this.observeDave() || this.supervisor !== sup || !admission.valid(a)) return;
        this.o.onHumanOpus(this.o.id, gen, userId, opus, a);
      },
      onUserClosed: (userId) => this.o.onHumanClosed?.(this.o.id, userId),
      onNeedRecovery: (reason) => {
        if (this.supervisor === sup) this.requestRecovery(reason);
      },
      log: (m) => this.o.log.warn(`${this.o.id} ${m}`),
    });
    this.supervisor = sup;
    this.admission = admission;
    this.receiveSession = session;
    this.receiveOnSpeaking = (userId) => {
      sup.open(userId);
    };
    receiver.speaking.on("start", this.receiveOnSpeaking);
    sup.start(); // opens everyone already speaking: a start event is never the only trigger
    return true;
  }

  /** Drop every human subscription immediately (teardown before a new election). */
  stopReceive(from: VoiceConnection | null = this.connection): void {
    if (this.receiveOnSpeaking && from) from.receiver.speaking.off("start", this.receiveOnSpeaking);
    this.receiveOnSpeaking = null;
    this.admission?.close();
    this.admission = null;
    this.receiveSession = null;
    this.supervisor?.closeAll();
    this.supervisor = null;
  }

  /**
   * The last boundary before TeamSpeak: is this admission the user's current one under this bot's
   * current receive generation, and are they still in the source channel. Read live, so a frame
   * queued before a departure, a teardown or a replacement is refused when it comes up to be mixed.
   */
  humanAdmitted(userId: string, admission: Admission | undefined): boolean {
    return admission?.userId === userId && this.admission?.valid(admission) === true;
  }

  /**
   * Identity lookups for speakers the client has not seen. `pending` and `stalled` are the requests
   * out in the whole process (the registry's count, the real number); the rest is this bot's view.
   */
  get identityLookups() {
    return this.humans.stats();
  }

  /** Admissions under the current receive generation (0 while not receiving). */
  get admittedHumans(): number {
    return this.admission?.size ?? 0;
  }

  get openSubscriptions(): number {
    return this.supervisor?.openCount ?? 0;
  }

  get decryptErrors(): number {
    return this.supervisor?.decryptErrors ?? 0;
  }

  get playbackDropped(): number {
    return this.feedDropped + (this.feed?.dropped ?? 0);
  }

  get playbackStarved(): number {
    return this.feedStarved + (this.feed?.starved ?? 0);
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
    this.noteFailure();
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
    this.noteFailure();
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
    this.daveTrace = null;
    this.connectedAt = null;
    this.preparedFor = null;
    this.daveEpochs.forget();
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
   * call is cancelled, including one that is still resolving its target. The debt is kept: a bot
   * that failed still pays for its next rebuild even if it was told to leave in between.
   */
  leave(): void {
    this.epoch += 1;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearGraceTimer();
    this.healthy = false;
    this.humans.reset(); // the session ended: what it knew is dropped (requests still out stay counted until they settle)
    this.discardConnection();
  }

  /** Stop for good: leave, refuse every later join, and release the Discord client. */
  async destroy(): Promise<void> {
    this.stopped = true;
    this.leave();
    this.humans.dispose();
    // A destroyed client can stay reachable while a REST request it started is out; it must not keep this bot.
    this.client.off("voiceStateUpdate", this.onVoiceState);
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

  /** Privacy-safe MLS negotiation snapshot (categories and integers only). */
  get daveNegotiation() {
    return this.daveTrace
      ? {
          ...this.daveTrace,
          events: { ...this.daveTrace.events },
          wsOut: { ...this.daveTrace.wsOut },
          elapsedMs: this.connectedAt === null ? null : Date.now() - this.connectedAt,
          failures: this.failures,
        }
      : null;
  }

  /** The epoch of the DAVE session in force on the live connection (null when none), for diagnostics and tests. */
  get daveSession(): number | null {
    return this.connection ? this.sessionEpoch(this.connection) : null;
  }

  /** The DAVE session epoch the current receive generation is bound to (null while not receiving). */
  get receiveDaveSession(): number | null {
    return this.receiveSession;
  }
}

/**
 * The production identity lookup: the REST user lookup (needs no privileged intent), as a function of
 * the client alone. The returned promise settles exactly when the REST request does, and is
 * deliberately not raced against a timer: the identity request registry counts the request until
 * this promise settles, and can only keep that count honest if the promise it holds is the request
 * itself. (A race here once freed a slot while the request it stood for was still out: 24 requests
 * unsettled against a cap of 8.)
 *
 * discord.js aborts each attempt after its REST timeout (15 s) and retries it up to 3 times, and all
 * user lookups of one client wait in one sequential route queue, so a request normally settles, but
 * nothing here bounds how long, and neither `Client.destroy()` nor dropping the promise cancels it. A
 * request that never settles keeps its process-wide slot until the process exits, and keeps the
 * client that started it reachable (its REST manager owns the request). It does not keep the bot:
 * this function captures only the client, and `destroy()` removes the bot's listener from it.
 */
function userLookupVia(client: Client): (userId: string) => Promise<DiscordUserInfo | null> {
  return async (userId) => {
    const user = await client.users.fetch(userId);
    return typeof user.bot === "boolean" ? { bot: user.bot } : null;
  };
}
