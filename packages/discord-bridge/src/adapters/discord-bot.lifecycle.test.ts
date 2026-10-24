import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { isSilence, testBot, tick, waitFor } from "../testing/fake-voice.js";

const newElection = () => new ReceiverElection(preferredOrder(5));
const opus = (n: number) => Buffer.from([0xfc, n, n, n]);
const joinPayloads = (t: { adapter: { sent: { d: { channel_id: string | null } }[] } }) => t.adapter.sent.filter((p) => p.d.channel_id !== null).length;

describe("a destroyed voice connection is replaced, never reused (real VoiceConnection)", () => {
  it("builds a new Ready connection with a new DAVE session after the gateway destroys the old one", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 5 } });
    const h1 = await t.join();
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    h1.conn.destroy(false); // exactly what discord.js's adapter calls on a shard disconnect
    assert.equal(h1.conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(unhealthy.length, 1, "the unexpected destruction is reported once");
    assert.equal(t.bot.healthy, false);

    const h2 = await t.join();
    assert.equal(t.ready.length, 2, "a second connection was created");
    assert.notEqual(h2.conn, h1.conn, "the replacement is a different VoiceConnection");
    assert.notEqual(h2.dave, h1.dave, "the destroyed connection's DAVE session is not reused");
    assert.equal(h2.conn.state.status, VoiceConnectionStatus.Ready);
    assert.equal(t.bot.voiceConnection, h2.conn);
    assert.equal(h2.conn.joinConfig.group, h1.conn.joinConfig.group, "the per-bot group is preserved");
    assert.equal(t.bot.healthy, true);

    t.bot.sendOpus(opus(7)); // and it carries audio, not just a state
    await waitFor(() => h2.networking.wire.some((p) => !isSilence(p)), 1000, "audio on the replacement connection");
    assert.equal(h1.networking.wire.filter((p) => !isSilence(p)).length, 0, "nothing goes out on the destroyed one");
    await t.bot.destroy();
  });

  it("keeps working across repeated gateway destruction, and never touches another bot", async () => {
    const election = newElection();
    const sessionId = randomUUID();
    const a = testBot("slot-0", election, { sessionId, timing: { maxRecoveries: 10 } });
    const b = testBot("slot-1", election, { sessionId });
    await a.join();
    const hb = await b.join();
    for (let i = 0; i < 3; i++) {
      a.bot.voiceConnection!.destroy(false);
      const fresh = await a.join();
      assert.equal(fresh.conn.state.status, VoiceConnectionStatus.Ready, `attempt ${i + 1} produced a usable connection`);
    }
    assert.equal(a.ready.length, 4);
    assert.equal(new Set(a.ready.map((h) => h.conn)).size, 4, "four distinct connections");
    assert.equal(hb.conn.state.status, VoiceConnectionStatus.Ready, "the other bot's connection is untouched");
    assert.equal(b.ready.length, 1);
    await a.bot.destroy();
    await b.bot.destroy();
  });

  it("treats a rejoin() that returns false as a failure and builds a new connection", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 5 } });
    const h1 = await t.join({ receive: false });
    (h1.conn as unknown as { rejoin: () => boolean }).rejoin = () => false; // the library refuses
    const h2 = await t.join({ receive: true });
    assert.notEqual(h2.conn, h1.conn);
    assert.equal(h1.conn.state.status, VoiceConnectionStatus.Destroyed, "the unusable connection was torn down");
    assert.equal(t.bot.deaf, false, "and the new one is undeafened as requested");
    await t.bot.destroy();
  });

  it("replaces a connection that never reached Ready instead of retrying on it", async () => {
    const t = testBot("slot-0", newElection(), { timing: { readyMs: 80, maxRecoveries: 5 } });
    t.autoReady = false;
    await assert.rejects(() => t.bot.join({ receive: false }), /./);
    const stuck = t.bot.voiceConnection;
    t.autoReady = true;
    const h = await t.join();
    assert.notEqual(h.conn, stuck, "a connection stuck in Signalling is not reused");
    assert.equal(h.conn.state.status, VoiceConnectionStatus.Ready);
    await t.bot.destroy();
  });
});

