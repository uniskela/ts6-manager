import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientDirectory } from "./client-directory.js";
import { DiscordToTsPipeline } from "./discord-to-ts.js";
import { FrameMixer } from "./frame-mixer.js";
import { preferredOrder } from "./ids.js";
import { createOpusCodec } from "./opus.js";
import { goertzelPower, mixFrames, rms, toneFrame } from "./pcm.js";
import { ReceiverElection } from "./receiver-election.js";
import { createLogger, redact, registerSecret } from "./redact.js";
import { SlotRouter } from "./slot-router.js";
import { parseS2CVoice } from "./ts-voice-packet.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "./ts-to-discord.js";

function voicePacket(clid: number, opus: Buffer, codec = 5): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16BE(1, 0);
  h.writeUInt16BE(clid, 2);
  h[4] = codec;
  return Buffer.concat([h, opus]);
}

describe("parseS2CVoice", () => {
  it("parses VId, speaker clid, codec and Opus", () => {
    const p = parseS2CVoice(voicePacket(42, Buffer.from([1, 2, 3])))!;
    assert.equal(p.clid, 42);
    assert.equal(p.codec, 5);
    assert.deepEqual([...p.opus], [1, 2, 3]);
  });
  it("treats an empty payload as end-of-voice and rejects other codecs and short packets", () => {
    assert.equal(parseS2CVoice(voicePacket(7, Buffer.alloc(0)))!.opus.length, 0);
    assert.equal(parseS2CVoice(voicePacket(7, Buffer.from([1]), 0)), null);
    assert.equal(parseS2CVoice(Buffer.alloc(4)), null);
  });
});

describe("SlotRouter", () => {
  it("fills slots first, then overflow, and gives each uniqueId one destination", () => {
    const r = new SlotRouter(5);
    for (let i = 0; i < 8; i++) r.join(`u${i}`);
    assert.equal(r.destinationFor("u0"), "slot-0");
    assert.equal(r.destinationFor("u4"), "slot-4");
    assert.deepEqual(r.overflowMembers(), ["u5", "u6", "u7"]);
    for (let i = 0; i < 8; i++) {
      const inSlot = [0, 1, 2, 3, 4].some((s) => r.slotOccupant(s) === `u${i}`);
      assert.equal(inSlot !== r.overflowMembers().includes(`u${i}`), true, `u${i} is in exactly one place`);
    }
  });
  it("keeps the slot across a rename (keyed on uniqueId) and re-join is idempotent", () => {
    const r = new SlotRouter(5);
    r.join("a");
    assert.deepEqual(r.join("a"), []);
    assert.equal(r.destinationFor("a"), "slot-0");
  });
  it("promotes the longest-waiting overflow uniqueId when a slot frees, removing it from overflow first", () => {
    const r = new SlotRouter(2);
    ["a", "b", "c", "d"].forEach((u) => r.join(u));
    const changes = r.leave("a");
    assert.deepEqual(changes, [
      { uniqueId: "a", from: "slot-0", to: null },
      { uniqueId: "c", from: "overflow", to: "slot-0" },
    ]);
    assert.equal(r.destinationFor("c"), "slot-0");
    assert.deepEqual(r.overflowMembers(), ["d"]);
  });
  it("overflow carries audio only while it has members", () => {
    const r = new SlotRouter(1);
    r.join("a");
    assert.equal(r.botCarriesAudio("overflow"), false);
    r.join("b");
    assert.equal(r.botCarriesAudio("overflow"), true);
    r.leave("b");
    assert.equal(r.botCarriesAudio("overflow"), false);
  });
});

