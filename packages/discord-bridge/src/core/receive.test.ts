import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { daveEnforced, readDaveInfo } from "./dave-gate.js";
import { FrameFeed } from "./frame-feed.js";
import { preferredOrder } from "./ids.js";
import { ReceiveSupervisor } from "./receive-supervisor.js";
import { ReceiverElection } from "./receiver-election.js";

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

  it("delivers frames tagged with the generation they were opened under", () => {
    const election = electionWith("slot-0");
    const got: number[] = [];
    const src = new PassThrough({ objectMode: true });
    const sup = new ReceiveSupervisor({
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
