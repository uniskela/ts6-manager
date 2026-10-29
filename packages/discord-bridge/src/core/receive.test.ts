import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { daveEnforced, readDaveInfo } from "./dave-gate.js";
import { MAX_QUEUED_FRAMES } from "./constants.js";
import { FrameFeed } from "./frame-feed.js";
import { preferredOrder } from "./ids.js";
import { ReceiveSupervisor } from "./receive-supervisor.js";
import { ReceiverElection } from "./receiver-election.js";

/** Supervisor tests that are not about admission: every user holds a valid admission. */
function everyoneAdmitted() {
  return { admit: (userId: string) => ({ userId, id: 0, session: 0 }), admitted: () => true };
}

function electionWith(...bots: ("slot-0" | "slot-1")[]) {
  const e = new ReceiverElection(preferredOrder(5));
  for (const b of bots) e.setState(b, { healthy: true, inChannel: true });
  e.reconcile("test");
  return e;
}

describe("ReceiveSupervisor", () => {
  it("opens streams only for the admitted generation and counts subscriptions", () => {
    const election = electionWith("slot-0");
    const frames: [string, number][] = [];
    const sup = new ReceiveSupervisor({
      ...everyoneAdmitted(),
      bot: "slot-0", generation: election.generation, election,
      subscribe: () => new PassThrough(),
      onFrame: (u, _o, g) => frames.push([u, g]),
      activeSpeakers: () => [], onNeedRecovery: () => undefined,
    });
    assert.equal(sup.open("h1"), true);
    assert.equal(sup.open("h1"), false, "no duplicate stream for the same user");
    assert.equal(election.status().subscribersByBot["slot-0"], 1);
    sup.closeAll();
    assert.equal(election.status().subscribersByBot["slot-0"], 0);
  });

  it("a stale generation is rejected and tears the supervisor down", () => {
    const election = electionWith("slot-0", "slot-1");
    const stale = election.generation;
    election.fail("slot-0", "killed");
    const sup = new ReceiveSupervisor({
      ...everyoneAdmitted(),
      bot: "slot-0", generation: stale, election,
      subscribe: () => { throw new Error("must not subscribe"); },
      onFrame: () => undefined, activeSpeakers: () => [], onNeedRecovery: () => undefined,
    });
    assert.equal(sup.open("h1"), false);
    assert.equal(election.status().subscribeRejections, 1);
    assert.deepEqual(election.duplicateReceivers(), []);
  });

  it("repeated decrypt errors request a rejoin (DAVE recovery path)", async () => {
    const election = electionWith("slot-0");
    let rejoin = 0;
    let t = 0;
    const streams: PassThrough[] = [];
    const sup = new ReceiveSupervisor({
      ...everyoneAdmitted(),
      bot: "slot-0", generation: election.generation, election,
      subscribe: () => { const s = new PassThrough(); streams.push(s); return s; },
      onFrame: () => undefined, activeSpeakers: () => [], onNeedRecovery: () => void rejoin++, now: () => (t += 100),
    });
    for (let i = 0; i < 3; i++) {
      assert.equal(sup.open("h1"), true);
      streams[i].destroy(new Error("UnencryptedWhenPassthroughDisabled"));
      await new Promise((r) => setImmediate(r)); // 'error' is emitted on the next tick
    }
    assert.equal(sup.decryptErrors, 3);
    assert.equal(rejoin, 1);
    assert.equal(sup.openCount, 0);
  });

  it("drops a packet whose admission has ended, closes that stream, and re-opens the user only under a new admission", () => {
    const election = electionWith("slot-0");
    let current: { userId: string; id: number; session: number } | null = { userId: "h1", id: 1, session: 0 };
    const valid = new Set<object>([current]);
    const streams: PassThrough[] = [];
    const got: number[] = [];
    const closed: string[] = [];
    const sup = new ReceiveSupervisor({
      bot: "slot-0", generation: election.generation, election,
      subscribe: () => { const s = new PassThrough({ objectMode: true }); streams.push(s); return s; },
      admit: () => current,
      admitted: (a) => valid.has(a),
      onFrame: (_u, _o, _g, a) => got.push(a.id),
      onUserClosed: (u) => closed.push(u),
      activeSpeakers: () => [], onNeedRecovery: () => undefined,
    });
    assert.equal(sup.open("h1"), true);
    streams[0].write(Buffer.from([1]));
    valid.clear(); // the admission ended: the user left
    streams[0].write(Buffer.from([2]));
    assert.deepEqual(got, [1], "the packet after the end of the admission was dropped");
    assert.equal(sup.admissionDropped, 1);
    assert.equal(sup.openCount, 0, "and the stream was closed");
    assert.equal(streams[0].destroyed, true);
    assert.deepEqual(closed, ["h1"]);
    current = null;
    assert.equal(sup.open("h1"), false, "not re-opened without an admission");
    current = { userId: "h1", id: 2, session: 0 };
    valid.add(current);
    assert.equal(sup.open("h1"), true, "re-opened under a new one");
    assert.equal(sup.admissionOf("h1"), current);
    streams[1].write(Buffer.from([3]));
    assert.deepEqual(got, [1, 2]);
    sup.closeAll();
  });

  it("closeUser closes one user's stream and leaves the others open", () => {
    const election = electionWith("slot-0");
    const sup = new ReceiveSupervisor({
      ...everyoneAdmitted(),
      bot: "slot-0", generation: election.generation, election,
      subscribe: () => new PassThrough(),
      onFrame: () => undefined, activeSpeakers: () => [], onNeedRecovery: () => undefined,
    });
    sup.open("h1");
    sup.open("h2");
    sup.closeUser("h1");
    sup.closeUser("nobody");
    assert.equal(sup.openCount, 1);
    assert.equal(sup.admissionOf("h1"), undefined);
    assert.ok(sup.admissionOf("h2"));
    sup.closeAll();
  });

  it("delivers frames tagged with the generation they were opened under", () => {
    const election = electionWith("slot-0");
    const got: number[] = [];
    const src = new PassThrough({ objectMode: true });
    const sup = new ReceiveSupervisor({
      ...everyoneAdmitted(),
      bot: "slot-0", generation: election.generation, election, subscribe: () => src,
      onFrame: (_u, _o, g) => got.push(g), activeSpeakers: () => [], onNeedRecovery: () => undefined,
    });
    sup.open("h1");
    src.write(Buffer.from([1]));
    assert.deepEqual(got, [election.generation]);
  });
});