describe("ReceiverElection", () => {
  const make = () => {
    const e = new ReceiverElection(preferredOrder(5));
    return e;
  };
  it("elects slot 0 when the TeamSpeak channel is empty and the others are out of the channel", () => {
    const e = make();
    e.setState("slot-0", { healthy: true, inChannel: true });
    assert.equal(e.reconcile("start"), "slot-0");
  });
  it("prefers overflow once it is in the channel and bumps the generation", () => {
    const e = make();
    e.setState("slot-0", { healthy: true, inChannel: true });
    e.reconcile("start");
    const g1 = e.generation;
    e.setState("overflow", { healthy: true, inChannel: true });
    assert.equal(e.reconcile("overflow joined"), "overflow");
    assert.ok(e.generation > g1);
  });
  it("does not move the receiver when a non-receiver bot recovers or fails", () => {
    const e = make();
    for (const b of ["slot-0", "slot-1", "slot-2"] as const) e.setState(b, { healthy: true, inChannel: true });
    e.reconcile("start");
    const g = e.generation;
    e.fail("slot-2", "x");
    assert.equal(e.receiver, "slot-0");
    assert.equal(e.generation, g);
  });
  it("never elects overflow when it is not allowed in the channel", () => {
    const e = make();
    e.setState("overflow", { healthy: true, inChannel: false });
    e.setState("slot-1", { healthy: true, inChannel: true });
    assert.equal(e.reconcile("start"), "slot-1");
  });
  it("on receiver failure tears down, bumps the generation and elects exactly one successor", () => {
    const e = make();
    for (const b of ["slot-0", "slot-1"] as const) e.setState(b, { healthy: true, inChannel: true });
    e.reconcile("start");
    const oldGen = e.generation;
    const events: string[] = [];
    e.on("teardown", (x) => events.push(`teardown:${x.bot}`));
    e.on("elected", (x) => events.push(`elected:${x.bot}`));
    assert.equal(e.fail("slot-0", "killed"), "slot-1");
    assert.deepEqual(events, ["teardown:slot-0", "elected:slot-1"]);
    assert.ok(e.generation > oldGen + 1, "monotonic across teardown and election");
    assert.equal(e.admitFrame("slot-0", oldGen), false);
    assert.equal(e.admitFrame("slot-1", e.generation), true);
  });
  it("fails closed when no bot is healthy and rejects a stale or non-holder subscribe", () => {
    const e = make();
    e.setState("slot-0", { healthy: true, inChannel: true });
    e.reconcile("start");
    const stale = e.generation;
    assert.equal(e.fail("slot-0", "dead"), null);
    assert.equal(e.admitSubscribe("slot-0", stale), false);
    assert.equal(e.status().subscribeRejections, 1);
  });
  it("reports a duplicate receiver when a non-holder keeps human subscriptions", () => {
    const e = make();
    for (const b of ["slot-0", "slot-1"] as const) e.setState(b, { healthy: true, inChannel: true });
    e.reconcile("start");
    e.noteSubscription("slot-0", 1);
    assert.deepEqual(e.duplicateReceivers(), []);
    e.noteSubscription("slot-1", 1);
    assert.deepEqual(e.duplicateReceivers(), ["slot-1"]);
  });
});

