import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { BotId } from "../core/ids.js";
import { preferredOrder } from "../core/ids.js";
import { ReceiveSupervisor } from "../core/receive-supervisor.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { talk, testBot, tick, waitFor } from "../testing/fake-voice.js";

function newElection() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  return election;
}

describe("receive lifecycle (real VoiceReceiver and SpeakingMap)", () => {
  it("a human who is already talking when the bot takes over is received without a new speaking-start event", async () => {
    const election = newElection();
    const got: Buffer[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, o: Buffer) => got.push(o) });
    const h = await t.join({ receive: true }); // undeafened and listening, but not the elected receiver yet
    h.mapUser("human", 2222);
    let starts = 0;
    h.conn.receiver.speaking.on("start", () => starts++);
    const stopTalking = talk(h, "human");
    await waitFor(() => h.conn.receiver.speaking.users.has("human"), 1000, "human is speaking on this connection");
    assert.equal(starts, 1, "the only speaking-start happened before takeover");

    election.reconcile("takeover"); // this bot is now elected: takeover while the human is mid-sentence
    assert.equal(t.bot.startReceive(election.generation), true);
    await waitFor(() => got.length >= 3, 1500, "frames from the already-speaking human");
    assert.equal(starts, 1, "no new speaking-start was needed");
    stopTalking();
    await t.bot.destroy();
  });

  it("a human already talking before the bot even finished joining is picked up once reception starts", async () => {
    const election = newElection();
    election.reconcile("start");
    const got: Buffer[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, o: Buffer) => got.push(o) });
    const h = await t.join({ receive: true });
    h.mapUser("human", 3333);
    const stopTalking = talk(h, "human");
    await tick(150); // speech began, nobody was listening yet
    assert.equal(t.bot.startReceive(election.generation), true);
    await waitFor(() => got.length >= 3, 1500, "frames");
    stopTalking();
    await t.bot.destroy();
  });

  it("after a decrypt failure the subscription is restored while the human keeps talking (no new speaking-start)", async () => {
    const election = newElection();
    election.reconcile("start");
    const got: Buffer[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, o: Buffer) => got.push(o) });
    const h = await t.join({ receive: true });
    h.mapUser("human", 4444);
    t.bot.startReceive(election.generation);
    let starts = 0;
    h.conn.receiver.speaking.on("start", () => starts++);
    const stopTalking = talk(h, "human");
    await waitFor(() => got.length >= 2, 1500, "audio flowing");
    const startsBefore = starts;

    h.davey.decryptError = new Error("DecryptionFailed"); // an MLS epoch the bot cannot read: the stream is destroyed
    await waitFor(() => t.bot.decryptErrors >= 1, 1500, "decrypt failure observed");
    h.davey.decryptError = null; // the epoch is readable again, but the human never paused
    const seen = got.length;
    await waitFor(() => got.length > seen + 2, 1500, "audio restored without a speaking-start event");
    assert.equal(starts, startsBefore, "recovery did not depend on a new speaking-start event");
    stopTalking();
    await t.bot.destroy();
  });

  it("repeated decrypt failures fail closed: subscriptions stop and bounded recovery is requested", async () => {
    const election = newElection();
    election.reconcile("start");
    const got: Buffer[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b: BotId, _g: number, _u: string, o: Buffer) => got.push(o) });
    const h = await t.join({ receive: true });
    h.mapUser("human", 5555);
    t.bot.startReceive(election.generation);
    const recoveries: string[] = [];
    const openAtRequest: number[] = [];
    t.bot.on("recoveryRequested", (r: string) => {
      recoveries.push(r);
      openAtRequest.push(t.bot.openSubscriptions);
    });
    h.davey.decryptError = new Error("DecryptionFailed");
    const stopTalking = talk(h, "human");
    await waitFor(() => recoveries.length > 0, 3000, "recovery requested after repeated failures");
    stopTalking();
    assert.equal(recoveries.length, 1, "one bounded recovery request, not a storm");
    assert.deepEqual(openAtRequest, [0], "failed closed: no subscription is open when recovery is requested");
    await t.bot.destroy();
  });
});

