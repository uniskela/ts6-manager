import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientDirectory } from "./client-directory.js";
import { FRAME_BYTES } from "./constants.js";
import { DiscordToTsPipeline } from "./discord-to-ts.js";
import { FrameMixer } from "./frame-mixer.js";
import { preferredOrder } from "./ids.js";
import { createOpusCodec, type OpusCodec } from "./opus.js";
import { opusFrames, splitOpusPacket } from "./opus-packet.js";
import { mixFrames, toneFrame } from "./pcm.js";
import { ReceiverElection } from "./receiver-election.js";
import { SlotRouter } from "./slot-router.js";
import { TsToDiscordPipeline, type DiscordSendSink } from "./ts-to-discord.js";

const HALF = FRAME_BYTES / 2; // 10 ms of stereo s16le

/** A 20 ms-frame tone cut into `ms`-long chunks, the way a decoder would hand it over. */
function toneChunks(totalMs: number, chunkMs: number, freq = 440): Buffer[] {
  const whole = Buffer.concat(Array.from({ length: totalMs / 20 }, (_, i) => toneFrame(freq, i * 960)));
  const bytes = (chunkMs / 20) * FRAME_BYTES;
  return Array.from({ length: whole.length / bytes }, (_, i) => whole.subarray(i * bytes, (i + 1) * bytes));
}

describe("PCM frame handling in the mixer: nothing is silently truncated or padded", () => {
  it("a 40 ms decode is delivered as two whole 20 ms frames, in order and unaltered", () => {
    const m = new FrameMixer<null>();
    const [forty] = toneChunks(40, 40);
    m.push("a", forty, null, 0);
    const first = m.tick()!;
    const second = m.tick()!;
    assert.ok(first && second, "both halves are delivered");
    assert.deepEqual(first.pcm, forty.subarray(0, FRAME_BYTES));
    assert.deepEqual(second.pcm, forty.subarray(FRAME_BYTES));
    assert.equal(m.tick(), null);
  });

  it("a 60 ms decode is three frames and is not dropped by the per-source bound", () => {
    const m = new FrameMixer<null>(() => true, 2);
    const [sixty] = toneChunks(60, 60);
    m.push("a", sixty, null, 0);
    const out = [m.tick(), m.tick(), m.tick()];
    assert.ok(out.every((o) => o !== null));
    assert.deepEqual(Buffer.concat(out.map((o) => o!.pcm)), sixty);
  });

  it("two 10 ms decodes make one 20 ms frame with no gap between them", () => {
    const m = new FrameMixer<null>();
    const [a, b] = toneChunks(20, 10);
    m.push("a", a, null, 0);
    assert.equal(m.tick(), null, "10 ms is not yet a whole frame; nothing is padded early");
    m.push("a", b, null, 10);
    assert.deepEqual(m.tick()!.pcm, Buffer.concat([a, b]));
  });

  it("the partial tail is zero-padded only when the speaker ends, and that is counted", () => {
    const m = new FrameMixer<null>();
    const [a] = toneChunks(20, 10); // the first 10 ms of a tone
    m.push("a", a, null, 0);
    assert.equal(m.tick(), null);
    m.endSource("a");
    const tail = m.tick()!;
    assert.deepEqual(tail.pcm.subarray(0, HALF), a);
    assert.ok(tail.pcm.subarray(HALF).every((b) => b === 0));
    assert.equal(m.paddedTails, 1);
  });

  it("rejects PCM that is not whole stereo samples instead of mixing garbage", () => {
    const m = new FrameMixer<null>();
    m.push("a", Buffer.alloc(FRAME_BYTES + 1), null, 0);
    assert.equal(m.droppedMalformed, 1);
    assert.equal(m.tick(), null);
  });

  it("mixFrames refuses a frame of the wrong size instead of truncating it", () => {
    assert.throws(() => mixFrames([Buffer.alloc(FRAME_BYTES * 2)]), RangeError);
    assert.throws(() => mixFrames([Buffer.alloc(HALF)]), RangeError);
  });
});