describe("FrameMixer", () => {
  it("bounds each source queue and counts overflow drops", () => {
    const m = new FrameMixer<null>(() => true, 2);
    for (let i = 0; i < 5; i++) m.push("a", toneFrame(440, i * 960), null, i);
    assert.equal(m.queuedFrames(), 2);
    assert.equal(m.droppedOverflow, 3);
  });
  it("re-checks admission at mix time so a queued stale frame is dropped", () => {
    let live = true;
    const m = new FrameMixer<{ g: number }>(() => live);
    m.push("a", toneFrame(440, 0), { g: 1 }, 0);
    live = false;
    assert.equal(m.tick(), null);
    assert.equal(m.droppedAdmit, 1);
  });
  it("attenuates instead of clipping a loud sum", () => {
    const loud = toneFrame(440, 0, 0.9);
    const out = mixFrames([loud, loud, loud]);
    let peak = 0;
    for (let i = 0; i < out.length / 2; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
    assert.ok(peak <= 32767);
    assert.ok(rms(out) > 0.3, "still audible after attenuation");
  });
});

describe("redaction", () => {
  it("scrubs Discord-shaped tokens, bearer secrets, key=value secrets and registered secrets", () => {
    // Built at run time so no token-shaped literal sits in the repository for secret scanners.
    const token = ["MTA1Njc4OTAxMjM0NTY3ODkw", "GaBcDe", "abcdefghijklmnopqrstuvwxyz0123456789"].join(".");
    registerSecret("hunter2-super-secret");
    const lines: string[] = [];
    const log = createLogger("t", (l) => lines.push(l));
    log.info(`login ${token} Bearer abc.def.ghi token=xyz123 and hunter2-super-secret`);
    const line = lines[0];
    assert.ok(!line.includes(token) && !line.includes("hunter2") && !line.includes("xyz123") && !line.includes("abc.def.ghi"));
    assert.equal(redact("plain text stays"), "plain text stays");
  });
});

describe("ClientDirectory", () => {
  it("keys on uniqueId and inherits shared ctid across a piped enter-view", () => {
    const d = new ClientDirectory();
    d.ingest({
      name: "notifycliententerview",
      params: { ctid: "5", clid: "2", client_unique_identifier: "uidA", client_nickname: "A" },
      groups: [
        { ctid: "5", clid: "2", client_unique_identifier: "uidA", client_nickname: "A" },
        { clid: "3", client_unique_identifier: "uidB", client_nickname: "B" },
      ],
    });
    assert.equal(d.byClientId(3)!.channelId, 5);
    assert.deepEqual(d.inChannel(5).map((c) => c.uniqueId).sort(), ["uidA", "uidB"]);
    d.ingest({ name: "notifyclientupdated", params: { clid: "2", client_nickname: "Renamed" } });
    assert.equal(d.byClientId(2)!.uniqueId, "uidA");
    d.ingest({ name: "notifyclientmoved", params: { clid: "3", ctid: "9" } });
    assert.deepEqual(d.inChannel(5).map((c) => c.uniqueId), ["uidA"]);
    d.ingest({ name: "notifyclientleftview", params: { clid: "2" } });
    assert.equal(d.byClientId(2), undefined);
  });
});

function recordingSink() {
  const frames: Buffer[] = [];
  let ended = 0;
  const sink: DiscordSendSink = { sendOpus: (f) => frames.push(f), endSpeech: () => void ended++ };
  return { sink, frames, ended: () => ended };
}

describe("TsToDiscordPipeline (simulated Discord sinks, real Opus)", () => {
  const codec = () => createOpusCodec("auto");

  function setup(users: number) {
    const directory = new ClientDirectory();
    const router = new SlotRouter(5);
    const sinks = new Map<string, ReturnType<typeof recordingSink>>();
    for (const id of ["overflow", "slot-0", "slot-1", "slot-2", "slot-3", "slot-4"]) sinks.set(id, recordingSink());
    for (let i = 0; i < users; i++) {
      directory.ingest({
        name: "notifycliententerview",
        params: { ctid: "1", clid: String(10 + i), client_unique_identifier: `uid${i}`, client_nickname: `U${i}` },
      });
      router.join(`uid${i}`);
    }
    const pipe = new TsToDiscordPipeline({
      directory,
      router,
      sinks: new Map([...sinks].map(([k, v]) => [k as never, v.sink])),
      codecFactory: codec,
      channelId: () => 1,
      ownClid: () => 99,
    });
    return { pipe, sinks, router };
  }

  it("two simultaneous speakers land on two different bots with no crosstalk (tone analysis)", () => {
    const { pipe, sinks } = setup(2);
    const encs = [codec(), codec()]; // each speaker has its own stateful encoder, like a real client
    const freqs = [440, 1000];
    for (let f = 0; f < 25; f++) {
      for (let s = 0; s < 2; s++) {
        pipe.onVoice(voicePacket(10 + s, encs[s].encode(toneFrame(freqs[s], f * 960))), f * 20);
      }
    }
    for (const [bot, own, other] of [["slot-0", 440, 1000], ["slot-1", 1000, 440]] as const) {
      const rec = sinks.get(bot)!;
      assert.equal(rec.frames.length, 25);
      const dec = codec(); // one decoder per stream: Opus decoding is stateful
      const pcm = Buffer.concat(rec.frames.map((f) => dec.decode(f)));
      assert.ok(goertzelPower(pcm, own) > goertzelPower(pcm, other) * 1000, `${bot} carries only ${own} Hz`);
    }
    for (const bot of ["slot-2", "slot-3", "slot-4", "overflow"]) assert.equal(sinks.get(bot)!.frames.length, 0);
    assert.equal(pipe.routed.get("slot-0")!.size, 1);
    assert.equal(pipe.routed.get("slot-1")!.size, 1);
  });

  it("sends nobody to a second destination: passthrough Opus is byte-identical on its own bot only", () => {
    const { pipe, sinks } = setup(2);
    const payload = createOpusCodec("auto").encode(toneFrame(500, 0));
    pipe.onVoice(voicePacket(10, payload), 0);
    assert.deepEqual(sinks.get("slot-0")!.frames[0], payload);
    assert.equal(sinks.get("slot-1")!.frames.length, 0);
  });

  it("mixes the three overflow speakers of an eight-user channel onto the overflow bot only", () => {
    const { pipe, sinks } = setup(8);
    const encs = Array.from({ length: 8 }, () => codec());
    for (let f = 0; f < 10; f++) {
      for (let s = 5; s < 8; s++) pipe.onVoice(voicePacket(10 + s, encs[s].encode(toneFrame(300 + s * 100, f * 960))), f * 20);
      pipe.tickOverflow(f * 20 + 5);
    }
    assert.equal(sinks.get("overflow")!.frames.length, 10);
    for (let s = 0; s < 5; s++) assert.equal(sinks.get(`slot-${s}`)!.frames.length, 0);
    const dec = codec();
    const pcm = Buffer.concat(sinks.get("overflow")!.frames.map((f) => dec.decode(f)));
    for (const hz of [800, 900, 1000]) assert.ok(goertzelPower(pcm, hz) > goertzelPower(pcm, 2500) * 100, `${hz} Hz present in the mix`);
  });

  it("drops own voice, unknown speakers and speakers outside the mapped channel", () => {
    const { pipe } = setup(1);
    assert.deepEqual(pipe.onVoice(voicePacket(99, Buffer.from([1])), 0), { kind: "dropped", reason: "own-voice" });
    assert.deepEqual(pipe.onVoice(voicePacket(55, Buffer.from([1])), 0), { kind: "dropped", reason: "unknown-speaker" });
  });

  it("excludes music bots by uniqueId", () => {
    const directory = new ClientDirectory();
    directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: "20", client_unique_identifier: "music", client_nickname: "M" } });
    const router = new SlotRouter(5);
    router.join("music");
    const pipe = new TsToDiscordPipeline({
      directory, router, sinks: new Map(), codecFactory: codec, channelId: () => 1, ownClid: () => 99, excludedUniqueIds: new Set(["music"]),
    });
    assert.deepEqual(pipe.onVoice(voicePacket(20, Buffer.from([1])), 0), { kind: "dropped", reason: "excluded" });
  });
});

