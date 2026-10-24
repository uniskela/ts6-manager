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
const DEFAULT_TIMING: BotTiming = { readyMs: 20_000, daveWaitMs: 10_000, pollMs: 200, watchdogMs: 100, daveGraceMs: 5_000 };
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

  /** Join the approved voice channel. A receiver must be undeafened; senders deafen themselves. */
  async join(opts: { receive: boolean }): Promise<void> {
    const target = await this.resolveTarget();
    this.selfDeaf = !opts.receive;
    if (this.connection) {
      this.connection.rejoin({ channelId: target.channelId, selfDeaf: this.selfDeaf, selfMute: false });
    } else {
      const squatter = getVoiceConnection(target.guildId, this.voiceGroup);
      if (squatter && squatter.state.status !== VoiceConnectionStatus.Destroyed) {
        throw new Error(`voice group ${this.voiceGroup} is already in use by another bot instance; refusing to share a connection`);
      }
      this.connection = joinVoiceChannel({
        channelId: target.channelId,
        guildId: target.guildId,
        group: this.voiceGroup,
        adapterCreator: target.adapterCreator,
        selfDeaf: this.selfDeaf,
        selfMute: false,
        daveEncryption: true,
        decryptionFailureTolerance: 36,
      });
      this.installDaveGuards(this.connection);
      this.connection.subscribe(this.player);
      this.connection.on("stateChange", (_o, n) => {
        if (n.status === VoiceConnectionStatus.Disconnected || n.status === VoiceConnectionStatus.Destroyed) this.markUnhealthy(`voice ${n.status}`);
      });
      this.connection.on("error", (e) => this.o.log.warn(`${this.o.id} voice error: ${safeError(e)}`));
    }
    await entersState(this.connection, VoiceConnectionStatus.Ready, this.timing.readyMs);
    await this.requireDave();
    this.daveOk = true;
    this.healthy = true;
    this.clearGraceTimer();
    this.watchdog ??= setInterval(() => this.observeDave(), this.timing.watchdogMs);
    this.watchdog.unref();
    this.o.election.setState(this.o.id, { healthy: true });
    this.o.election.daveRestored(this.o.id); // no-op unless a previous session had lost DAVE
    this.emit("healthy");
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
    conn.prepareAudioPacket = (buffer) => (this.sendAllowed(conn) ? prepare(buffer) : undefined);
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
      if (!this.daveOk) this.markUnhealthy("DAVE unavailable after the grace window");
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

  /** Enforce DAVE: wait for an established session, otherwise leave and fail closed. */
  private async requireDave(): Promise<void> {
    const deadline = Date.now() + this.timing.daveWaitMs;
    while (Date.now() < deadline) {
      if (daveEnforced(readDaveInfo(this.connection!))) return;
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    const info = readDaveInfo(this.connection!);
    this.leave();
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
    const sup: ReceiveSupervisor = new ReceiveSupervisor({
      bot: this.o.id,
      generation,
      election: this.o.election,
      subscribe: (userId) => receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 200 } }),
      onFrame: (userId, opus, gen) => {
        if (this.supervisor !== sup || !this.observeDave()) return; // stale reception or DAVE unavailable
        this.o.onHumanOpus(this.o.id, gen, userId, opus);
      },
      onNeedRejoin: (reason) => void this.rejoin(reason),
      log: (m) => this.o.log.warn(`${this.o.id} ${m}`),
    });
    this.supervisor = sup;
    this.receiveOnSpeaking = (userId) => {
      // Never subscribe to a bridge bot (including this one): that would re-forward bridge audio.
      if (this.o.bridgeUserIds().has(userId) || userId === this.userId) return;
      sup.open(userId);
    };
    receiver.speaking.on("start", this.receiveOnSpeaking);
    return true;
  }

  /** Drop every human subscription immediately (teardown before a new election). */
  stopReceive(): void {
    if (this.receiveOnSpeaking && this.connection) this.connection.receiver.speaking.off("start", this.receiveOnSpeaking);
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

  /** Rebuild the voice connection to re-run the MLS/DAVE handshake after repeated decrypt failures. */
  async rejoin(reason: string): Promise<void> {
    this.rejoins += 1;
    this.o.log.warn(`${this.o.id} rejoining voice: ${reason}`);
    const gen = this.o.election.generation;
    const wasReceiver = this.o.election.receiver === this.o.id;
    this.stopReceive();
    this.healthy = false;
    try {
      await this.join({ receive: wasReceiver });
      if (wasReceiver && this.o.election.receiver === this.o.id) this.startReceive(this.o.election.generation === gen ? gen : this.o.election.generation);
    } catch (e) {
      this.markUnhealthy(`rejoin failed: ${safeError(e)}`);
    }
  }

  markUnhealthy(reason: string): void {
    if (!this.healthy && !this.connection) return;
    this.healthy = false;
    this.stopReceive();
    this.o.log.warn(`${this.o.id} unhealthy: ${reason}`);
    this.emit("unhealthy", reason);
  }

  /** Hard-kill the voice connection (used by the receiver-kill scenario). */
  kill(reason: string): void {
    this.leave();
    this.emit("unhealthy", reason);
  }

  leave(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearGraceTimer();
    this.daveOk = false;
    this.stopReceive();
    this.endSpeech();
    this.healthy = false;
    this.player.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      /* already destroyed */
    }
    this.connection = null;
  }

  async destroy(): Promise<void> {
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
