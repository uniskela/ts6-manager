/**
 * Test harness: real @discordjs/voice classes with only the network edge faked.
 *
 * - `VoiceConnection`, `AudioPlayer`, `VoiceReceiver`, `SpeakingMap` and `DAVESession` are the
 *   library's own. DAVE encrypt/decrypt go through the real `DAVESession` wrapper, so the plaintext
 *   fallback the library exhibits at protocol 0 or when the MLS group is not ready is the real one.
 * - Only the native davey session (`FakeDavey`), the gateway adapter and the Networking object
 *   (UDP/WebSocket) are stand-ins.
 *
 * This is simulated Discord evidence. It is never live Discord evidence.
 */
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DAVESession, type DiscordGatewayAdapterCreator, type VoiceConnection } from "@discordjs/voice";
import { ClientUser, type Client } from "discord.js";
import { DiscordBot } from "../adapters/discord-bot.js";
import { IdentityRequests } from "../core/identity-requests.js";
import type { BotId } from "../core/ids.js";
import { createLogger } from "../core/redact.js";
import type { ReceiverElection } from "../core/receiver-election.js";
import type { Admission } from "../core/voice-admission.js";

export const DAVE_MAGIC = Buffer.from("DAVE");
const RTP_OPUS_PAYLOAD_TYPE = 120;
const NETWORKING_READY = 4;

/** Stand-in for the native `@snazzah/davey` session. A DAVE packet is `DAVE` + opus. */
export class FakeDavey {
  ready = true;
  passthrough = false;
  decryptCalls = 0;
  reinitCalls = 0;
  resetCalls = 0;
  /** When set, every decrypt throws it (an MLS epoch the bot cannot read). */
  decryptError: Error | null = null;
  canPassthrough(): boolean {
    return this.passthrough;
  }
  setPassthroughMode(on: boolean): void {
    this.passthrough = on;
  }
  decrypt(_userId: string, _type: number, packet: Buffer): Buffer {
    this.decryptCalls += 1;
    if (this.decryptError) throw this.decryptError;
    if (packet.subarray(0, 4).equals(DAVE_MAGIC)) return Buffer.from(packet.subarray(4));
    if (this.passthrough) return packet;
    throw new Error("UnencryptedWhenPassthroughDisabled");
  }
  encryptOpus(packet: Buffer): Buffer {
    return Buffer.concat([DAVE_MAGIC, packet]);
  }
  reinit(): void {
    this.reinitCalls += 1;
  }
  reset(): void {
    this.resetCalls += 1;
  }
  getSerializedKeyPackage(): Buffer {
    return Buffer.alloc(1);
  }
  setExternalSender(): void {}
  processWelcome(): void {}
  processCommit(): void {}
}

export interface FakeAdapter {
  name: string;
  creator: DiscordGatewayAdapterCreator;
  /** Payloads this adapter was asked to send (this client's gateway only). */
  sent: { op: number; d: { guild_id: string; channel_id: string | null } }[];
  destroyed: boolean;
  /** Refuse the next N payloads: `sendPayload` returns false, as it does when the gateway is unavailable. */
  refuseNext: number;
  /** While set, creating the adapter for a new connection throws (a connection that cannot be constructed). */
  failCreate: Error | null;
  /** Called after every join (non-leave) payload this adapter sends. */
  onJoin?: () => void;
}

/** One Discord client's voice adapter. Each bot must get its own and only ever use its own. */
export function fakeAdapter(name: string): FakeAdapter {
  const a: FakeAdapter = {
    name,
    sent: [],
    destroyed: false,
    refuseNext: 0,
    failCreate: null,
    creator: () => {
      if (a.failCreate) throw a.failCreate;
      return {
        sendPayload: (payload: unknown) => {
          if (a.refuseNext > 0) {
            a.refuseNext -= 1;
            return false;
          }
          const p = payload as FakeAdapter["sent"][number];
          a.sent.push(p);
          if (p.d.channel_id !== null) a.onJoin?.();
          return true;
        },
        destroy: () => {
          a.destroyed = true;
        },
      };
    },
  };
  return a;
}