describe("DiscordToTsPipeline (simulated receiver, real Opus)", () => {
  function setup() {
    const election = new ReceiverElection(preferredOrder(5));
    for (const b of ["slot-0", "slot-1"] as const) election.setState(b, { healthy: true, inChannel: true });
    election.reconcile("start");
    const sent: Buffer[] = [];
    let stops = 0;
    const bridgeIds = new Set(["bot-a", "bot-b"]);
    const pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => createOpusCodec("auto"),
      out: { sendVoice: (o) => sent.push(o), sendVoiceStop: () => void stops++ },
      bridgeUserIds: () => bridgeIds,
    });
    return { election, pipe, sent, stops: () => stops };
  }

  it("mixes two humans into one shared TeamSpeak stream", () => {
    const { election, pipe, sent } = setup();
    const encs = [createOpusCodec("auto"), createOpusCodec("auto")];
    for (let f = 0; f < 10; f++) {
      pipe.onDiscordOpus("slot-0", election.generation, "h1", encs[0].encode(toneFrame(440, f * 960)), f * 20);
      pipe.onDiscordOpus("slot-0", election.generation, "h2", encs[1].encode(toneFrame(1000, f * 960)), f * 20);
      pipe.tick(f * 20 + 3);
    }
    assert.equal(sent.length, 10, "one mixed frame per tick, not one per speaker");
    const dec = createOpusCodec("auto");
    const pcm = Buffer.concat(sent.map((o) => dec.decode(o)));
    assert.ok(goertzelPower(pcm, 440) > goertzelPower(pcm, 2500) * 100);
    assert.ok(goertzelPower(pcm, 1000) > goertzelPower(pcm, 2500) * 100);
  });

  it("never forwards audio from a bridge bot (no re-forwarding)", () => {
    const { election, pipe, sent } = setup();
    const enc = createOpusCodec("auto");
    pipe.onDiscordOpus("slot-0", election.generation, "bot-a", enc.encode(toneFrame(440, 0)), 0);
    pipe.tick(1);
    assert.equal(sent.length, 0);
    assert.equal(pipe.selfSourceDrops, 1);
  });

  it("kill receiver mid-speech: stale generation frames never reach TeamSpeak, successor sends one copy", () => {
    const { election, pipe, sent } = setup();
    const enc = createOpusCodec("auto");
    const oldGen = election.generation;
    // Human speaking through slot-0 (the receiver). Two frames are queued, then the receiver dies.
    for (let f = 0; f < 2; f++) pipe.onDiscordOpus("slot-0", oldGen, "h1", enc.encode(toneFrame(440, f * 960)), f * 20);
    election.fail("slot-0", "killed");
    assert.equal(election.receiver, "slot-1");
    // A late callback from the dead bot, plus the queued frames: all must be fenced.
    pipe.onDiscordOpus("slot-0", oldGen, "h1", enc.encode(toneFrame(440, 3 * 960)), 60);
    pipe.tick(61);
    assert.equal(sent.length, 0, "no stale frame reached the TeamSpeak mixer");
    assert.ok(election.status().fenceDrops >= 1);
    assert.ok(pipe.fenceDroppedAtMix >= 2, "queued frames were dropped at mix time");
    // The successor subscribes under the new generation and TeamSpeak hears exactly one copy.
    for (let f = 4; f < 8; f++) {
      pipe.onDiscordOpus("slot-1", election.generation, "h1", enc.encode(toneFrame(440, f * 960)), f * 20);
      pipe.onDiscordOpus("slot-0", oldGen, "h1", enc.encode(toneFrame(440, f * 960)), f * 20); // zombie duplicate
      pipe.tick(f * 20 + 2);
    }
    assert.equal(sent.length, 4, "one frame per tick, the zombie copy never doubled it");
  });

  it("sends end-of-voice after the humans go quiet", () => {
    const { election, pipe, stops } = setup();
    const enc = createOpusCodec("auto");
    pipe.onDiscordOpus("slot-0", election.generation, "h1", enc.encode(toneFrame(440, 0)), 0);
    for (let i = 0; i < 5; i++) pipe.tick(i * 20);
    assert.equal(stops(), 1);
  });
});
