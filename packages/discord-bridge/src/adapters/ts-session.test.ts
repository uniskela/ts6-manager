import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