describe("longer Opus packets (real Opus)", () => {
  const enc = () => createOpusCodec("native");
  const encode = (ms: number) => enc().encode(Buffer.alloc(48 * ms * 4));

  it("splits a 40/60/120 ms multi-frame packet into whole 20 ms packets that each decode to 960 samples", () => {
    for (const ms of [40, 60, 120]) {
      const parts = splitOpusPacket(encode(ms));
      assert.equal(parts.kind, "frames", `${ms} ms is supported`);
      if (parts.kind !== "frames") return;
      assert.equal(parts.frames.length, ms / 20);
      for (const f of parts.frames) assert.equal(createOpusCodec("native").decode(f).length, FRAME_BYTES);
    }
  });

  it("passes a plain 20 ms packet through byte-identical", () => {
    const p = encode(20);
    const parts = splitOpusPacket(p);
    assert.equal(parts.kind, "frames");
    if (parts.kind === "frames") assert.deepEqual(parts.frames, [p]);
  });

  it("reports frames it cannot carry as unsupported, and garbage as invalid, never as a silent pass-through", () => {
    assert.equal(splitOpusPacket(encode(10)).kind, "unsupported");
    assert.equal(splitOpusPacket(Buffer.from([0x03, 0x00])).kind, "invalid");
    assert.equal(splitOpusPacket(Buffer.alloc(0)).kind, "invalid");
  });
});

/** A code-3 packet carrying `payloads` as frames of the given CELT configuration (16 = 2.5 ms, 17 = 5, 18 = 10). */
function code3(config: number, payloads: Buffer[], vbr: boolean, stereo = 1): Buffer {
  const lengthBytes = (n: number) => (n < 252 ? [n] : [252 + (n & 3), (n - (252 + (n & 3))) >> 2]);
  const head = [(config << 3) | (stereo << 2) | 3, (vbr ? 0x80 : 0) | payloads.length];
  const lengths = vbr ? payloads.slice(0, -1).flatMap((f) => lengthBytes(f.length)) : [];
  return Buffer.concat([Buffer.from([...head, ...lengths]), ...payloads]);
}

