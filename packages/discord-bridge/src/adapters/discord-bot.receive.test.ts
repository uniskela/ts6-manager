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

  it("speakers whose identity lookups never settle cannot make the bot hold more than the cap, and a known human is still forwarded", async () => {
    const { election, t, h, got } = await receiver({ lookup: () => new Promise(() => undefined) });
    t.bot.startReceive(election.generation);
    const stops: (() => number)[] = [];
    for (let i = 0; i < 25; i++) {
      h.mapUser(`stranger-${i}`, 5000 + i);
      stops.push(talk(h, `stranger-${i}`));
    }
    await tick(200);
    assert.ok(t.bot.identityLookups.pending <= 8, `at most the cap is out (saw ${t.bot.identityLookups.pending})`);
    assert.ok(t.bot.identityLookups.refused > 0, "the rest were refused rather than queued");
    assert.equal(t.bot.openSubscriptions, 0, "and every one of them stays excluded");
    assert.equal(got.length, 0, "nothing from them reached the pipeline");

    t.bot.client.users.cache.set("friend", { id: "friend", bot: false } as never); // the client already knows this one
    h.mapUser("friend", 9000);
    stops.push(talk(h, "friend"));
    await waitFor(() => got.includes("friend"), 1500, "the known human is forwarded although every lookup slot is stuck");
    assert.ok(!got.some((u) => u.startsWith("stranger")));
    for (const stop of stops) stop();
    await t.bot.destroy();
  });

  it("an answer that arrives after the bot left, or after the human left the channel, admits nobody", async () => {
    const answers = new Map<string, (v: { bot: boolean }) => void>();
    const { election, t, h, got } = await receiver({ lookup: (id) => new Promise((resolve) => answers.set(id, resolve)) });
    t.bot.startReceive(election.generation);
    h.mapUser("departs", 6001);
    h.mapUser("session-ends", 6002);
    const stops = [talk(h, "departs"), talk(h, "session-ends")];
    await waitFor(() => answers.size === 2, 1000, "both lookups started");

    // The human leaves our channel (a voice state update from Discord), then the answer arrives.
    t.bot.client.emit("voiceStateUpdate", { id: "departs", channelId: "channel-1" } as never, { id: "departs", channelId: null } as never);
    answers.get("departs")!({ bot: false });
    // The bot's session ends, then the other answer arrives.
    t.bot.leave();
    answers.get("session-ends")!({ bot: false });
    await tick(20);

    assert.equal(t.bot.identityLookups.pending, 0, "both slots came back");
    assert.equal(t.bot.identityLookups.remembered, 0, "and nothing was remembered from the late answers");
    assert.equal(got.length, 0);
    for (const stop of stops) stop();
    await t.bot.destroy();
  });

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

