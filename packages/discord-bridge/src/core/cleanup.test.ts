import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientDirectory } from "./client-directory.js";
import { DiscordToTsPipeline } from "./discord-to-ts.js";
import { ReceiverElection } from "./receiver-election.js";
import { createOpusCodec, type OpusCodec } from "./opus.js";
import { preferredOrder } from "./ids.js";
import { toneFrame } from "./pcm.js";
import { SlotRouter } from "./slot-router.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "./ts-to-discord.js";

function voicePacket(clid: number, opus: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16BE(1, 0);
  h.writeUInt16BE(clid, 2);
  h[4] = 5;
  return Buffer.concat([h, opus]);
}

const sink = () => {
  const frames: Buffer[] = [];
  const s: DiscordSendSink = { sendOpus: (f) => frames.push(f), endSpeech: () => undefined };
  return { frames, s };
};

function t2dWith(users: number) {
  const directory = new ClientDirectory();
  const router = new SlotRouter(5);
  const sinks = new Map(["overflow", "slot-0", "slot-1", "slot-2", "slot-3", "slot-4"].map((id) => [id, sink()]));
  for (let i = 0; i < users; i++) {
    directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: String(10 + i), client_unique_identifier: `uid${i}`, client_nickname: `U${i}` } });
    router.join(`uid${i}`);
  }
  let made = 0;
  const live: OpusCodec[] = [];
  const codecFactory = () => {
    made += 1;
    const c = createOpusCodec("native");
    live.push(c);
    return c;
  };
  const pipe = new TsToDiscordPipeline({
    directory,
    router,
    sinks: new Map([...sinks].map(([k, v]) => [k as never, v.s])),
    codecFactory,
    channelId: () => 1,
    ownClid: () => 99,
  });
  return { pipe, sinks, directory, router, made: () => made };
}

describe("a disposed pipeline is terminal", () => {
  const frame = (n: number) => createOpusCodec("native").encode(toneFrame(440, n * 960));

  it("TeamSpeak to Discord: queued overflow audio is discarded, nothing is sent afterwards, and no codec is recreated", () => {
    const { pipe, sinks, made } = t2dWith(6); // uid5 is on overflow
    for (let n = 0; n < 3; n++) pipe.onVoice(voicePacket(15, frame(n)), n * 20); // three frames queued, not yet mixed
    const before = made();
    assert.ok(before >= 1, "an overflow decoder exists");
    pipe.dispose();
    for (let t = 100; t < 400; t += 20) pipe.tickOverflow(t);
    assert.equal(sinks.get("overflow")!.frames.length, 0, "the frames queued before dispose were not played afterwards");
    assert.equal(pipe.decoderCount, 0);
    const r = pipe.onVoice(voicePacket(15, frame(9)), 500);
    assert.deepEqual(r, { kind: "dropped", reason: "disposed" });
    pipe.tickOverflow(520);
    assert.equal(made(), before, "no decoder or encoder was created after dispose");
    assert.equal(sinks.get("overflow")!.frames.length, 0);
  });

  it("TeamSpeak to Discord: a partial 10 ms tail is not padded and played after dispose", () => {
    const { pipe, sinks } = t2dWith(6);
    const ten = createOpusCodec("native").encode(toneFrame(440, 0).subarray(0, 960 * 2)); // 10 ms
    pipe.onVoice(voicePacket(15, ten), 0);
    pipe.onVoice(voicePacket(15, Buffer.alloc(0)), 10); // end of speech would pad the tail into a frame
    pipe.dispose();
    for (let t = 20; t < 200; t += 20) pipe.tickOverflow(t);
    assert.equal(sinks.get("overflow")!.frames.length, 0);
  });

  it("Discord to TeamSpeak: queued audio is discarded, nothing is sent afterwards, and no codec is recreated", () => {
    const election = new ReceiverElection(preferredOrder(5));
    election.setState("slot-0", { healthy: true, inChannel: true });
    election.reconcile("test");
    let made = 0;
    const sent: Buffer[] = [];
    const pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => (made += 1, createOpusCodec("native")),
      out: { sendVoice: (o) => sent.push(o), sendVoiceStop: () => undefined },
      bridgeUserIds: () => new Set(),
    });
    for (let n = 0; n < 3; n++) pipe.onDiscordOpus("slot-0", election.generation, "human", frame(n), n * 20);
    const before = made;
    pipe.dispose();
    for (let t = 100; t < 400; t += 20) pipe.tick(t);
    assert.equal(sent.length, 0, "frames queued before dispose were not sent afterwards");
    assert.equal(pipe.decoderCount, 0);
    pipe.onDiscordOpus("slot-0", election.generation, "human", frame(9), 500);
    pipe.tick(520);
    assert.equal(made, before, "no decoder or encoder was created after dispose");
    assert.equal(sent.length, 0);
  });

  it("a disposed native codec cannot be used again", () => {
    const c = createOpusCodec("native");
    const pcm = toneFrame(440, 0);
    assert.doesNotThrow(() => c.encode(pcm));
    c.dispose();
    assert.throws(() => c.encode(pcm), /disposed/);
    assert.throws(() => c.decode(Buffer.from([0xfc, 1, 1])), /disposed/);
    assert.doesNotThrow(() => c.dispose(), "dispose is idempotent");
  });
});

describe("routing telemetry is bounded by who is present, not by who has ever spoken", () => {
  const slotPacket = Buffer.from([0xf8, 0xff, 0xfe]);

  it("40 000 departed identities leave no routing entries behind", () => {
    const { pipe, directory, router } = t2dWith(0);
    for (let i = 0; i < 40_000; i++) {
      const uid = `departed-${i}`;
      directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: "10", client_unique_identifier: uid } });
      router.join(uid);
      assert.equal(pipe.onVoice(voicePacket(10, slotPacket), i).kind, "slot");
      for (const c of router.leave(uid)) pipe.forget(c.uniqueId);
      directory.ingest({ name: "notifyclientleftview", params: { clid: "10" } });
    }
    const retained = [...pipe.routed.values()].reduce((n, m) => n + m.size, 0);
    assert.equal(retained, 0, `retained ${retained} routing entries for identities that left`);
    assert.equal(pipe.routedIdentities, 0);
  });

  it("an identity that is still present keeps its evidence, and one that moved slot is not counted twice", () => {
    const { pipe, router } = t2dWith(2);
    pipe.onVoice(voicePacket(10, slotPacket), 0);
    pipe.onVoice(voicePacket(11, slotPacket), 0);
    assert.equal(pipe.routedIdentities, 2);
    for (const c of router.leave("uid0")) pipe.forget(c.uniqueId);
    assert.equal(pipe.routedIdentities, 1, "only uid0, who left, was forgotten");
    assert.equal(pipe.routed.get("slot-1")!.get("uid1"), 1);
  });
});
