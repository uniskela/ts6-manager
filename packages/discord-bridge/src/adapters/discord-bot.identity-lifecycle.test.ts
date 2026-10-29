/**
 * R1 lifecycle: identity verification, voice-channel membership and audio forwarding are three
 * separate things, and each test says which one it is checking.
 *
 * - identity: has Discord told us this user is not a bot (`users.cache`, the identity filter).
 * - membership: is the user in the bridge's source voice channel now (the guild's voice-state cache,
 *   driven through discord.js's own VOICE_STATE_UPDATE handler).
 * - forwarding: did audio from the user reach the bot's `onHumanOpus` (and from there TeamSpeak).
 *
 * The production identity lookup runs here: the real `UserManager.fetch`, `REST.get`, `REST.request`
 * and the REST route queue. Only the network edge (`makeRequest`) is a promise the test settles,
 * and it ignores the per-attempt AbortSignal, so a request stalls for as long as the test wants.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import type { IdentityRequests } from "../core/identity-requests.js";
import type { BotId } from "../core/ids.js";
import { preferredOrder } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import type { Admission } from "../core/voice-admission.js";
import { apiUser, controlQueuedRest, restCounters, type RestCounters } from "../testing/controlled-rest.js";
import { talk, testBot, tick, waitFor, type ReadyHandle } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

function newElection() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("start");
  return election;
}

/** A snowflake-shaped id, built as text (numbers this large lose precision). */
const snowflake = (group: number, n: number) => `20000000000000${String(group).padStart(2, "0")}${String(n).padStart(2, "0")}`;
const userRoute = (id: string) => `GET /users/${id}`;

type IdentityTiming = NonNullable<Parameters<typeof testBot>[2]>["identityLookup"];

async function productionReceiver(o: { group: number; counters?: RestCounters; identityRequests?: IdentityRequests | "process"; id?: BotId; identityLookup?: IdentityTiming }) {
  const election = newElection();
  const got: string[] = [];
  /** Every forwarded packet with the admission it carried. */
  const admissions: { user: string; admission: Admission }[] = [];
  const t = testBot(o.id ?? "slot-0", election, {
    productionLookup: true,
    identityRequests: o.identityRequests,
    identityLookup: o.identityLookup,
    onHumanOpus: (_b: BotId, _g: number, user: string, _opus: Buffer, admission: Admission) => {
      got.push(user);
      admissions.push({ user, admission });
    },
  });
  const rest = controlQueuedRest(t.bot.client, o.counters);
  const h = await t.join({ receive: true });
  assert.equal(t.bot.startReceive(election.generation), true);
  const stops: (() => number)[] = [];
  let ssrc = 7000 + o.group * 100;
  const speak = (userId: string) => {
    h.mapUser(userId, ssrc++);
    const stop = talk(h, userId);
    stops.push(stop);
    return stop;
  };
  const silence = () => {
    for (const stop of stops) stop();
  };
  /** The distinct admissions a user's forwarded packets carried, in order. */
  const admissionsOf = (user: string) => [...new Set(admissions.filter((a) => a.user === user).map((a) => a.admission))];
  return { election, t, h, rest, got, speak, silence, admissionsOf };
}

const channelOf = (t: ReturnType<typeof testBot>, user: string) => t.bot.client.guilds.cache.get("guild-1")?.voiceStates.cache.get(user)?.channelId ?? null;
const userIdOf = (url: string) => /\/users\/(\d+)/.exec(url)?.[1] ?? "";

