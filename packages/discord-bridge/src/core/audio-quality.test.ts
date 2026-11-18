/**
 * Read-only audio-quality counters: arrivals, stops, framing, gaps, mixer overflow, feed starvation.
 * Simulated packets only. No payloads are kept.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noteArrivalGap } from "./arrival-gap.js";
import { ClientDirectory } from "./client-directory.js";
import { ARRIVAL_GAP_MS, FRAME_BYTES } from "./constants.js";
import { DiscordToTsPipeline } from "./discord-to-ts.js";
import { FrameFeed } from "./frame-feed.js";
import { preferredOrder } from "./ids.js";
import { createOpusCodec } from "./opus.js";
import { toneFrame } from "./pcm.js";
import { ReceiverElection } from "./receiver-election.js";
import { SlotRouter } from "./slot-router.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "./ts-to-discord.js";

function voicePacket(clid: number, opus: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16BE(1, 0);
  h.writeUInt16BE(clid, 2);
  h[4] = 5;
  return Buffer.concat([h, opus]);
}

function tsSetup(users: number) {
  const directory = new ClientDirectory();
  const router = new SlotRouter(5);
  const sinks = new Map<string, { frames: Buffer[]; ends: number; sink: DiscordSendSink }>();
  for (const id of ["overflow", "slot-0", "slot-1", "slot-2", "slot-3", "slot-4"]) {
    const frames: Buffer[] = [];
    let ends = 0;
    sinks.set(id, { frames, ends, sink: { sendOpus: (f) => frames.push(f), endSpeech: () => void ends++ } });
  }
  for (let i = 0; i < users; i++) {
    directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: String(10 + i), client_unique_identifier: `uid${i}`, client_nickname: `U${i}` } });
    router.join(`uid${i}`);
  }
  const pipe = new TsToDiscordPipeline({
    directory,
    router,
    sinks: new Map([...sinks].map(([k, v]) => [k as never, v.sink])),
    codecFactory: () => createOpusCodec("native"),
    channelId: () => 1,
    ownClid: () => 99,
  });
  return { pipe, sinks };
}

function d2tPipe() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("t");
  const sent: Buffer[] = [];
  const stops = { n: 0 };
  const pipe = new DiscordToTsPipeline({
    election,
    codecFactory: () => createOpusCodec("native"),
    out: { sendVoice: (o) => sent.push(o), sendVoiceStop: () => void (stops.n += 1) },
    bridgeUserIds: () => new Set(),
  });
  return { pipe, sent, stops, generation: election.generation };
}

describe("arrival-gap helper", () => {
  it("counts only a second arrival more than 40 ms after the first, and forget clears it", () => {
    const last = new Map<string, number>();
    assert.equal(noteArrivalGap(last, "a", 0), false);
    assert.equal(noteArrivalGap(last, "a", ARRIVAL_GAP_MS), false);
    assert.equal(noteArrivalGap(last, "a", ARRIVAL_GAP_MS * 2 + 1), true);
    last.delete("a");
    assert.equal(noteArrivalGap(last, "a", 10_000), false);
  });
});

describe("TeamSpeak to Discord quality counters", () => {
  it("splits received, forwarded, voice-stop, invalid framing and gaps; teardown does not invent a gap", () => {
    const { pipe, sinks } = tsSetup(1);
    const good = createOpusCodec("native").encode(Buffer.alloc(FRAME_BYTES));
    assert.equal(pipe.onVoice(voicePacket(10, good), 0).kind, "slot");
    assert.equal(pipe.received, 1);
    assert.equal(pipe.forwarded, 1);
    assert.equal(pipe.voiceStops, 0);
    assert.equal(pipe.onVoice(voicePacket(10, Buffer.alloc(0)), 20).kind, "end");
    assert.equal(pipe.voiceStops, 1);
    assert.equal(pipe.received, 2);
    assert.equal(pipe.arrivalGaps, 0, "a stop clears the last arrival");
    assert.equal(pipe.onVoice(voicePacket(10, good), 80).kind, "slot");
    assert.equal(pipe.arrivalGaps, 0);
    assert.equal(pipe.onVoice(voicePacket(10, good), 140).kind, "slot");
    assert.equal(pipe.arrivalGaps, 1);
    assert.deepEqual(pipe.onVoice(voicePacket(10, Buffer.from([0x03, 0x00])), 160), { kind: "dropped", reason: "undecodable" });
    assert.equal(pipe.invalidFrames, 1);
    assert.equal(pipe.decoderFailures, 0);
    assert.equal(pipe.decodeErrors, 1);
    pipe.forget("uid0");
    assert.equal(pipe.onVoice(voicePacket(10, good), 500).kind, "slot");
    assert.equal(pipe.arrivalGaps, 1, "forget drops the last arrival so the next packet is not a gap");
    assert.ok(sinks.get("slot-0")!.frames.length >= 3);
  });

  it("counts a decoder failure on the overflow path and stops counting after dispose", () => {
    const { pipe } = tsSetup(6);
    const good = createOpusCodec("native").encode(toneFrame(300, 0));
    assert.equal(pipe.onVoice(voicePacket(15, good), 0).kind, "overflow");
    assert.deepEqual(pipe.onVoice(voicePacket(15, Buffer.from([0x03, 0x00])), 20), { kind: "dropped", reason: "undecodable" });
    assert.equal(pipe.decoderFailures, 1);
    assert.equal(pipe.invalidFrames, 0);
    assert.equal(pipe.decodeErrors, 1);
    const received = pipe.received;
    pipe.dispose();
    assert.equal(pipe.onVoice(voicePacket(15, good), 40).kind, "dropped");
    assert.equal(pipe.received, received);
  });
});

describe("Discord to TeamSpeak quality counters", () => {
  it("counts incoming, forwarded, encode failure, idle voice-stop, a gap, and flush teardown", () => {
    const { pipe, sent, stops, generation } = d2tPipe();
    const enc = createOpusCodec("native");
    const frame = enc.encode(toneFrame(440, 0));
    pipe.onDiscordOpus("slot-0", generation, "h1", frame, 0);
    pipe.tick(5);
    assert.equal(pipe.incoming, 1);
    assert.equal(pipe.framesSent, 1);
    assert.equal(sent.length, 1);
    pipe.tick(25);
    pipe.tick(45);
    pipe.tick(65);
    assert.equal(pipe.voiceStops, 1);
    assert.equal(stops.n, 1);
    pipe.tick(85);
    assert.equal(pipe.voiceStops, 1, "further idle ticks do not re-stop");
    pipe.onDiscordOpus("slot-0", generation, "h1", enc.encode(toneFrame(440, 960)), 200);
    assert.equal(pipe.arrivalGaps, 0, "release on idle cleared the last arrival");
    pipe.onDiscordOpus("slot-0", generation, "h1", enc.encode(toneFrame(440, 1920)), 260);
    assert.equal(pipe.arrivalGaps, 1);
    pipe.flush();
    pipe.onDiscordOpus("slot-0", generation, "h1", enc.encode(toneFrame(440, 2880)), 400);
    assert.equal(pipe.arrivalGaps, 1, "flush drops last arrivals");
  });

  it("counts an encode failure without incrementing framesSent", () => {
    const election = new ReceiverElection(preferredOrder(5));
    election.setState("slot-0", { healthy: true, inChannel: true });
    election.reconcile("t");
    let encodes = 0;
    const pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => {
        const real = createOpusCodec("native");
        return { ...real, encode: (p) => (++encodes === 1 ? (() => { throw new Error("encode"); })() : real.encode(p)) };
      },
      out: { sendVoice: () => undefined, sendVoiceStop: () => undefined },
      bridgeUserIds: () => new Set(),
    });
    pipe.onDiscordOpus("slot-0", election.generation, "h1", createOpusCodec("native").encode(toneFrame(440, 0)), 0);
    assert.doesNotThrow(() => pipe.tick(5));
    assert.equal(pipe.encodeErrors, 1);
    assert.equal(pipe.framesSent, 0);
    pipe.dispose();
    pipe.onDiscordOpus("slot-0", election.generation, "h1", createOpusCodec("native").encode(toneFrame(440, 960)), 20);
    assert.equal(pipe.incoming, 1, "dispose refuses further incoming");
  });
});

describe("FrameFeed starvation", () => {
  it("counts a read more than 40 ms after the last offer when the queue is empty, and finish does not", async () => {
    const feed = new FrameFeed();
    feed.offer(Buffer.from([1]));
    const first = feed.read();
    assert.ok(first);
    assert.equal(first[0], 1);
    assert.equal(feed.starved, 0);
    await new Promise((r) => setTimeout(r, 50));
    feed._read();
    assert.equal(feed.starved, 1);
    feed.finish();
    assert.equal(feed.starved, 1, "finish does not count as starvation");
  });
});