describe("a join is cancelled by leave() at every asynchronous boundary", () => {
  it("never creates a connection when leave() arrives while the target is still being resolved", async () => {
    const t = testBot("slot-0", newElection());
    const release = t.holdTarget();
    const joining = t.bot.join({ receive: false });
    joining.catch(() => undefined);
    await tick(10);
    t.bot.leave(); // the runtime is stopping
    release();
    await assert.rejects(() => joining, /cancel|abort|stop/i);
    await tick(30);
    assert.equal(joinPayloads(t), 0, "no join payload ever reached the gateway");
    assert.equal(t.bot.voiceConnection, null);
    assert.equal(t.bot.healthy, false);
    await t.bot.destroy();
  });

  it("tears a late connection down when leave() arrives while it waits for Ready", async () => {
    const t = testBot("slot-0", newElection(), { timing: { readyMs: 2000 } });
    t.autoReady = false;
    const joining = t.bot.join({ receive: false });
    joining.catch(() => undefined);
    await waitFor(() => t.bot.voiceConnection, 500, "a connection in Signalling");
    const conn = t.bot.voiceConnection!;
    t.bot.leave();
    await assert.rejects(() => joining, /cancel|abort/i);
    assert.equal(conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(t.bot.healthy, false);
    t.completePending(); // nothing left to complete
    await tick(30);
    assert.equal(t.bot.healthy, false);
    await t.bot.destroy();
  });

  it("a join submitted before leave() cannot succeed after a later join was submitted", async () => {
    const t = testBot("slot-0", newElection());
    const release = t.holdTarget();
    const stale = t.bot.join({ receive: false });
    stale.catch(() => undefined);
    await tick(10);
    t.bot.leave();
    const fresh = t.bot.join({ receive: false }); // a new, legitimate join, queued behind the stale one
    fresh.catch(() => undefined);
    release();
    await assert.rejects(() => stale, /cancel|abort|stop/i);
    await fresh;
    assert.equal(t.ready.length, 1, "only the new join created a connection");
    assert.equal(t.bot.healthy, true);
    await t.bot.destroy();
  });
});

describe("one budget for every connection rebuild (real VoiceConnection)", () => {
  it("allows planned joins and leaves without limit", async () => {
    const t = testBot("slot-0", newElection(), { timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    for (let i = 0; i < 6; i++) {
      await t.join();
      t.bot.leave();
    }
    assert.equal(t.ready.length, 6, "leaving on purpose never spends the budget");
    await t.bot.destroy();
  });

  it("refuses a rebuild beyond the limit, builds no connection, and reports when it may retry", async () => {
    let now = 1_000_000;
    const t = testBot("slot-0", newElection(), { now: () => now, timing: { maxRecoveries: 1, recoveryWindowMs: 60_000 } });
    const h1 = await t.join();
    h1.conn.destroy(false);
    const h2 = await t.join(); // rebuild 1 of 1
    assert.notEqual(h2.conn, h1.conn);
    assert.equal(t.bot.healthy, true, "a successful rebuild does not refund the budget");

    h2.conn.destroy(false);
    await assert.rejects(
      () => t.bot.join({ receive: false }),
      (e: Error & { code?: string; retryInMs?: number }) => e.code === "REBUILD_BUDGET_EXHAUSTED" && (e.retryInMs ?? 0) > 0 && (e.retryInMs ?? 0) <= 60_000,
    );
    assert.equal(t.ready.length, 2, "no third connection");
    assert.equal(t.bot.healthy, false);

    now += 30_000;
    await assert.rejects(() => t.bot.join({ receive: false }), /./, "still inside the window");
    assert.equal(t.ready.length, 2);

    now += 31_000; // the first rebuild has left the window
    const h3 = await t.join();
    assert.equal(h3.conn.state.status, VoiceConnectionStatus.Ready, "the budget frees up by time alone");
    assert.equal(t.ready.length, 3);
    await t.bot.destroy();
  });

  it("counts a failed attempt as spent, so a join that never reaches Ready cannot be retried in a storm", async () => {
    const t = testBot("slot-0", newElection(), { timing: { readyMs: 40, maxRecoveries: 2, recoveryWindowMs: 60_000 } });
    const h1 = await t.join();
    h1.conn.destroy(false);
    t.autoReady = false;
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      await t.bot.join({ receive: false }).catch((e: { code?: string }) => {
        if (e.code === "REBUILD_BUDGET_EXHAUSTED") refused += 1;
      });
    }
    assert.equal(refused, 4, "two attempts were allowed, the other four were refused without touching the gateway");
    assert.ok(joinPayloads(t) <= 3, `at most the first join and two rebuilds reached the gateway (saw ${joinPayloads(t)})`);
    await t.bot.destroy();
  });
});
