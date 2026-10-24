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
import { DiscordBot } from "../adapters/discord-bot.js";
import type { BotId } from "../core/ids.js";
import { createLogger } from "../core/redact.js";
import type { ReceiverElection } from "../core/receiver-election.js";

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
}

/** One Discord client's voice adapter. Each bot must get its own and only ever use its own. */
export function fakeAdapter(name: string): FakeAdapter {
  const a: FakeAdapter = {
    name,
    sent: [],
    destroyed: false,
    creator: () => ({
      sendPayload: (payload: unknown) => {
        a.sent.push(payload as FakeAdapter["sent"][number]);
        return true;
      },
      destroy: () => {
        a.destroyed = true;
      },
    }),
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
}

/** Drive a real VoiceConnection to Ready with a DAVE session on top of the fake native session. */
export function makeReady(conn: VoiceConnection, o: { userId?: string; protocolVersion?: number; ready?: boolean } = {}): ReadyHandle {
  const davey = new FakeDavey();
  davey.ready = o.ready ?? true;
  const dave = new DAVESession(o.protocolVersion ?? 1, o.userId ?? "bot", "channel", {});
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
  };
}

/** The player pads the end of every resource with Opus silence frames; they are never DAVE-encrypted. */
export const isSilence = (p: Buffer) => p.equals(Buffer.from([0xf8, 0xff, 0xfe]));

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
  /** Join and drive the new connection to Ready (DAVE established unless told otherwise). */
  join(o?: { receive?: boolean; ready?: boolean; protocolVersion?: number }): Promise<ReadyHandle>;
}

export function testBot(
  id: BotId,
  election: ReceiverElection,
  o: { guildId?: string; sessionId?: string; onHumanOpus?: (bot: BotId, gen: number, user: string, opus: Buffer) => void; userId?: string; bridgeUserIds?: () => ReadonlySet<string> } = {},
): TestBot {
  const adapter = fakeAdapter(id);
  const guildId = o.guildId ?? "guild-1";
  const bot = new DiscordBot({
    id,
    token: `token-${id}`,
    guildId,
    channelId: "channel-1",
    election,
    log: quietLog,
    onHumanOpus: o.onHumanOpus ?? (() => undefined),
    bridgeUserIds: o.bridgeUserIds ?? (() => new Set()),
    voiceTarget: async () => ({ guildId, channelId: "channel-1", adapterCreator: adapter.creator }),
    timing: { readyMs: 500, daveWaitMs: 300, pollMs: 5, watchdogMs: 5, daveGraceMs: 150 },
    sessionId: o.sessionId ?? randomUUID(),
  });
  bot.userId = o.userId ?? `user-${id}`;
  const t: TestBot = {
    bot,
    adapter,
    ready: [],
    async join(opts = {}) {
      const before = bot.voiceConnection;
      const joining = bot.join({ receive: opts.receive ?? false });
      joining.catch(() => undefined);
      const conn = await waitFor(() => (bot.voiceConnection && bot.voiceConnection !== before ? bot.voiceConnection : bot.voiceConnection?.state.status === "ready" ? bot.voiceConnection : null), 1000, `${id} connection`);
      let handle = t.ready.find((h) => h.conn === conn);
      if (!handle && (opts.ready ?? true)) {
        handle = makeReady(conn, { userId: bot.userId, protocolVersion: opts.protocolVersion });
        t.ready.push(handle);
      }
      await joining;
      return handle ?? t.ready[t.ready.length - 1];
    },
  };
  return t;
}
