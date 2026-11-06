import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceConnectionStatus, type VoiceConnection } from "@discordjs/voice";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { testBot, tick, waitFor, type TestBot } from "../testing/fake-voice.js";

const newElection = () => new ReceiverElection(preferredOrder(5));
const joinPayloads = (t: TestBot) => t.adapter.sent.filter((p) => p.d.channel_id !== null).length;
const outcome = (p: Promise<void>) => p.then(() => null, (e: Error & { code?: string }) => e);
const exhausted = (e: (Error & { code?: string }) | null) => e?.code === "REBUILD_BUDGET_EXHAUSTED";
/** The library reports a lost connection the way the gateway does: by moving it to Disconnected. */
const disconnect = (conn: VoiceConnection) => {
  (conn as unknown as { state: unknown }).state = { ...conn.state, status: VoiceConnectionStatus.Disconnected, reason: 0 };
};

/**
 * The recovery budget is charged by the attempt that builds or replaces a connection, not by
 * whatever the connection's health flag says when the attempt started. Every test here uses the
 * real VoiceConnection (and its real `rejoin()`); only the network edge is faked.
 */
describe("a failure-driven rebuild is charged exactly once, by the attempt that makes it (real VoiceConnection)", () => {
  it("charges a rejoin the gateway refuses: the library reports Disconnected from inside rejoin() itself", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    const h1 = await t.join({ receive: false });
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));

    t.adapter.refuseNext = 1; // the real rejoin() sends nothing, emits Disconnected synchronously, returns false
    const h2 = await t.join({ receive: true });

    assert.notEqual(h2.conn, h1.conn, "the refused connection was replaced");
    assert.equal(h1.conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.ok(unhealthy.length >= 1, "the synchronous Disconnected was reported");
    assert.equal(t.bot.rejoins, 1, "one token for the one rebuild, however many signals announced the failure");
    assert.equal(t.bot.healthy, true, "and one token is enough to complete it");

    // The budget is really spent: the next failure cannot rebuild again.
    h2.conn.destroy(false);
    assert.ok(exhausted(await outcome(t.bot.join({ receive: false }))), "a second failure-driven rebuild is refused");
    assert.equal(t.ready.length, 2);
    assert.equal(t.bot.rejoins, 1);
    await t.bot.destroy();
  });

  it("cannot be bypassed by a connection that dies while the target is being resolved (six connections for zero tokens before)", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    await t.join({ receive: false });
    const outcomes: (Error | null)[] = [];
    for (let round = 0; round < 5; round++) {
      const release = t.holdTarget();
      const joining = outcome(t.bot.join({ receive: false })); // begins with a healthy connection
      await tick(10); // ...and is now waiting for the target
      const live = t.bot.voiceConnection;
      if (live && live.state.status !== VoiceConnectionStatus.Destroyed) live.destroy(false); // the gateway destroys it
      release();
      outcomes.push(await joining);
    }
    assert.equal(outcomes[0], null, "the first rebuild is within the budget");
    assert.ok(outcomes.slice(1).every(exhausted), `every later attempt is refused (got ${outcomes.map((e) => e?.message ?? "ok").join(" | ")})`);
    assert.equal(t.ready.length, 2, "the first connection plus exactly one recovery");
    assert.equal(t.bot.rejoins, 1);
    await t.bot.destroy();
  });

  it("charges a connection that drops to Disconnected while the target is being resolved", async () => {
    const t = testBot("slot-0", newElection(), { timing: { readyMs: 60, maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    const h1 = await t.join({ receive: false });
    const release = t.holdTarget();
    const joining = outcome(t.bot.join({ receive: false }));
    await tick(10);
    disconnect(h1.conn);
    release();
    await joining; // it may not come back (the fake does not answer a rejoin of a used connection): the charge is what counts
    assert.equal(t.bot.rejoins, 1);
    assert.ok(exhausted(await outcome(t.bot.join({ receive: false }))), "and the budget is spent");
    await t.bot.destroy();
  });

  it("charges one token for a refused rejoin of an already failed connection, not one for the rejoin and one for the replacement", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    const h1 = await t.join({ receive: false });
    disconnect(h1.conn); // failed: a rebuild is owed
    t.adapter.refuseNext = 1; // the rejoin is refused, so a new connection is built in the same attempt
    const h2 = await t.join({ receive: false });
    assert.notEqual(h2.conn, h1.conn);
    assert.equal(t.bot.rejoins, 1, "one attempt, one token");
    assert.equal(t.bot.healthy, true);
    await t.bot.destroy();
  });

  it("charges a connection that cannot be constructed, so retrying construction is bounded", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    t.adapter.failCreate = new Error("adapter unavailable");
    const results: (Error | null)[] = [];
    for (let i = 0; i < 5; i++) results.push(await outcome(t.bot.join({ receive: false })));
    assert.match(results[0]?.message ?? "", /adapter unavailable/, "the first (planned) attempt fails and is free");
    assert.match(results[1]?.message ?? "", /adapter unavailable/, "the retry spends the one token");
    assert.ok(results.slice(2).every(exhausted), "nothing is attempted beyond the budget");
    assert.equal(t.bot.rejoins, 1);
    assert.equal(t.bot.voiceConnection, null, "no half-built connection is left behind");
    assert.equal(t.ready.length, 0);
    await t.bot.destroy();
  });

  it("does not charge intentional operations: a planned join, planned rejoins that the gateway accepts, leave and join", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    for (let i = 0; i < 6; i++) await t.join({ receive: i % 2 === 0 }); // the first builds, the rest are real rejoin() calls
    assert.equal(t.ready.length, 1, "rejoin() on a healthy connection builds nothing");
    for (let i = 0; i < 4; i++) {
      t.bot.leave();
      await t.join({ receive: false });
    }
    assert.equal(t.ready.length, 5);
    assert.equal(t.bot.rejoins, 0, "no recovery token was spent");
    await t.bot.destroy();
  });

  it("does not report health over a failure that arrived while the join was waiting for DAVE, and the next attempt pays", async () => {
    const t = testBot("slot-0", newElection(), { protocolVersion: 0, timing: { daveWaitMs: 400, maxRecoveries: 2, recoveryWindowMs: 60_000 } });
    const joining = outcome(t.bot.join({ receive: false })); // Ready, but DAVE is not negotiated yet
    await waitFor(() => t.ready.length === 1, 500, "a Ready connection waiting for DAVE");
    t.bot.markUnhealthy("voice disconnected"); // the connection drops while the join polls
    t.latest().setDave({ protocolVersion: 1 }); // and DAVE would now look fine
    const error = await joining;
    assert.match(error?.message ?? "", /failed while the join was completing/);
    assert.equal(t.bot.healthy, false, "a join that lost its connection does not leave the bot healthy");
    assert.equal(t.bot.voiceConnection, null);
    assert.equal(t.bot.rejoins, 0, "the failed attempt itself was planned, so it was free");
    const retry = await outcome(t.bot.join({ receive: false })); // new connections here never negotiate DAVE: only the charge matters
    assert.match(retry?.message ?? "", /DAVE not negotiated/);
    assert.equal(t.bot.rejoins, 1, "the rebuild that followed was charged");
    await t.bot.destroy();
  });

  it("an exhausted budget stops all failure-driven connection creation, and time alone frees one attempt", async () => {
    let now = 1_000_000;
    const t = testBot("slot-0", newElection(), { now: () => now, timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    const h1 = await t.join({ receive: false });
    h1.conn.destroy(false);
    const h2 = await t.join({ receive: false }); // the one allowed rebuild
    const sent = joinPayloads(t);
    h2.conn.destroy(false);
    for (let i = 0; i < 10; i++) {
      assert.ok(exhausted(await outcome(t.bot.join({ receive: i % 2 === 0 }))), `attempt ${i + 1} is refused`);
    }
    t.adapter.refuseNext = 3; // and a refusing gateway changes nothing
    assert.ok(exhausted(await outcome(t.bot.join({ receive: false }))));
    assert.equal(t.ready.length, 2);
    assert.equal(joinPayloads(t), sent, "nothing reached the gateway");
    assert.equal(t.bot.voiceConnection, null, "and no connection was created");
    t.adapter.refuseNext = 0;

    now += 60_001; // the spent token leaves the window
    const h3 = await t.join({ receive: false });
    assert.equal(h3.conn.state.status, VoiceConnectionStatus.Ready);
    assert.equal(t.ready.length, 3);
    await t.bot.destroy();
  });
});