describe("FrameFeed", () => {
  it("is bounded: a burst keeps only the newest frames", async () => {
    const feed = new FrameFeed(3);
    for (let i = 0; i < 10; i++) feed.offer(Buffer.from([i]));
    assert.equal(feed.queued, 3);
    assert.equal(feed.dropped, 7);
    const got: number[] = [];
    feed.on("data", (b: Buffer) => got.push(b[0]));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(got, [7, 8, 9]);
  });
  it("counts the stream's own buffer: a stalled consumer never holds more than the budget, oldest dropped first", async () => {
    const feed = new FrameFeed(); // default budget
    feed.read(); // the consumer has attached, so the stream starts filling its own buffer too
    for (let i = 0; i < 100; i++) feed.offer(Buffer.from([i]));
    assert.ok(feed.queued <= MAX_QUEUED_FRAMES && feed.readableLength <= 1, `retained ${feed.queued} frames (${feed.readableLength} in the stream)`);
    assert.equal(feed.dropped, 100 - MAX_QUEUED_FRAMES);
    const got: number[] = [];
    for (let b = feed.read(); b !== null; b = feed.read()) got.push((b as Buffer)[0]);
    await new Promise((r) => setImmediate(r));
    for (let b = feed.read(); b !== null; b = feed.read()) got.push((b as Buffer)[0]);
    assert.deepEqual(got, [96, 97, 98, 99], "only the newest frames survive; stale audio is not played");
  });
  it("keeps the budget while a polling consumer (the AudioPlayer's pattern) falls behind", async () => {
    const feed = new FrameFeed();
    const got: number[] = [];
    feed.on("readable", () => {
      // Consume one frame per 'readable', like a player that takes a packet per tick.
      const b = feed.read();
      if (b) got.push((b as Buffer)[0]);
    });
    for (let i = 0; i < 60; i++) {
      feed.offer(Buffer.from([i]));
      assert.ok(feed.queued <= MAX_QUEUED_FRAMES, `retained ${feed.queued} at frame ${i}`);
    }
    await new Promise((r) => setImmediate(r));
    for (let b = feed.read(); b !== null; b = feed.read()) got.push((b as Buffer)[0]);
    assert.ok(got.every((v, i) => i === 0 || v > got[i - 1]), "order is preserved");
    assert.equal(got.at(-1), 59, "the newest frame is the last one delivered");
  });
  it("ends after finish()", async () => {
    const feed = new FrameFeed();
    feed.offer(Buffer.from([1]));
    feed.offer(Buffer.from([2]));
    feed.finish();
    const chunks: Buffer[] = [];
    for await (const c of feed) chunks.push(c as Buffer);
    assert.equal(chunks.length, 2, "queued frames are delivered before the stream ends");
  });
});

describe("DAVE gate", () => {
  const conn = (dave: unknown, code = 4, status = "ready") => ({ state: { status, networking: { state: { code, dave } } } }) as never;
  it("requires an established DAVE session; protocol 0 or a not-ready session is refused", () => {
    assert.equal(daveEnforced(readDaveInfo(conn({ protocolVersion: 1, session: { ready: true } }))), true);
    assert.equal(daveEnforced(readDaveInfo(conn({ protocolVersion: 0, session: { ready: true } }))), false, "passthrough channel");
    assert.equal(daveEnforced(readDaveInfo(conn({ protocolVersion: 1, session: { ready: false } }))), false, "MLS group not ready");
    assert.equal(daveEnforced(readDaveInfo(conn(undefined))), false, "no DAVE object");
    assert.equal(daveEnforced(readDaveInfo(conn({ protocolVersion: 1, session: { ready: true } }, 3))), false, "networking not ready");
    assert.equal(daveEnforced(readDaveInfo(conn({ protocolVersion: 1, session: { ready: true } }, 4, "signalling"))), false);
  });
});
