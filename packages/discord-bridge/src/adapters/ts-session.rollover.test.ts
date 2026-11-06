import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveKeyNonce, eaxEncrypt, DUMMY_KEY, DUMMY_NONCE } from "../../.vendor/tslib/crypto.js";
import { TsSession } from "./ts-session.js";
import { SlotRouter } from "../core/slot-router.js";
import { TsToDiscordPipeline } from "../core/ts-to-discord.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { preferredOrder } from "../core/ids.js";
import { testBot, waitFor } from "../testing/fake-voice.js";

// Synthetic negotiated material only. No socket, login, server or credentials.
const iv = Buffer.alloc(64, 0x51);
const body = Buffer.from([0, 1, 0, 5, 4, 0xfc, 1, 2]);
function packet(id: number, generation: number, type = 0, payload = body): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt16BE(id);
  header[2] = type;
  const { key, nonce } = deriveKeyNonce(true, id, generation, type, iv);
  const { mac, ciphertext } = eaxEncrypt(key, nonce, header, payload);
  return Buffer.concat([mac, header, ciphertext]);
}

function harness() {
  const session = new TsSession({ host: "127.0.0.1", port: 9987, nickname: "test" });
  const client = session.client as unknown as {
    cryptoInitComplete: boolean;
    ivStruct: Buffer;
    inGenerationCounter: Uint32Array;
    handleIncomingPacket(raw: Buffer): void;
  };
  client.cryptoInitComplete = true;
  client.ivStruct = iv;
  const heard: Buffer[] = [];
  session.on("voice", (b: Buffer) => heard.push(b));
  return { session, client, heard, inject: (p: Buffer) => client.handleIncomingPacket(p) };
}

describe("encrypted TeamSpeak receive packet-ID rollover", () => {
  it("receives a complete 65536-packet generation and the next generation without wall-clock waiting", () => {
    const h = harness();
    for (let sequence = 0; sequence < 65540; sequence++) h.inject(packet(sequence & 0xffff, sequence >>> 16));
    assert.equal(h.heard.length, 65540);
  });

  it("keeps emitting voice after the server advances generation at 65535 -> 0", () => {
    const h = harness();
    h.inject(packet(65534, 0));
    h.inject(packet(65535, 0));
    assert.equal(h.heard.length, 2, "pre-rollover encryption is valid");
    h.inject(packet(0, 1));
    h.inject(packet(1, 1));
    h.inject(packet(200, 1));
    assert.equal(h.heard.length, 5, "new-generation voice must reach the bridge");
    assert.ok(h.heard.every((b) => b.equals(body)));
  });

  it("handles a lost boundary packet and a delayed previous-generation packet without rolling back", () => {
    const h = harness();
    h.inject(packet(65530, 0));
    h.inject(packet(7, 1)); // exact wrap and its first packets were lost
    h.inject(packet(65531, 0)); // delayed old UDP packet
    h.inject(packet(3, 2)); // another rollover
    // If accepting the delayed gen-0 packet rolled us back, gen-2 would be unreachable here.
    h.inject(packet(9, 1));
    h.inject(packet(4, 2));
    assert.equal(h.heard.length, 6);
  });

  it("never advances generation from a forged packet and keeps packet types independent", () => {
    const h = harness();
    const forged = packet(0, 1);
    forged[0] ^= 1;
    h.inject(forged);
    h.inject(packet(2, 2));
    assert.equal(h.heard.length, 0, "forgery cannot advance state and admit generation 2");
    h.inject(packet(40, 0));
    assert.equal(h.heard.length, 1, "failed authentication cannot move the counter");
    h.inject(packet(1, 1, 1)); // whisper has a separate generation and stays excluded
    h.inject(packet(3, 2));
    assert.equal(h.heard.length, 1, "whisper cannot advance the voice generation");
    h.inject(packet(41, 0));
    h.inject(packet(0, 1));
    h.inject(packet(1, 1));
    assert.equal(h.heard.length, 4);
    assert.equal(h.session.whisperDropped, 1);
    h.inject(packet(2, 3)); // no unbounded search through missing generations
    assert.equal(h.heard.length, 4);
  });

  it("keeps the existing unencrypted and dummy-key paths from advancing real-key generation", () => {
    const h = harness();
    const header = Buffer.from([0xff, 0xff, 0x80]);
    h.inject(Buffer.concat([Buffer.alloc(8), header, body]));
    const dummyHeader = Buffer.from([0, 0, 0]);
    const dummy = eaxEncrypt(DUMMY_KEY, DUMMY_NONCE, dummyHeader, body);
    h.inject(Buffer.concat([dummy.mac, dummyHeader, dummy.ciphertext]));
    assert.equal(h.heard.length, 2);
    assert.equal(h.client.inGenerationCounter[0], 0);
    h.inject(packet(2, 2));
    assert.equal(h.heard.length, 2, "neither compatibility path may advance real crypto state");
    h.inject(packet(3, 0));
    assert.equal(h.heard.length, 3);

    const initial = new TsSession({ host: "127.0.0.1", port: 9987, nickname: "test" });
    let beforeInit = 0;
    initial.on("voice", () => beforeInit++);
    (initial.client as unknown as { handleIncomingPacket(p: Buffer): void }).handleIncomingPacket(
      Buffer.concat([dummy.mac, dummyHeader, dummy.ciphertext]),
    );
    assert.equal(beforeInit, 1, "pre-negotiation dummy handling is unchanged");
  });

  it("does not overflow the 32-bit generation or search beyond adjacent generations", () => {
    const h = harness();
    h.client.inGenerationCounter[0] = 0xffffffff;
    h.inject(packet(65535, 0xffffffff));
    assert.doesNotThrow(() => h.inject(packet(0, 0)));
    h.inject(packet(65534, 0xfffffffe));
    assert.equal(h.heard.length, 2);
    assert.equal(h.client.inGenerationCounter[0], 0xffffffff);
  });

  it("carries post-rollover voice through the real directory, router, pipeline, player and DAVE dispatch", async () => {
    const t = testBot("slot-0", new ReceiverElection(preferredOrder(5)));
    try {
      const ready = await t.join();
      const h = harness();
      h.session.client.emit("command", { name: "notifycliententerview", params: {
        clid: "5", ctid: "1", client_unique_identifier: "synthetic-speaker", client_nickname: "Test",
      } });
      const router = new SlotRouter(5);
      router.join("synthetic-speaker");
      const pipeline = new TsToDiscordPipeline({ directory: h.session.directory, router,
        sinks: new Map([["slot-0", t.bot]]), ownClid: () => 9, channelId: () => 1,
        codecFactory: () => { throw new Error("slot passthrough never decodes"); },
      });
      h.session.on("voice", (b: Buffer) => pipeline.onVoice(b, performance.now()));
      h.inject(packet(65535, 0));
      await waitFor(() => ready.networking.wire.some((p) => p.subarray(4).equals(body.subarray(5))), 500, "pre-wrap dispatch");
      const nextBody = Buffer.from([0, 2, 0, 5, 4, 0xfc, 8, 9]);
      h.inject(packet(0, 1, 0, nextBody));
      await waitFor(() => ready.networking.wire.some((p) => p.subarray(4).equals(nextBody.subarray(5))), 500, "post-wrap dispatch");
      assert.equal(pipeline.forwarded, 2);
      assert.equal(t.bot.healthy, true);
      pipeline.dispose();
    } finally {
      await t.bot.destroy();
    }
  });
});