describe("ReceiveSupervisor rejects stale callbacks after replacement", () => {
  function supervisor(errorThreshold = 3) {
    const election = newElection();
    election.reconcile("start");
    const frames: number[] = [];
    const rejoins: string[] = [];
    const src = new PassThrough({ objectMode: true });
    const sup = new ReceiveSupervisor({
      bot: "slot-0",
      generation: election.generation,
      election,
      subscribe: () => src,
      activeSpeakers: () => [],
      onFrame: (_u, o) => frames.push(o[0]),
      onNeedRecovery: (r) => rejoins.push(r),
      errorThreshold,
    });
    return { sup, src, frames, rejoins };
  }

  it("a frame arriving after closeAll never reaches the pipeline", () => {
    const { sup, src, frames } = supervisor();
    sup.open("h1");
    sup.closeAll();
    src.emit("data", Buffer.from([9])); // a stale callback from the replaced receiver
    assert.deepEqual(frames, []);
  });

  it("a stream error that surfaces after closeAll does not request recovery", async () => {
    const { sup, src, rejoins } = supervisor(1);
    sup.open("h1");
    src.destroy(new Error("late decrypt error")); // 'error' is emitted on the next tick
    sup.closeAll();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rejoins, []);
  });
});

describe("only verified humans are subscribed and forwarded (real VoiceReceiver)", () => {
  async function receiver(o: { lookup?: (id: string) => Promise<{ bot: boolean } | null> } = {}) {
    const election = newElection();
    election.reconcile("start");
    const got: string[] = [];
    const t = testBot("slot-0", election, { userLookup: o.lookup, onHumanOpus: (_b: BotId, _g: number, user: string) => got.push(user) });
    const h = await t.join({ receive: true });
    return { election, t, h, got };
  }

  it("another Discord bot that is already speaking is never subscribed or forwarded", async () => {
    const { election, t, h, got } = await receiver();
    const other = "123456789012345678";
    t.bot.client.users.cache.set(other, { id: other, bot: true } as never); // a known non-bridge bot account
    h.mapUser(other, 1111);
    const stop = talk(h, other);
    t.bot.startReceive(election.generation);
    await tick(150);
    stop();
    assert.deepEqual(got, [], "nothing from the other bot reached the pipeline");
    assert.equal(t.bot.openSubscriptions, 0, "and no subscription was ever opened for it");
    await t.bot.destroy();
  });

  it("a bot that starts speaking after reception began is excluded on the speaking-start path too", async () => {
    const { election, t, h, got } = await receiver({ lookup: async (id) => ({ bot: id === "bot-user" }) });
    t.bot.startReceive(election.generation);
    h.mapUser("bot-user", 2222);
    h.mapUser("human", 3333);
    const stopBot = talk(h, "bot-user");
    const stopHuman = talk(h, "human");
    await waitFor(() => got.includes("human"), 1500, "the verified human is forwarded");
    stopBot();
    stopHuman();
    assert.ok(!got.includes("bot-user"), "the bot is not");
    assert.equal(t.bot.openSubscriptions <= 1, true);
    await t.bot.destroy();
  });

  it("fails closed while identity is unknown, then admits once it is established as human", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { election, t, h, got } = await receiver({
      lookup: async () => {
        await gate; // member metadata is not available yet
        return { bot: false };
      },
    });
    h.mapUser("late-known", 4444);
    const stop = talk(h, "late-known");
    t.bot.startReceive(election.generation);
    await tick(120);
    assert.deepEqual(got, [], "no audio from an unresolved identity");
    assert.equal(t.bot.openSubscriptions, 0);
    release();
    await waitFor(() => got.length > 2, 1500, "admitted once the identity resolved");
    stop();
    await t.bot.destroy();
  });

  it("stays closed for an identity that cannot be established, and does not hammer the lookup", async () => {
    let calls = 0;
    const { election, t, h, got } = await receiver({
      lookup: async () => {
        calls += 1;
        throw new Error("REST unavailable");
      },
    });
    h.mapUser("unknown", 5555);
    const stop = talk(h, "unknown");
    t.bot.startReceive(election.generation);
    await tick(400);
    stop();
    assert.deepEqual(got, []);
    assert.ok(calls <= 2, `lookups are rate limited (saw ${calls} in 400 ms)`);
    await t.bot.destroy();
  });
});