describe("sub-20 ms constituent frames are repacketised into 20 ms packets", () => {
  const unwrap = (r: ReturnType<typeof splitOpusPacket>) => {
    assert.equal(r.kind, "frames");
    return r.kind === "frames" ? r.frames : [];
  };

  it("the reviewer's valid 4 x 10 ms packet becomes two 20 ms packets that each decode to 20 ms", () => {
    const packet = Buffer.from("f704fffefffefffefffe", "hex");
    const out = unwrap(splitOpusPacket(packet));
    assert.equal(out.length, 2);
    for (const f of out) assert.equal(createOpusCodec("native").decode(f).length, FRAME_BYTES, "20 ms of audio each");
    assert.deepEqual(out.map((f) => f.toString("hex")), ["f5fffefffe", "f5fffefffe"], "the same two-frame packets the reviewer decoded");
  });

  it("real 10 ms Opus frames glued into one packet come out as decodable 20 ms packets with their payloads and order intact", () => {
    const codec = createOpusCodec("native");
    const tens = [1, 2, 3, 4, 5, 6].map((n) => codec.encode(toneFrame(300 * n, 0).subarray(0, HALF)));
    assert.ok(tens.every((p) => (p[0] & 3) === 0), "the encoder emits single-frame packets");
    const packet = code3(tens[0][0] >> 3, tens.map((p) => p.subarray(1)), true);
    const out = unwrap(splitOpusPacket(packet));
    assert.equal(out.length, 3);
    const decoder = createOpusCodec("native");
    for (const f of out) assert.equal(decoder.decode(f).length, FRAME_BYTES);
    assert.deepEqual(out.flatMap((f) => opusFrames(f)!), tens.map((p) => p.subarray(1)), "payload bytes and order are preserved");
  });

  it("every combination of frame length, count and layout keeps frame boundaries and payload bytes (seeded)", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n | 0;
    for (let round = 0; round < 300; round++) {
      const config = 16 + rand(3); // 2.5, 5 or 10 ms
      const per = [8, 4, 2][config - 16]; // frames per 20 ms
      const groups = 1 + rand(Math.min(6, Math.floor(48 / per)));
      const vbr = rand(2) === 1;
      const same = rand(5) === 0 ? 250 + rand(60) : rand(40); // CBR frames are all one length; 250+ exercises two-byte lengths
      const payloads = Array.from({ length: groups * per }, () => Buffer.from(Array.from({ length: vbr ? (rand(5) === 0 ? 250 + rand(60) : rand(40)) : same }, () => rand(256))));
      const packet = code3(config, payloads, vbr);
      if (groups * per * [2.5, 5, 10][config - 16] > 120) continue;
      const result = splitOpusPacket(packet);
      if (groups * per * [2.5, 5, 10][config - 16] === 20) {
        assert.deepEqual(unwrap(result), [packet], "an exact 20 ms packet is untouched");
        continue;
      }
      const out = unwrap(result);
      assert.equal(out.length, groups, `round ${round}: one packet per 20 ms`);
      const back: Buffer[] = [];
      for (const o of out) {
        assert.equal(o[0] >> 3, config, "same configuration");
        assert.equal((o[0] >> 2) & 1, 1, "same channel layout");
        const inner = opusFrames(o)!;
        assert.equal(inner.length, per, `round ${round}: ${per} frames in each output packet`);
        back.push(...inner);
      }
      assert.deepEqual(back, payloads, `round ${round}: payload bytes and boundaries preserved`);
    }
  });

  it("still reports what cannot be carried: a single short frame, a count that does not fill 20 ms, one 40/60 ms frame", () => {
    const frame = Buffer.from([1, 2, 3]);
    assert.deepEqual(splitOpusPacket(code3(18, [frame, frame, frame], true)), { kind: "unsupported", durationMs: 30 });
    assert.deepEqual(splitOpusPacket(Buffer.from([(18 << 3) | 0, 1, 2, 3])), { kind: "unsupported", durationMs: 10 });
    assert.deepEqual(splitOpusPacket(Buffer.from([(2 << 3) | 0, 1, 2, 3])), { kind: "unsupported", durationMs: 40 }); // SILK 40 ms
    assert.deepEqual(splitOpusPacket(Buffer.from([(3 << 3) | 0, 1, 2, 3])), { kind: "unsupported", durationMs: 60 }); // SILK 60 ms
  });
});

function recordingSink() {
  const frames: Buffer[] = [];
  const sink: DiscordSendSink = { sendOpus: (f) => frames.push(f), endSpeech: () => undefined };
  return { frames, sink };
}

function voicePacket(clid: number, opus: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt16BE(1, 0);
  h.writeUInt16BE(clid, 2);
  h[4] = 5;
  return Buffer.concat([h, opus]);
}

function tsSetup(users: number, codecFactory: () => OpusCodec = () => createOpusCodec("native")) {
  const directory = new ClientDirectory();
  const router = new SlotRouter(5);
  const sinks = new Map<string, ReturnType<typeof recordingSink>>();
  for (const id of ["overflow", "slot-0", "slot-1", "slot-2", "slot-3", "slot-4"]) sinks.set(id, recordingSink());
  for (let i = 0; i < users; i++) {
    directory.ingest({ name: "notifycliententerview", params: { ctid: "1", clid: String(10 + i), client_unique_identifier: `uid${i}`, client_nickname: `U${i}` } });
    router.join(`uid${i}`);
  }
  const pipe = new TsToDiscordPipeline({
    directory,
    router,
    sinks: new Map([...sinks].map(([k, v]) => [k as never, v.sink])),
    codecFactory,
    channelId: () => 1,
    ownClid: () => 99,
  });
  return { pipe, sinks };
}