describe("Codex R1 lifecycle reproductions (real discord.js UserManager and REST queue)", () => {
  it("R1-A: a human who left while their identity lookup was out is not forwarded when the late answer arrives", async (c) => {
    const { t, rest, got, speak, silence } = await productionReceiver({ group: 1 });
    const user = snowflake(1, 1);
    try {
      speak(user); // membership: in the channel (mapUser puts them there); identity: unknown
      await waitFor(() => rest.open().length === 1, 1000, "the identity request on the wire");
      assert.deepEqual(got, [], "forwarding: nothing while identity is unknown");

      t.voice(user, null); // membership: the human leaves the channel; their packets keep arriving
      rest.open()[0].respond(apiUser(user, false)); // identity: the late answer says human
      await waitFor(() => t.bot.client.users.cache.get(user)?.bot === false, 1000, "discord.js to cache the late answer");
      await tick(300);

      assert.equal(t.bot.client.users.cache.get(user)?.bot, false, "identity: verified human (in discord.js's cache)");
      assert.equal(t.bot.client.guilds.cache.get("guild-1")?.voiceStates.cache.get(user)?.channelId ?? null, null, "membership: not in the channel");
      c.diagnostic(`R1-A measured: framesForwardedAfterDeparture=${got.filter((u) => u === user).length} openSubscriptions=${t.bot.openSubscriptions} identity=bot:${t.bot.client.users.cache.get(user)?.bot} membership=${channelOf(t, user)}`);
      assert.equal(got.filter((u) => u === user).length, 0, `forwarding: no audio from the departed human (saw ${got.length} frames)`);
      assert.equal(t.bot.openSubscriptions, 0, "and no subscription is open for them");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });

  it("R1-B: leaving and rejoining while the identity request is unsettled does not start a second request for the same user", async (c) => {
    const { t, rest, got, speak, silence } = await productionReceiver({ group: 2 });
    const user = snowflake(2, 1);
    try {
      speak(user);
      await waitFor(() => rest.counters.started.length === 1, 1000, "the first identity request");
      t.voice(user, null); // leaves...
      await tick(100);
      t.voice(user, "channel-1"); // ...and rejoins, still talking, while the first request is out
      await tick(300);

      const forUser = rest.counters.started.filter((r) => r === userRoute(user)).length;
      c.diagnostic(`R1-B measured: restOperationsForUser=${forUser} unsettledTotal=${rest.counters.operations}`);
      assert.equal(forUser, 1, `one REST operation for the user (saw ${forUser})`);
      assert.equal(rest.counters.operations, 1, "and one underlying operation unsettled in total");
      assert.deepEqual(got, [], "forwarding: nothing while identity is still unknown");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });

  it("R1-C: three successive in-process bot replacements cannot accumulate more than eight unsettled identity requests (24 before)", async (c) => {
    const counters = restCounters();
    const perInstance: number[] = [];
    const drains: (() => Promise<void>)[] = [];
    try {
      for (let instance = 0; instance < 3; instance++) {
        // Each instance gets the production default registry and new speakers, so per-user de-duplication cannot help.
        const { t, rest, got, speak, silence } = await productionReceiver({ group: 10 + instance, counters, identityRequests: "process" });
        drains.push(() => rest.drain());
        for (let i = 0; i < 10; i++) speak(snowflake(10 + instance, i));
        await tick(300);
        perInstance.push(counters.operations);
        assert.deepEqual(got, [], "forwarding: nobody unidentified");
        silence();
        await t.bot.destroy(); // client.destroy() does not cancel discord.js REST requests: they stay out
      }
      c.diagnostic(`R1-C measured: unsettledAfterEachInstance=${perInstance.join(",")} maxUnsettled=${counters.maxOperations}`);
      assert.ok(counters.operations <= 8, `unsettled underlying requests after three replacements: ${counters.operations} (per instance ${perInstance.join(", ")})`);
      assert.ok(counters.maxOperations <= 8, `never more than eight at once (saw ${counters.maxOperations})`);
    } finally {
      for (const drain of drains) await drain();
    }
  });
});

describe("identity is not membership: a known human is heard only while present in the source channel (R1-A)", () => {
  it("a cached bot:false identity does not override a revoked admission: forwarding stops at the departure and the identity stays known", async () => {
    for (const away of [null, "channel-2"]) {
      const { t, rest, got, speak, silence } = await productionReceiver({ group: 20 });
      const user = snowflake(20, 1);
      try {
        t.voice(user, "channel-1", { member: { bot: false } }); // the gateway's member data puts the human in discord.js's cache
        speak(user);
        await waitFor(() => got.includes(user), 1500, "the present, known human to be forwarded");
        assert.equal(rest.counters.started.length, 0, "identity came from the gateway cache, no REST request");

        t.voice(user, away); // disconnects, or moves to another channel; packets keep arriving
        assert.equal(t.bot.admittedHumans, 0, "admission: revoked by the departure itself, before any packet is checked");
        const atDeparture = got.length;
        await tick(250);
        assert.equal(t.bot.client.users.cache.get(user)?.bot, false, "identity: still a verified human");
        assert.equal(channelOf(t, user), away, "membership: not in the source channel");
        assert.equal(got.length, atDeparture, `forwarding: nothing after the departure (${away ?? "disconnect"}; saw ${got.length - atDeparture})`);
        assert.equal(t.bot.openSubscriptions, 0, "their stream was closed");
        assert.equal(t.bot.admittedHumans, 0);
      } finally {
        silence();
        await rest.drain();
        await t.bot.destroy();
      }
    }
  });

  it("a known human whose packets arrive but who is not in the source channel is never subscribed, and is heard once they enter it", async () => {
    const { t, rest, got, speak, silence } = await productionReceiver({ group: 21 });
    const user = snowflake(21, 1);
    try {
      t.voice(user, "channel-2", { member: { bot: false } }); // identity known, membership elsewhere
      t.autoVoice = false;
      speak(user);
      await tick(250);
      assert.equal(got.length, 0, "forwarding: none while membership says elsewhere");
      assert.equal(t.bot.openSubscriptions, 0, "and no subscription was opened");
      t.voice(user, "channel-1");
      await waitFor(() => got.includes(user), 1500, "forwarded once present");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });

  it("leaving and rejoining grants a new admission; the old one never becomes valid again", async () => {
    const { t, rest, got, speak, silence, admissionsOf } = await productionReceiver({ group: 22 });
    const user = snowflake(22, 1);
    try {
      t.voice(user, "channel-1", { member: { bot: false } });
      speak(user);
      await waitFor(() => got.includes(user), 1500, "first admission");
      const [first] = admissionsOf(user);
      assert.equal(t.bot.humanAdmitted(user, first), true);

      t.voice(user, null);
      assert.equal(t.bot.humanAdmitted(user, first), false, "revoked at the departure");
      const atDeparture = got.length;
      await tick(150);
      assert.equal(got.length, atDeparture, "nothing forwarded while away");

      t.voice(user, "channel-1"); // a real rejoin
      await waitFor(() => admissionsOf(user).length === 2, 1500, "a second admission after the rejoin");
      const second = admissionsOf(user)[1];
      assert.notEqual(second, first, "a new admission, not the old one restored");
      assert.ok(second.id > first.id);
      assert.equal(t.bot.humanAdmitted(user, first), false, "the old admission stays dead after the rejoin");
      assert.equal(t.bot.humanAdmitted(user, second), true);
      assert.equal(rest.counters.started.length, 0, "identity was never re-requested: it is not what the rejoin needed");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });
});

describe("queued and delayed frames are fenced at the last boundary before TeamSpeak", () => {
  /** A real bot feeding a real Discord-to-TeamSpeak pipeline that the test ticks by hand, so frames can be held in the queue. */
  async function pipelineReceiver() {
    const election = newElection();
    const out: Buffer[] = [];
    let pushed = 0;
    const admissions: Admission[] = [];
    let now = 0;
    let pipe!: DiscordToTsPipeline;
    const t = testBot("slot-0", election, {
      onHumanOpus: (b, g, u, opus, a) => {
        pushed += 1;
        admissions.push(a);
        pipe.onDiscordOpus(b, g, u, opus, now, a);
      },
    });
    pipe = new DiscordToTsPipeline({
      election,
      codecFactory: () => createOpusCodec("native"),
      out: { sendVoice: (p) => out.push(p), sendVoiceStop: () => undefined },
      bridgeUserIds: () => new Set(),
      admitted: (_b, user, a) => t.bot.humanAdmitted(user, a),
    });
    const h = await t.join({ receive: true });
    assert.equal(t.bot.startReceive(election.generation), true);
    const packet = validOpus();
    const speakFor = async (h2: ReadyHandle, user: string, ssrc: number, frames: number) => {
      h2.mapUser(user, ssrc);
      const before = pushed;
      const stop = talk(h2, user, () => packet);
      await waitFor(() => pushed >= before + frames, 2000, `${frames} frames queued`);
      stop();
    };
    const mix = (ticks: number) => {
      for (let i = 0; i < ticks; i++) pipe.tick((now += 20));
    };
    return { election, t, h, pipe, out, admissions, speakFor, mix, pushed: () => pushed };
  }

  it("frames queued before a departure are dropped at mix; after a rejoin only frames under the new admission reach TeamSpeak", async () => {
    const { t, h, pipe, out, admissions, speakFor, mix } = await pipelineReceiver();
    try {
      await speakFor(h, "human", 4100, 6);
      mix(1);
      assert.equal(out.length, 1, "control: a queued frame of a present human is mixed");
      const first = admissions[0];
      const mixer = (pipe as unknown as { mixer: { queuedFrames(): number } }).mixer;
      const queued = mixer.queuedFrames();
      assert.ok(queued >= 1, `frames are queued (${queued})`);
      t.voice("human", null); // departs with frames still queued
      mix(20);
      assert.equal(out.length, 1, "forwarding: none of the queued frames reached TeamSpeak after the departure");
      assert.equal(mixer.queuedFrames(), 0);
      assert.ok(pipe.admissionDropped >= queued, `all ${queued} were dropped by the admission check at mix (${pipe.admissionDropped})`);

      t.voice("human", "channel-1");
      await tick(250); // the old stream ended; the next speech opens a new one
      const droppedBefore = pipe.admissionDropped;
      await speakFor(h, "human", 4100, 3);
      const second = admissions[admissions.length - 1];
      assert.notEqual(second, first);
      mix(20);
      assert.ok(out.length >= 4, `frames under the new admission are mixed (${out.length - 1})`);
      assert.equal(pipe.admissionDropped, droppedBefore, "and none of them was refused");
    } finally {
      await t.bot.destroy();
      pipe.dispose();
    }
  });

  it("a departure and a rejoin with no packet or check in between still end the old admission: frames queued before it are not mixed", async () => {
    const { t, h, pipe, out, admissions, speakFor, mix } = await pipelineReceiver();
    try {
      await speakFor(h, "human", 4150, 4);
      const mixer = (pipe as unknown as { mixer: { queuedFrames(): number } }).mixer;
      const queued = mixer.queuedFrames();
      assert.ok(queued >= 1, `frames are queued (${queued})`);
      const old = admissions[0];
      t.voice("human", null);
      t.voice("human", "channel-1"); // back before anything looked: the voice state says present again
      assert.equal(t.bot.humanAdmitted("human", old), false, "the departure itself ended the admission");
      mix(20);
      assert.equal(out.length, 0, "nothing queued under the old admission reached TeamSpeak");
      assert.ok(pipe.admissionDropped >= queued);
    } finally {
      await t.bot.destroy();
      pipe.dispose();
    }
  });

  it("a new receive session invalidates every admission of the old one: queued and late-delivered frames from it are dropped", async () => {
    const { election, t, h, pipe, out, admissions, speakFor, mix } = await pipelineReceiver();
    try {
      await speakFor(h, "human", 4200, 5);
      const old = admissions[0];
      t.bot.stopReceive();
      assert.equal(t.bot.startReceive(election.generation), true, "same election generation: only the admission fence distinguishes the sessions");
      assert.equal(t.bot.humanAdmitted("human", old), false);
      mix(20);
      assert.equal(out.length, 0, "frames queued under the old session never reach TeamSpeak");
      const dropped = pipe.admissionDropped;
      pipe.onDiscordOpus("slot-0", election.generation, "human", validOpus(), 0, old); // a delayed callback from the old session
      assert.equal(pipe.admissionDropped, dropped + 1, "a late frame under the old admission is refused at push");
      pipe.onDiscordOpus("slot-0", election.generation, "human", validOpus(), 0, undefined);
      assert.equal(pipe.admissionDropped, dropped + 2, "and so is a frame that carries no admission at all");
      mix(5);
      assert.equal(out.length, 0);

      await tick(250);
      await speakFor(h, "human", 4200, 3);
      const current = admissions[admissions.length - 1];
      assert.notEqual(current, old);
      t.bot.leave(); // the bot's session ends with frames queued
      assert.equal(t.bot.humanAdmitted("human", current), false, "leave() ends every admission");
      mix(20);
      assert.equal(out.length, 0, "nothing queued before leave() is mixed after it");
    } finally {
      await t.bot.destroy();
      pipe.dispose();
    }
  });

  it("a replacement bot instance never honours an admission of the instance it replaced", async () => {
    const first = await pipelineReceiver();
    await first.speakFor(first.h, "human", 4300, 2);
    const old = first.admissions[0];
    await first.t.bot.destroy();
    first.pipe.dispose();
    assert.equal(first.t.bot.humanAdmitted("human", old), false, "the destroyed instance refuses it");
    const second = await pipelineReceiver();
    try {
      assert.equal(second.t.bot.humanAdmitted("human", old), false, "and so does its replacement");
      second.pipe.onDiscordOpus("slot-0", second.election.generation, "human", validOpus(), 0, old);
      second.mix(5);
      assert.equal(second.out.length, 0);
      assert.equal(second.pipe.admissionDropped, 1);
    } finally {
      await second.t.bot.destroy();
      second.pipe.dispose();
    }
  });
});

describe("underlying identity requests are counted until they settle (R1-B, R1-C), real REST queue", () => {
  it("repeated leave and rejoin while the request is out: one REST operation, then the answer admits only while present", async () => {
    const { t, rest, got, speak, silence, admissionsOf } = await productionReceiver({ group: 30 });
    const user = snowflake(30, 1);
    try {
      speak(user);
      await waitFor(() => rest.counters.started.length === 1, 1000, "the identity request");
      for (let i = 0; i < 5; i++) {
        t.voice(user, null);
        await tick(30);
        t.voice(user, "channel-1");
        await tick(30);
      }
      assert.deepEqual(rest.counters.started, [userRoute(user)], "one REST operation for the user across five leave/rejoin cycles");
      assert.equal(rest.counters.maxOperations, 1);
      assert.equal(t.bot.identityLookups.waiting, 1, "the filter still waits on that one request");

      t.voice(user, null); // away when the answer arrives
      rest.open()[0].respond(apiUser(user, false));
      await waitFor(() => t.identityRequests!.stats().pending === 0, 1000, "the request settles");
      await tick(150);
      assert.equal(got.length, 0, "identity verified, but absent: not forwarded");
      t.voice(user, "channel-1");
      await waitFor(() => got.includes(user), 1500, "forwarded after a real rejoin");
      assert.equal(admissionsOf(user).length, 1, "with one fresh admission");
      assert.equal(rest.counters.started.length, 1, "and no second request");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });

  it("filter timeout, cooldown, session reset (leave), a new session and dispose (destroy) never release the requests or duplicate them", async () => {
    const { t, election, rest, speak, silence } = await productionReceiver({ group: 31, identityLookup: { lookupTimeoutMs: 20, retryMs: 20, maxRetryMs: 20 } });
    const users = [snowflake(31, 1), snowflake(31, 2), snowflake(31, 3)];
    try {
      for (const u of users) speak(u);
      await waitFor(() => rest.counters.operations === 3, 1000, "three identity requests");
      await tick(200); // many filter timeouts and cooldowns
      assert.equal(rest.counters.started.length, 3, "timeouts and cooldowns started nothing new");
      assert.equal(rest.counters.operations, 3, "and released nothing underneath");
      assert.equal(rest.counters.onWire, 1, "discord.js sends one GET /users/:id at a time per client: the others wait in its route queue");
      assert.deepEqual({ pending: t.bot.identityLookups.pending, stalled: t.bot.identityLookups.stalled }, { pending: 3, stalled: 3 });

      t.bot.leave(); // the session ends
      assert.equal(t.identityRequests!.stats().pending, 3, "a reset does not release them");
      await t.join({ receive: true });
      assert.equal(t.bot.startReceive(election.generation), true);
      await tick(150); // the same speakers are asked about again in the new session
      assert.equal(rest.counters.started.length, 3, "the new session joined the requests still out instead of repeating them");

      await t.bot.destroy();
      assert.equal(rest.counters.operations, 3, "destroy() (and Client.destroy()) did not cancel the REST operations");
      assert.equal(t.identityRequests!.stats().pending, 3, "so the registry still counts them");

      for (let i = 0; i < 3; i++) {
        await waitFor(() => rest.open().length === 1, 1000, "the next queued request on the wire");
        const w = rest.open()[0];
        w.respond(apiUser(userIdOf(w.url), false));
      }
      await waitFor(() => rest.counters.operations === 0, 1000, "every operation settled");
      await waitFor(() => t.identityRequests!.stats().pending === 0, 1000, "and only then are the slots free");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });

  it("eight indefinitely stalled requests: unknown speakers stay excluded, the diagnostics are the real count, and known humans keep speaking", async () => {
    const { t, rest, got, speak, silence } = await productionReceiver({ group: 32, identityLookup: { lookupTimeoutMs: 50 } });
    try {
      for (let i = 0; i < 12; i++) speak(snowflake(32, i));
      await tick(300);
      const stats = t.bot.identityLookups;
      assert.equal(rest.counters.operations, 8, "eight underlying REST operations are out");
      assert.equal(stats.pending, rest.counters.operations, "the reported count is the real one");
      assert.equal(stats.stalled, 8, "all eight past the stall threshold");
      assert.equal(stats.waiting, 8);
      assert.ok(stats.refused > 0, "the other four speakers were refused, not queued");
      assert.equal(rest.counters.onWire, 1, "one on the wire, seven in discord.js's route queue behind it");
      assert.equal(got.length, 0, "forwarding: no unknown speaker");
      assert.equal(t.bot.openSubscriptions, 0);
      assert.equal(t.bot.admittedHumans, 0);

      const friend = snowflake(32, 50);
      const otherBot = snowflake(32, 51);
      t.voice(friend, "channel-1", { member: { bot: false } });
      t.voice(otherBot, "channel-1", { member: { bot: true } });
      speak(friend);
      speak(otherBot);
      await waitFor(() => got.includes(friend), 1500, "a known, present human is forwarded while every slot is stalled");
      await tick(100);
      assert.ok(!got.includes(otherBot), "a known bot is not");
      assert.equal(rest.counters.operations, 8, "and neither needed a request");
      assert.equal(t.bot.admittedHumans, 1);
      t.voice(friend, null);
      const atDeparture = got.length;
      await tick(150);
      assert.equal(got.length, atDeparture, "the friend's departure still stops them at once");
    } finally {
      silence();
      await rest.drain();
      await t.bot.destroy();
    }
  });
});

describe("receiver failover, session teardown and participant churn (real runtime, six real bots)", () => {
  function speakOn(h: ReadyHandle, user: string, ssrc: number) {
    const packet = validOpus();
    h.mapUser(user, ssrc);
    return talk(h, user, () => packet);
  }

  it("receiver failover: the failed receiver's admissions are dead, the successor admits only present humans, and a departure stops TeamSpeak output", async () => {
    const r = realRuntime({ users: 2, timing: { readyMs: 1500 } });
    const seen: { bot: BotId; user: string; admission: Admission | undefined }[] = [];
    const forward = r.rt.onHumanOpus;
    (r.rt as unknown as { onHumanOpus: typeof forward }).onHumanOpus = (b, g, u, o, a) => {
      seen.push({ bot: b, user: u, admission: a });
      forward(b, g, u, o, a);
    };
    const stops: (() => number)[] = [];
    try {
      await r.rt.start();
      await r.rt.idle();
      const failedId = r.election.receiver as BotId;
      const failed = r.tests.get(failedId)!;
      const successorId = (["slot-1", "slot-0"] as BotId[]).find((id) => id !== failedId)!;
      const successor = r.tests.get(successorId)!;
      // On Discord every bot in the channel sees the same human: each bot's client has its own voice-state cache.
      stops.push(speakOn(failed.latest(), "human-a", 1111), speakOn(successor.latest(), "human-a", 1111));
      await waitFor(() => seen.some((s) => s.bot === failedId), 1500, "the first receiver forwards human-a");
      const old = seen.find((s) => s.bot === failedId)!.admission;

      failed.autoReady = false;
      failed.latest().davey.decryptError = new Error("DecryptionFailed"); // poisoned DAVE: failover
      await waitFor(() => r.election.receiver === successorId && seen.some((s) => s.bot === successorId), 3000, "the successor forwards human-a");
      const current = seen.find((s) => s.bot === successorId)!.admission;
      assert.notEqual(current, old, "the successor's admission is its own");
      assert.equal(failed.bot.humanAdmitted("human-a", old), false, "the failed receiver's admission is dead");
      assert.equal(successor.bot.humanAdmitted("human-a", old), false, "and the successor does not honour it");
      r.ts.out.length = 0;
      await waitFor(() => r.ts.out.length > 0, 600, "human-a reaches TeamSpeak through the successor");

      successor.voice("human-a", null);
      failed.voice("human-a", null);
      await tick(80); // let anything mixed before the departure drain
      r.ts.out.length = 0;
      await tick(250);
      assert.equal(r.ts.out.length, 0, "nothing from human-a reaches TeamSpeak after the departure, although their packets keep arriving");
      assert.equal(successor.bot.humanAdmitted("human-a", current), false);

      successor.voice("human-a", "channel-1");
      await waitFor(() => r.ts.out.length > 0, 1500, "a rejoin is heard again");
    } finally {
      for (const stop of stops) stop();
      await r.cleanup();
    }
  });

  it("participant churn: no departed user is ever mixed into TeamSpeak, every present human is, and identity requests stay bounded", async () => {
    const r = realRuntime({ users: 1 });
    const stops: (() => number)[] = [];
    try {
      await r.rt.start();
      await r.rt.idle();
      const receiver = r.tests.get(r.election.receiver as BotId)!;
      const absent = new Set<string>();
      const violations: string[] = [];
      const mixedAfterRejoin = new Set<string>();
      const mixer = (r.rt.d2t as unknown as { mixer: { tick(): { sources: string[] } | null } }).mixer;
      const mixTick = mixer.tick.bind(mixer);
      mixer.tick = () => {
        const res = mixTick();
        for (const s of res?.sources ?? []) {
          if (absent.has(s)) violations.push(s);
          else mixedAfterRejoin.add(s);
        }
        return res;
      };
      const humans = Array.from({ length: 6 }, (_, i) => `churn-${i}`);
      humans.forEach((u, i) => stops.push(speakOn(receiver.latest(), u, 3000 + i)));
      await waitFor(() => humans.every((u) => mixedAfterRejoin.has(u)), 2000, "every human mixed before the churn");
      for (let round = 0; round < 6; round++) {
        const leaving = humans.filter((_, i) => (i + round) % 2 === 0);
        for (const u of leaving) {
          receiver.voice(u, round % 3 === 0 ? "channel-2" : null);
          absent.add(u);
        }
        await tick(70);
        mixedAfterRejoin.clear();
        for (const u of leaving) {
          receiver.voice(u, "channel-1");
          absent.delete(u);
        }
        await tick(70);
      }
      await waitFor(() => humans.every((u) => mixedAfterRejoin.has(u)), 2000, "every human mixed again after the last rejoin");
      assert.deepEqual(violations, [], "no frame of an absent user was mixed");
      assert.ok(r.identityRequests.stats().pending <= 8);
      assert.ok(r.rt.status().d2t.admissionDropped >= 0);
    } finally {
      for (const stop of stops) stop();
      await r.cleanup();
    }
  });
});
