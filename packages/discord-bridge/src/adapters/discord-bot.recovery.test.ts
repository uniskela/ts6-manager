import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceConnectionStatus } from "@discordjs/voice";
import type { BotId } from "../core/ids.js";
import { preferredOrder } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { talk, testBot, tick, waitFor } from "../testing/fake-voice.js";

function receiverElection() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("test");
  return election;
}

async function brokenReceiver(o: { reuseDave?: boolean } = {}) {
  const election = receiverElection();
  const got: Buffer[] = [];
  const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, op: Buffer) => got.push(op) });
  const h = await t.join({ receive: true });
  h.mapUser("human", 7777);
  t.bot.startReceive(election.generation);
  return { election, t, h, got };
}

describe("DAVE recovery is a genuinely fresh session (real VoiceConnection and DAVESession)", () => {
  it("rebuilds the connection and the DAVE session instead of rejoining the ready one", async () => {
    const { election, t, h } = await brokenReceiver();
    const oldConn = h.conn;
    const oldDave = h.dave;
    const leaves = () => t.adapter.sent.filter((p) => p.d.channel_id === null).length;
    h.davey.decryptError = new Error("DecryptionFailed");
    const stop = talk(h, "human");
    await waitFor(() => t.latest() !== h, 3000, "a new connection after recovery");
    stop();
    const fresh = t.latest();
    assert.notEqual(fresh.conn, oldConn, "a new VoiceConnection");
    assert.equal(oldConn.state.status, VoiceConnectionStatus.Destroyed, "the old connection was torn down");
    assert.notEqual(fresh.dave, oldDave, "a new DAVE/MLS session, not the poisoned one");
    assert.ok(leaves() >= 1, "the bot left the channel on the gateway before rejoining");
    await waitFor(() => t.bot.healthy, 1000, "healthy again");
    assert.equal(election.receiver, "slot-0");
    await t.bot.destroy();
  });

  it("does not report intentional teardown during recovery as a connection failure", async () => {
    const { h, t } = await brokenReceiver();
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    h.davey.decryptError = new Error("DecryptionFailed");
    const stop = talk(h, "human");
    await waitFor(() => t.latest() !== h && t.bot.healthy, 3000, "recovered");
    stop();
    assert.deepEqual(unhealthy, []);
    await t.bot.destroy();
  });

  it("rejects stale reception from the replaced connection", async () => {
    const { h, t, got } = await brokenReceiver();
    h.davey.decryptError = new Error("DecryptionFailed");
    const stop = talk(h, "human"); // keeps talking into the OLD connection's receiver
    await waitFor(() => t.latest() !== h && t.bot.healthy, 3000, "recovered");
    stop();
    const before = got.length;
    h.davey.decryptError = null;
    h.udp("human", Buffer.from([0xfc, 9, 9, 9])); // a late packet on the replaced receiver
    await tick(60);
    assert.equal(got.length, before, "nothing from the replaced connection reaches the pipeline");
    await t.bot.destroy();
  });

  it("verifies freshness: a recovery that hands back the same DAVE session fails and the bot is declared unhealthy", async () => {
    const { h, t } = await brokenReceiver();
    t.reuseDave = true; // the replacement connection comes up with the stale session
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    h.davey.decryptError = new Error("DecryptionFailed");
    const stop = talk(h, "human");
    await waitFor(() => unhealthy.length > 0, 3000, "unhealthy after a recovery that was not fresh");
    stop();
    assert.match(unhealthy[0], /fresh/i);
    await t.bot.destroy();
  });

  it("is bounded: repeated recoveries stop at the limit and the bot goes unhealthy so the runtime can fail over", async () => {
    const election = receiverElection();
    const t = testBot("slot-0", election, { timing: { maxRecoveries: 2, recoveryWindowMs: 60_000 } });
    let h = await t.join({ receive: true });
    h.mapUser("human", 8888);
    t.bot.startReceive(election.generation);
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    const stops: (() => number)[] = [];
    for (let round = 0; round < 4 && unhealthy.length === 0; round++) {
      h.davey.decryptError = new Error("DecryptionFailed");
      stops.push(talk(h, "human"));
      await waitFor(() => t.latest() !== h || unhealthy.length > 0, 3000, `round ${round}`);
      stops.forEach((s) => s());
      if (unhealthy.length) break;
      await waitFor(() => t.bot.healthy, 1000, "healthy");
      h = t.latest();
      h.mapUser("human", 8888);
      election.daveRestored("slot-0");
      t.bot.startReceive(election.generation);
    }
    assert.equal(t.ready.length, 3, "initial connection plus exactly two recoveries");
    await waitFor(() => unhealthy.length > 0, 3000, "unhealthy after the limit");
    assert.match(unhealthy[0], /recovery/i);
    await t.bot.destroy();
  });
});

describe("intentional teardown never looks like a failure", () => {
  it("leave() does not emit unhealthy", async () => {
    const election = receiverElection();
    const t = testBot("slot-0", election);
    await t.join();
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    t.bot.leave();
    await tick(20);
    assert.deepEqual(unhealthy, []);
    await t.bot.destroy();
  });

  it("a connection that drops by itself is still reported", async () => {
    const election = receiverElection();
    const t = testBot("slot-0", election);
    const h = await t.join();
    const unhealthy: string[] = [];
    t.bot.on("unhealthy", (r: string) => unhealthy.push(r));
    (h.conn as unknown as { state: unknown }).state = { ...h.conn.state, status: "disconnected", reason: 0 };
    await waitFor(() => unhealthy.length > 0, 1000, "disconnect reported");
    await t.bot.destroy();
  });

  it("destroy() while a join is waiting for Ready aborts it promptly and leaves nothing behind", async () => {
    const election = receiverElection();
    const t = testBot("slot-0", election, { timing: { readyMs: 10_000 } });
    t.autoReady = false; // the join never completes on its own
    const joining = t.bot.join({ receive: false });
    const outcome = joining.then(() => "joined", (e: Error) => e.message);
    await waitFor(() => t.bot.voiceConnection, 500, "connection");
    const started = Date.now();
    await t.bot.destroy();
    const result = await outcome;
    assert.notEqual(result, "joined");
    assert.ok(Date.now() - started < 1000, "the pending join was aborted, not left to time out");
    assert.equal(t.bot.voiceConnection, null);
    await assert.rejects(() => t.bot.join({ receive: false }), /stopped|destroyed|closed/i, "a stopped bot never joins again");
  });
});