describe("the production identity lookup (real discord.js UserManager, REST requests the test settles)", () => {
  interface RestCall {
    route: string;
    method: string;
    settled: boolean;
    resolve(user: unknown): void;
    reject(error: Error): void;
  }

  /**
   * Replaces the REST transport the real `UserManager.fetch` and `REST.get` call into: every request
   * is a promise only the test settles. `max` is the most requests ever unsettled at once.
   */
  function controlledRest(bot: { client: { rest: unknown } }) {
    const calls: RestCall[] = [];
    let unsettled = 0;
    let max = 0;
    (bot.client.rest as { request: (o: { fullRoute: string; method: string }) => Promise<unknown> }).request = (o) =>
      new Promise((resolve, reject) => {
        unsettled += 1;
        max = Math.max(max, unsettled);
        const done = (settle: () => void) => {
          if (call.settled) return;
          call.settled = true;
          unsettled -= 1;
          settle();
        };
        const call: RestCall = { route: o.fullRoute, method: o.method, settled: false, resolve: (u) => done(() => resolve(u)), reject: (e) => done(() => reject(e)) };
        calls.push(call);
      });
    return { calls, unsettled: () => unsettled, max: () => max };
  }

  /** What Discord's `GET /users/{id}` returns. */
  const apiUser = (id: string, bot: boolean) => ({ id, username: `user${id.slice(-3)}`, discriminator: "0", global_name: null, avatar: null, bot });
  const speakerId = (n: number) => `1000000000000000${String(n).padStart(2, "0")}`; // a snowflake-shaped string, built as text

  async function receiver(o: { identityLookup?: NonNullable<Parameters<typeof testBot>[2]>["identityLookup"] } = {}) {
    const election = newElection();
    election.reconcile("start");
    const got: string[] = [];
    const t = testBot("slot-0", election, { productionLookup: true, identityLookup: o.identityLookup, onHumanOpus: (_b: BotId, _g: number, user: string) => got.push(user) });
    const rest = controlledRest(t.bot);
    const h = await t.join({ receive: true });
    t.bot.startReceive(election.generation);
    const stops: (() => number)[] = [];
    const speak = (n: number) => {
      h.mapUser(speakerId(n), 7000 + n);
      stops.push(talk(h, speakerId(n)));
    };
    const cleanUp = async () => {
      for (const stop of stops) stop();
      for (const call of rest.calls) call.reject(new Error("test over"));
      await t.bot.destroy();
    };
    return { t, rest, got, speak, cleanUp };
  }

  it("with the production timing, three batches of eight unidentified speakers never have more than eight REST requests unsettled (24 before)", async () => {
    // The reviewer's scenario: every request stalls. A wrapper timeout that freed the slot let each batch start eight more.
    const { t, rest, got, speak, cleanUp } = await receiver();
    try {
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 8; i++) speak(batch * 8 + i);
        await tick(batch < 2 ? 5_300 : 300); // past the old 5 s wrapper timeout, and past the filter's own 6 s by the third batch
      }
      assert.equal(rest.calls.length, 8, `requests started (${rest.calls.length})`);
      assert.ok(rest.max() <= 8, `at most eight unsettled at once (saw ${rest.max()})`);
      assert.deepEqual(rest.calls.map((c) => `${c.method} ${c.route}`), Array.from({ length: 8 }, (_, i) => `GET /users/${speakerId(i)}`), "the real UserManager asked for the first eight speakers");
      const stats = t.bot.identityLookups;
      assert.equal(stats.pending, 8, "the filter still counts every request that is out");
      assert.equal(stats.stalled, 8, "all eight are past the filter's timeout, and still hold their slots");
      assert.ok(stats.refused > 0, "the later batches were refused");
      assert.equal(t.bot.openSubscriptions, 0);
      assert.deepEqual(got, [], "nobody unidentified was forwarded");
    } finally {
      await cleanUp();
    }
  });

  it("a slot is released only when its REST request settles; then only a positive human answer admits, and the next speakers are looked up within the cap", async () => {
    const { t, rest, got, speak, cleanUp } = await receiver({ identityLookup: { lookupTimeoutMs: 40, retryMs: 40, maxRetryMs: 80 } });
    try {
      for (let i = 0; i < 24; i++) speak(i);
      await waitFor(() => rest.calls.length === 8, 1000, "the first eight requests");
      await tick(300); // many filter timeouts and cooldowns later
      assert.equal(rest.calls.length, 8, "a timed-out lookup does not free its slot or start a second request");
      assert.equal(t.bot.identityLookups.stalled, 8);
      assert.equal(got.length, 0, "nobody is forwarded while unidentified");

      // Settle the eight: two humans, two bots, two errors, and two that stay stalled.
      const [h1, h2, b1, b2, e1, e2] = rest.calls;
      h1.resolve(apiUser(speakerId(0), false));
      h2.resolve(apiUser(speakerId(1), false));
      b1.resolve(apiUser(speakerId(2), true));
      b2.resolve(apiUser(speakerId(3), true));
      e1.reject(new Error("503 Service Unavailable"));
      e2.reject(new Error("socket hang up"));
      await waitFor(() => got.includes(speakerId(0)) && got.includes(speakerId(1)), 1500, "the two humans to be forwarded once identified");
      await waitFor(() => rest.calls.length > 8, 1500, "freed slots to be used for speakers still waiting");
      await tick(300);
      assert.ok(rest.max() <= 8, `never more than eight unsettled (saw ${rest.max()})`);
      assert.ok(rest.unsettled() <= 8);
      assert.equal(t.bot.identityLookups.pending, rest.unsettled(), "the filter's count is the real number of requests out");
      assert.deepEqual(new Set(got), new Set([speakerId(0), speakerId(1)]), "bots, failed lookups and the unanswered stay excluded");
      assert.equal(t.bot.openSubscriptions, 2);
    } finally {
      await cleanUp();
    }
  });
});