/** The Networking stand-in. `prepareAudioPacket` runs the real DAVESession.encrypt. */
export class FakeNetworking extends EventEmitter {
  state: { code: number; dave: DAVESession; connectionData: Record<string, unknown>; ws: EventEmitter; udp: EventEmitter };
  /** Packets as they would leave on the wire (after DAVE encryption). */
  wire: Buffer[] = [];
  private prepared: Buffer | null = null;
  destroyed = false;
  constructor(readonly dave: DAVESession, readonly secretKey: Buffer) {
    super();
    this.state = {
      code: NETWORKING_READY,
      dave,
      connectionData: { encryptionMode: "aead_aes256_gcm_rtpsize", nonceBuffer: Buffer.alloc(12), secretKey },
      ws: new EventEmitter(),
      udp: new EventEmitter(),
    };
  }
  prepareAudioPacket(opus: Buffer): Buffer {
    this.prepared = this.dave.encrypt(opus);
    return this.prepared;
  }
  dispatchAudio(): boolean {
    if (!this.prepared) return false;
    this.wire.push(this.prepared);
    this.prepared = null;
    return true;
  }
  setSpeaking(): boolean {
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export interface ReadyHandle {
  conn: VoiceConnection;
  networking: FakeNetworking;
  dave: DAVESession;
  davey: FakeDavey;
  /** Make `userId` a known speaker (SSRC mapped, as after a Speaking opcode). */
  mapUser(userId: string, ssrc: number): void;
  /** Deliver one RTP packet from `userId` into the REAL VoiceReceiver.onUdpMessage. */
  udp(userId: string, opus: Buffer, o?: { dave?: boolean }): void;
  /** Change the MLS/DAVE state the way a transition would. */
  setDave(o: { protocolVersion?: number; ready?: boolean }): void;
  /** Replace the DAVE session with a new, established one (an MLS reset): anything encrypted under the old one is stale. */
  replaceDave(): DAVESession;
  /**
   * Re-initialise the live session in place through the library's own `DAVESession.reinit()` (what
   * an invalid transition or a new epoch 1 does): the same connection, Networking, wrapper and native
   * session objects, a new MLS session underneath. The fake native session stays ready throughout,
   * the worst case for anything that only watches availability.
   */
  reinitDave(): void;
}

/** Drive a real VoiceConnection to Ready with a DAVE session on top of the fake native session. */
export function makeReady(
  conn: VoiceConnection,
  o: { userId?: string; protocolVersion?: number; ready?: boolean; reuse?: ReadyHandle } = {},
): ReadyHandle {
  // `reuse` simulates a "recovery" that handed back the very same DAVE session (a stale one).
  const davey = o.reuse?.davey ?? new FakeDavey();
  davey.ready = o.ready ?? true;
  const dave = o.reuse?.dave ?? new DAVESession(o.protocolVersion ?? 1, o.userId ?? "bot", "channel", { decryptionFailureTolerance: 1 });
  (dave as unknown as { session: FakeDavey }).session = davey;
  const secretKey = randomBytes(32);
  const networking = new FakeNetworking(dave, secretKey);
  (conn as unknown as { state: unknown }).state = { ...conn.state, status: "ready", networking };
  const ssrcs = new Map<string, number>();
  let seq = 0;
  return {
    conn,
    networking,
    dave,
    davey,
    mapUser(userId, ssrc) {
      ssrcs.set(userId, ssrc);
      conn.receiver.ssrcMap.update({ userId, audioSSRC: ssrc });
    },
    udp(userId, opus, opts = {}) {
      const ssrc = ssrcs.get(userId);
      if (ssrc === undefined) throw new Error(`user ${userId} has no SSRC`);
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = RTP_OPUS_PAYLOAD_TYPE;
      header.writeUInt16BE(seq & 0xffff, 2);
      header.writeUInt32BE((seq * 960) >>> 0, 4);
      header.writeUInt32BE(ssrc, 8);
      const nonce = Buffer.alloc(4);
      nonce.writeUInt32BE(seq++, 0);
      const iv = Buffer.concat([nonce, Buffer.alloc(8)]);
      const cipher = createCipheriv("aes-256-gcm", secretKey, iv);
      cipher.setAAD(header);
      const payload = opts.dave === false ? opus : Buffer.concat([DAVE_MAGIC, opus]);
      const body = Buffer.concat([cipher.update(payload), cipher.final()]);
      conn.receiver.onUdpMessage(Buffer.concat([header, body, cipher.getAuthTag(), nonce]));
    },
    setDave(s) {
      if (s.protocolVersion !== undefined) dave.protocolVersion = s.protocolVersion;
      if (s.ready !== undefined) davey.ready = s.ready;
    },
    replaceDave() {
      const next = new DAVESession(1, o.userId ?? "bot", "channel", { decryptionFailureTolerance: 1 });
      (next as unknown as { session: FakeDavey }).session = new FakeDavey();
      (networking.state as { dave: DAVESession }).dave = next;
      return next;
    },
    reinitDave() {
      const live = (networking.state as { dave: DAVESession }).dave;
      live.reinit();
    },
  };
}

/** The player pads the end of every resource with Opus silence frames; they are never DAVE-encrypted. */
export const isSilence = (p: Buffer) => p.equals(Buffer.from([0xf8, 0xff, 0xfe]));

/** A human who talks continuously: one packet every 20 ms, with no pause and so no new speaking-start event. */
export function talk(h: ReadyHandle, userId: string, opusFor: (n: number) => Buffer = (n) => Buffer.from([0xfc, n & 0xff, 1, 1])): () => number {
  let n = 0;
  const timer = setInterval(() => h.udp(userId, opusFor(n++)), 20);
  timer.unref();
  return () => {
    clearInterval(timer);
    return n;
  };
}

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | null | undefined | false, ms = 2000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

export const quietLog = createLogger("test", () => undefined);

export interface TestBot {
  bot: DiscordBot;
  adapter: FakeAdapter;
  /** Handles for every connection this bot has opened, oldest first. */
  ready: ReadyHandle[];
  /** When false, new connections stay in Signalling (a join that never completes). */
  autoReady: boolean;
  /** Make the next connections come up with the previous session's DAVE object (a stale session). */
  reuseDave: boolean;
  /** Join and wait until the new connection is Ready with DAVE established. */
  join(o?: { receive?: boolean; protocolVersion?: number }): Promise<ReadyHandle>;
  latest(): ReadyHandle;
  /** Bring the bot's current Signalling connection up now (a held connection finally completing). */
  completePending(): ReadyHandle | null;
  /** While set, target resolution waits for it (a slow guild/channel lookup). */
  holdTarget(): () => void;
  /**
   * Move a user's Discord voice state (null: disconnected), through discord.js's own gateway
   * handler, so the guild's voice-state cache and the `voiceStateUpdate` event are the real ones.
   * `member` attaches guild member data, which (as on the real gateway) puts the user in the cache.
   */
  voice(userId: string, channelId: string | null, o?: { member?: { bot: boolean } }): void;
  /** When true (the default), `mapUser` on this bot's connections also puts the user in the bot's channel. */
  autoVoice: boolean;
  /** The process-scoped identity request registry this bot was given. */
  identityRequests: IdentityRequests | undefined;
}

/** A guild in the client's cache, and the client's own user, as discord.js has them after READY. */
export function seedGuild(client: Client, guildId: string, botUserId: string): void {
  const Ctor = ClientUser as unknown as new (c: Client, data: unknown) => ClientUser; // protected in the typings
  (client as unknown as { user: ClientUser }).user = new Ctor(client, { id: botUserId, username: "bridge", discriminator: "0", bot: true, avatar: null, global_name: null });
  (client.guilds as unknown as { _add(d: unknown): unknown })._add({ id: guildId, name: "test guild", channels: [], roles: [], emojis: [], stickers: [], members: [], voice_states: [] });
}

/** Deliver a VOICE_STATE_UPDATE dispatch to discord.js's own handler. */
export function voiceStateUpdate(client: Client, guildId: string, userId: string, channelId: string | null, o: { member?: { bot: boolean } } = {}): void {
  const data: Record<string, unknown> = { guild_id: guildId, channel_id: channelId, user_id: userId, session_id: `s-${userId}`, deaf: false, mute: false, self_deaf: false, self_mute: false, suppress: false, request_to_speak_timestamp: null };
  if (o.member) data.member = { user: { id: userId, username: `user${userId.slice(-3)}`, discriminator: "0", global_name: null, avatar: null, bot: o.member.bot }, roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false };
  (client as unknown as { actions: { VoiceStateUpdate: { handle(d: unknown): void } } }).actions.VoiceStateUpdate.handle(data);
}

export function testBot(
  id: BotId,
  election: ReceiverElection,
  o: {
    guildId?: string;
    sessionId?: string;
    onHumanOpus?: (bot: BotId, gen: number, user: string, opus: Buffer, admission: Admission) => void;
    onHumanClosed?: (bot: BotId, user: string) => void;
    userId?: string;
    bridgeUserIds?: () => ReadonlySet<string>;
    timing?: Partial<import("../adapters/discord-bot.js").BotTiming>;
    protocolVersion?: number;
    now?: () => number;
    /** Stands in for Discord's REST user lookup. Default: every user is a human. */
    userLookup?: (userId: string) => Promise<{ bot: boolean } | null>;
    /** Use the bot's own lookup (the real discord.js `UserManager.fetch`) instead of a stand-in. */
    productionLookup?: boolean;
    identityLookup?: import("../adapters/discord-bot.js").DiscordBotOptions["identityLookup"];
    /**
     * The identity request registry. Default: a fresh one per bot, so a test's stalled requests do
     * not reach the next test. "process" gives the bot the production default, the process-wide one.
     */
    identityRequests?: IdentityRequests | "process";
  } = {},
): TestBot {
  const adapter = fakeAdapter(id);
  const guildId = o.guildId ?? "guild-1";
  // Production uses the same 6 s for the filter's timeout and the registry's stall threshold; a test that shortens one shortens both.
  const identityRequests = o.identityRequests === "process" ? undefined : (o.identityRequests ?? new IdentityRequests({ stallMs: o.identityLookup?.lookupTimeoutMs }));
  const bot = new DiscordBot({
    id,
    token: `token-${id}`,
    guildId,
    channelId: "channel-1",
    election,
    log: quietLog,
    onHumanOpus: o.onHumanOpus ?? (() => undefined),
    onHumanClosed: o.onHumanClosed,
    bridgeUserIds: o.bridgeUserIds ?? (() => new Set()),
    voiceTarget: async () => {
      if (targetGate) await targetGate;
      return { guildId, channelId: "channel-1", adapterCreator: adapter.creator };
    },
    timing: { readyMs: 500, daveWaitMs: 300, pollMs: 5, watchdogMs: 5, daveGraceMs: 150, ...(o.now ? { now: o.now } : {}), ...o.timing },
    sessionId: o.sessionId ?? randomUUID(),
    userLookup: o.productionLookup ? undefined : (o.userLookup ?? (async () => ({ bot: false }))),
    identityLookup: o.identityLookup,
    identityRequests,
  });
  bot.userId = o.userId ?? `user-${id}`;
  seedGuild(bot.client, guildId, bot.userId);
  let targetGate: Promise<void> | null = null;
  const inChannel = (userId: string) => bot.client.guilds.cache.get(guildId)?.voiceStates.cache.get(userId)?.channelId === "channel-1";
  /** Speakers with an SSRC are in the channel on real Discord; tests that move people say so explicitly. */
  const withVoice = (h: ReadyHandle): ReadyHandle => {
    const map = h.mapUser.bind(h);
    h.mapUser = (userId, ssrc) => {
      if (t.autoVoice && !inChannel(userId)) t.voice(userId, "channel-1");
      map(userId, ssrc);
    };
    return h;
  };
  const t: TestBot = {
    bot,
    adapter,
    ready: [],
    autoReady: true,
    reuseDave: false,
    autoVoice: true,
    identityRequests,
    voice: (userId, channelId, vo) => voiceStateUpdate(bot.client, guildId, userId, channelId, vo),
    latest: () => t.ready[t.ready.length - 1],
    completePending() {
      const conn = bot.voiceConnection;
      if (!conn || conn.state.status !== "signalling" || t.ready.some((h) => h.conn === conn)) return null;
      const h = withVoice(makeReady(conn, { userId: bot.userId, protocolVersion: o.protocolVersion }));
      t.ready.push(h);
      return h;
    },
    holdTarget() {
      let release!: () => void;
      targetGate = new Promise<void>((r) => (release = r));
      return () => {
        targetGate = null;
        release();
      };
    },
    async join(opts = {}) {
      const joined = bot.join({ receive: opts.receive ?? false });
      joined.catch(() => undefined);
      await joined;
      return t.latest();
    },
  };
  // Every join payload brings that connection up, the way Discord's voice server update would.
  adapter.onJoin = () =>
    queueMicrotask(() => {
      const conn = bot.voiceConnection;
      if (!t.autoReady || !conn || conn.state.status !== "signalling" || t.ready.some((h) => h.conn === conn)) return;
      t.ready.push(withVoice(makeReady(conn, { userId: bot.userId, protocolVersion: o.protocolVersion, reuse: t.reuseDave ? t.latest() : undefined })));
    });
  return t;
}
