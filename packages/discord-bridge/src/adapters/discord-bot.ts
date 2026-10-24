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
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import { Client, GatewayIntentBits, PermissionFlagsBits, type Guild, type VoiceBasedChannel } from "discord.js";
import { daveEnforced, readDaveInfo } from "../core/dave-gate.js";
import { FrameFeed } from "../core/frame-feed.js";
import type { BotId } from "../core/ids.js";
import { registerSecret, safeError, type Logger } from "../core/redact.js";
import { ReceiveSupervisor } from "../core/receive-supervisor.js";
import type { ReceiverElection } from "../core/receiver-election.js";
import type { BotPort } from "../bridge/runtime.js";

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
}

const REQUIRED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
const DAVE_WAIT_MS = 10_000;
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
  userId = "";
  healthy = false;
  framesSent = 0;
  rejoins = 0;

  constructor(private readonly o: DiscordBotOptions) {
    super();
    registerSecret(o.token);
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
      if (!channel || !channel.isVoiceBased()) return { ok: false, reason: "not a voice channel" };
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

  /** Join the approved voice channel. A receiver must be undeafened; senders deafen themselves. */
  async join(opts: { receive: boolean }): Promise<void> {
    const guild: Guild = await this.client.guilds.fetch(this.o.guildId);
    const channel = (await guild.channels.fetch(this.o.channelId)) as VoiceBasedChannel;
    this.selfDeaf = !opts.receive;
    if (this.connection) {
      this.connection.rejoin({ channelId: channel.id, selfDeaf: this.selfDeaf, selfMute: false });
    } else {
      this.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: this.selfDeaf,
        selfMute: false,
        daveEncryption: true,
        decryptionFailureTolerance: 36,
      });
      this.connection.subscribe(this.player);
      this.connection.on("stateChange", (_o, n) => {
        if (n.status === VoiceConnectionStatus.Disconnected || n.status === VoiceConnectionStatus.Destroyed) this.markUnhealthy(`voice ${n.status}`);
      });
      this.connection.on("error", (e) => this.o.log.warn(`${this.o.id} voice error: ${safeError(e)}`));
    }
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    await this.requireDave();
    this.healthy = true;
    this.o.election.setState(this.o.id, { healthy: true });
    this.emit("healthy");
  }

  /** Enforce DAVE: wait for an established session, otherwise leave and fail closed. */
  private async requireDave(): Promise<void> {
    const deadline = Date.now() + DAVE_WAIT_MS;
    while (Date.now() < deadline) {
      if (daveEnforced(readDaveInfo(this.connection!))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    const info = readDaveInfo(this.connection!);
    this.leave();
    throw new Error(`DAVE not negotiated (protocolVersion=${info?.protocolVersion ?? "n/a"}, ready=${info?.ready ?? false}); failing closed`);
  }

  /** The TeamSpeak speaker assigned to this bot: Opus passthrough, one turn per stretch of speech. */
  sendOpus(frame: Buffer): void {
    if (!this.healthy || !daveEnforced(readDaveInfo(this.connection!))) return;
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
    this.supervisor = new ReceiveSupervisor({
      bot: this.o.id,
      generation,
      election: this.o.election,
      subscribe: (userId) => receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 200 } }),
      onFrame: (userId, opus, gen) => this.o.onHumanOpus(this.o.id, gen, userId, opus),
      onNeedRejoin: (reason) => void this.rejoin(reason),
      log: (m) => this.o.log.warn(`${this.o.id} ${m}`),
    });
    const sup = this.supervisor;
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

  get daveInfo() {
    return this.connection ? readDaveInfo(this.connection) : null;
  }
}