describe("TeamSpeak to Discord slot path with longer packets", () => {
  it("a 40 ms packet reaches the slot bot as two 20 ms packets, not one packet played at the wrong speed", () => {
    const { pipe, sinks } = tsSetup(1);
    const forty = createOpusCodec("native").encode(Buffer.alloc(48 * 40 * 4));
    pipe.onVoice(voicePacket(10, forty), 0);
    const got = sinks.get("slot-0")!.frames;
    assert.equal(got.length, 2);
    for (const f of got) assert.equal(createOpusCodec("native").decode(f).length, FRAME_BYTES);
  });

  it("a valid 4 x 10 ms packet reaches the slot bot as two 20 ms packets and is not counted as unsupported", () => {
    const { pipe, sinks } = tsSetup(1);
    pipe.onVoice(voicePacket(10, Buffer.from("f704fffefffefffefffe", "hex")), 0);
    const got = sinks.get("slot-0")!.frames;
    assert.equal(got.length, 2);
    for (const f of got) assert.equal(createOpusCodec("native").decode(f).length, FRAME_BYTES);
    assert.equal(pipe.unsupportedFrames, 0);
  });

  it("slot path: a voice-stop is not a decode error; a malformed Opus packet is", () => {
    const { pipe, sinks } = tsSetup(1);
    const good = createOpusCodec("native").encode(Buffer.alloc(FRAME_BYTES));
    assert.equal(pipe.onVoice(voicePacket(10, good), 0).kind, "slot");
    assert.equal(pipe.onVoice(voicePacket(10, Buffer.alloc(0)), 20).kind, "end");
    assert.equal(pipe.decodeErrors, 0, "empty Opus is end-of-voice, not a decode failure");
    assert.equal(pipe.unsupportedFrames, 0);
    assert.deepEqual(pipe.onVoice(voicePacket(10, Buffer.from([0x03, 0x00])), 40), { kind: "dropped", reason: "undecodable" });
    assert.equal(pipe.decodeErrors, 1);
    assert.equal(pipe.unsupportedFrames, 0, "malformed framing is not an unsupported duration");
    assert.ok(sinks.get("slot-0")!.frames.length >= 1);
  });

  it("an unsupported duration is dropped and counted, never forwarded as a wrong-length frame", () => {
    const { pipe, sinks } = tsSetup(1);
    const ten = createOpusCodec("native").encode(Buffer.alloc(48 * 10 * 4));
    const r = pipe.onVoice(voicePacket(10, ten), 0);
    assert.equal(sinks.get("slot-0")!.frames.length, 0);
    assert.deepEqual(r, { kind: "dropped", reason: "unsupported-frame" });
    assert.equal(pipe.unsupportedFrames, 1);
  });
});

