import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BETA_TS_NICKNAME, startListenerPresence } from "../lab/listener-presence.js";
import { TsSession } from "./ts-session.js";

const FLAG_UNENCRYPTED = 0x80;
const PT_VOICE = 0;
const PT_VOICE_WHISPER = 1;

/**
 * An S2C packet as the REAL Ts3Client parses it: MAC(8) + PId(2) + PT(1) + body. An unencrypted
 * packet on a client that has not finished crypto init is accepted without a signature check, which
 * lets the test drive the transport's own `handleIncomingPacket` instead of emitting by hand.
 */
function s2cPacket(packetType: number, body: Buffer): Buffer {
  const head = Buffer.alloc(8 + 3);
  head.writeUInt16BE(1, 8);
  head[10] = packetType | FLAG_UNENCRYPTED;
  return Buffer.concat([head, body]);
}

function voiceBody(clid: number, opus: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16BE(7, 0);
  h.writeUInt16BE(clid, 2);
  h[4] = 4;
  return Buffer.concat([h, opus]);
}

function inject(session: TsSession, packetType: number, body: Buffer): void {
  (session.client as unknown as { handleIncomingPacket(raw: Buffer): void }).handleIncomingPacket(s2cPacket(packetType, body));
}

describe("TsSession voice vs whisper (real Ts3Client packet path)", () => {
  it("forwards channel Voice and never forwards VoiceWhisper", () => {
    const session = new TsSession({ host: "127.0.0.1", port: 9987, nickname: "t" });
    const voice: Buffer[] = [];
    session.on("voice", (d: Buffer) => voice.push(d));

    inject(session, PT_VOICE, voiceBody(5, Buffer.from([1, 2, 3])));
    inject(session, PT_VOICE_WHISPER, voiceBody(6, Buffer.from([9, 9, 9])));

    assert.equal(voice.length, 1, "only the channel voice packet is forwarded");
    assert.equal(voice[0].readUInt16BE(2), 5);
    assert.equal(session.whisperDropped, 1, "the whisper is counted, not silently lost");
  });

  it("fails closed when the transport does not say which kind of packet it is", () => {
    const session = new TsSession({ host: "127.0.0.1", port: 9987, nickname: "t" });
    const voice: Buffer[] = [];
    session.on("voice", (d: Buffer) => voice.push(d));
    session.client.emit("voice", voiceBody(5, Buffer.from([1])));
    assert.equal(voice.length, 0);
    assert.equal(session.whisperDropped, 1);
  });
});

it("holds a refused presence update, retries the latest state, and detaches an in-flight update on stop", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const ts = new TsSession({ host: "127.0.0.1", port: 9987, nickname: BETA_TS_NICKNAME });
  t.mock.method(ts.client, "getClientId", () => 1);
  t.mock.method(ts.client, "getCurrentChannelId", () => 2);
  t.mock.method(ts.client, "getState", () => "connected");
  const send = t.mock.method(ts.client, "sendCommand", (_command: string) => undefined);
  const warnings: string[] = [];
  let count = 1;
  const stop = startListenerPresence(ts, () => count, (line) => warnings.push(line));
  t.after(stop);
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  };
  const reply = (id: string, code: string | undefined) => ts.client.emit("command", { name: "error", params: { id, return_code: code } });
  const sent = (i: number) => send.mock.calls[i].arguments[0];
  await advance(2_000);
  assert.match(sent(0), /^clientupdate client_nickname=\[DC\]/);
  reply("0", "unrelated");
  count = 2;
  await advance(2_000);
  assert.equal(send.mock.callCount(), 1, "an unrelated reply cannot release an in-flight update");
  reply("524", sent(0).split("return_code=")[1]);
  await Promise.resolve();
  assert.equal(warnings.length, 1);
  await advance(28_000);
  assert.equal(send.mock.callCount(), 1);
  count = 0;
  await advance(2_000);
  assert.ok(sent(1).startsWith(`clientupdate client_nickname=${BETA_TS_NICKNAME} `), "the held count is discarded");
  assert.equal(ts.client.listenerCount("command"), 2);
  stop();
  assert.equal(ts.client.listenerCount("command"), 1);
  assert.equal(ts.client.listenerCount("disconnected"), 0);
  count = 1;
  await advance(60_000);
  assert.equal(send.mock.callCount(), 2);
  assert.equal(warnings.length, 1);
});