describe("a malformed Opus packet is contained at the network callback boundary", () => {
  const corrupt = Buffer.from([0x03, 0x00]); // code 3 with zero frames: the decoder throws

  it("overflow path: a corrupt packet is dropped, the speaker's decoder is reset, and other speakers continue", () => {
    const { pipe, sinks } = tsSetup(8);
    const e = [createOpusCodec("native"), createOpusCodec("native")];
    pipe.onVoice(voicePacket(15, e[0].encode(toneFrame(300, 0))), 0); // overflow speaker uid5
    pipe.onVoice(voicePacket(16, e[1].encode(toneFrame(600, 0))), 0); // overflow speaker uid6
    let result: unknown;
    assert.doesNotThrow(() => (result = pipe.onVoice(voicePacket(15, corrupt), 20)));
    assert.deepEqual(result, { kind: "dropped", reason: "undecodable" });
    assert.equal(pipe.decodeErrors, 1);
    pipe.onVoice(voicePacket(16, e[1].encode(toneFrame(600, 960))), 20); // another speaker keeps going
    pipe.onVoice(voicePacket(15, e[0].encode(toneFrame(300, 960))), 20); // and the affected one recovers
    pipe.tickOverflow(25);
    pipe.tickOverflow(45);
    assert.ok(sinks.get("overflow")!.frames.length >= 2, "overflow audio kept flowing");
  });

  it("overflow path: an encoder failure in the tick does not escape", () => {
    let calls = 0;
    const flaky: () => OpusCodec = () => {
      const real = createOpusCodec("native");
      return { ...real, encode: (p) => (++calls === 1 ? (() => { throw new Error("encoder blew up"); })() : real.encode(p)) };
    };
    const { pipe } = tsSetup(6, flaky);
    pipe.onVoice(voicePacket(15, createOpusCodec("native").encode(toneFrame(300, 0))), 0);
    assert.doesNotThrow(() => pipe.tickOverflow(5));
  });

  it("Discord path: a corrupt packet is dropped, only that user's decoder is reset, the other human continues", () => {
    const election = new ReceiverElection(preferredOrder(5));
    election.setState("slot-0", { healthy: true, inChannel: true });
    election.reconcile("t");
    const sent: Buffer[] = [];
    const made: OpusCodec[] = [];
    const pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => {
        const c = createOpusCodec("native");
        made.push(c);
        return c;
      },
      out: { sendVoice: (o) => sent.push(o), sendVoiceStop: () => undefined },
      bridgeUserIds: () => new Set(),
    });
    const e = [createOpusCodec("native"), createOpusCodec("native")];
    const g = election.generation;
    pipe.onDiscordOpus("slot-0", g, "h1", e[0].encode(toneFrame(440, 0)), 0);
    pipe.onDiscordOpus("slot-0", g, "h2", e[1].encode(toneFrame(900, 0)), 0);
    assert.doesNotThrow(() => pipe.onDiscordOpus("slot-0", g, "h1", corrupt, 20));
    assert.equal(pipe.decodeErrors, 1);
    pipe.onDiscordOpus("slot-0", g, "h2", e[1].encode(toneFrame(900, 960)), 20);
    pipe.onDiscordOpus("slot-0", g, "h1", e[0].encode(toneFrame(440, 960)), 20);
    pipe.tick(21);
    pipe.tick(41);
    assert.ok(sent.length >= 2, "TeamSpeak kept hearing the room");
    assert.equal(pipe.decoderCount, 2, "the failed decoder was replaced, not leaked");
  });
});

describe("Discord decoders are released (bounded memory under participant churn)", () => {
  function d2t() {
    const election = new ReceiverElection(preferredOrder(5));
    election.setState("slot-0", { healthy: true, inChannel: true });
    election.reconcile("t");
    let created = 0;
    let disposed = 0;
    const pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => {
        created += 1;
        const real = createOpusCodec("native");
        return { ...real, dispose: () => void disposed++ };
      },
      out: { sendVoice: () => undefined, sendVoiceStop: () => undefined },
      bridgeUserIds: () => new Set(),
    });
    return { election, pipe, live: () => created - disposed, created: () => created };
  }
  const packet = createOpusCodec("native").encode(toneFrame(440, 0));

  it("releasing a user (stream closed) disposes its decoder", () => {
    const { election, pipe, live } = d2t();
    pipe.onDiscordOpus("slot-0", election.generation, "h1", packet, 0);
    assert.equal(live(), 1);
    pipe.releaseUser("h1");
    assert.equal(live(), 0);
    assert.equal(pipe.decoderCount, 0);
  });

  it("without any close notification, idle decoders are swept so churn cannot grow memory", () => {
    const { election, pipe, live } = d2t();
    let now = 0;
    for (let i = 0; i < 2000; i++) {
      pipe.onDiscordOpus("slot-0", election.generation, `user-${i}`, packet, now);
      now += 20;
      pipe.tick(now);
    }
    assert.ok(live() < 500, `live decoders stay bounded under churn (was ${live()} after 2000 distinct users)`);
    assert.ok(pipe.decoderCount <= 256, "hard cap holds");
  });

  it("a teardown (new receiver generation) disposes every decoder", () => {
    const { election, pipe, live } = d2t();
    for (let i = 0; i < 5; i++) pipe.onDiscordOpus("slot-0", election.generation, `u${i}`, packet, 0);
    assert.equal(live(), 5);
    pipe.flush();
    assert.equal(live(), 0);
  });
});
