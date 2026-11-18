/**
 * DAVE session replacement (finding 1 of the review of 08041a9): an established session replaced by
 * another established session must end every admission of the old one, at once and for good.
 *
 * Two ways a session is replaced are exercised, both on the real `@discordjs/voice` classes:
 * - `replaceDave()`: a new DAVESession wrapper (and native session) on the same connection.
 * - `reinitDave()`: the library's own `DAVESession.reinit()` on the live wrapper (an invalid
 *   transition, a new epoch 1). The connection, Networking, wrapper and native session objects all
 *   stay the same, and the fake native session never stops being ready, so nothing that only watches
 *   whether DAVE is available can see it happen.
 *
 * The watchdog is held off (5 s) in every boundary test, and the replacement and the mix run in one
 * synchronous stretch, so no timer, microtask or watchdog can be what stops a stale frame: only the
 * checks at packet reception and immediately before the mix can.
 *
 * Simulated Discord evidence, never live.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DiscordToTsPipeline } from "../core/discord-to-ts.js";
import type { BotId } from "../core/ids.js";
import { preferredOrder } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import type { Admission } from "../core/voice-admission.js";
import { talk, testBot, tick, waitFor, type ReadyHandle } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

const REPLACEMENTS = [
  ["a new DAVE session object (replaceDave)", (h: ReadyHandle) => void h.replaceDave()],
  ["the library's in-place DAVESession.reinit() (same objects, never unready)", (h: ReadyHandle) => h.reinitDave()],
] as const;

function newElection() {
  const election = new ReceiverElection(preferredOrder(5));
  election.setState("slot-0", { healthy: true, inChannel: true });
  election.reconcile("start");
  return election;
}

/** A real bot feeding a real Discord-to-TeamSpeak pipeline that the test mixes by hand, so frames can be held in the queue. */
async function pipelineReceiver(o: { watchdogMs?: number } = {}) {
  const election = newElection();
  const out: Buffer[] = [];
  const admissions: Admission[] = [];
  let pushed = 0;
  let now = 0;
  let pipe!: DiscordToTsPipeline;
  const t = testBot("slot-0", election, {
    timing: { watchdogMs: o.watchdogMs ?? 5000 },
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
    daveLive: () => t.bot.daveEstablished(),
    admitted: (_b, user, a) => t.bot.humanAdmitted(user, a),
  });
  const h = await t.join({ receive: true });
  assert.equal(t.bot.startReceive(election.generation), true);
  const packet = validOpus();
  const speakFor = async (user: string, ssrc: number, frames: number) => {
    h.mapUser(user, ssrc);
    const before = pushed;
    const stop = talk(h, user, () => packet);
    await waitFor(() => pushed >= before + frames, 2000, `${frames} frames queued`);
    stop();
  };
  const mixer = (pipe as unknown as { mixer: { queuedFrames(): number } }).mixer;
  const mix = (ticks: number) => {
    for (let i = 0; i < ticks; i++) pipe.tick((now += 20));
  };
  return { election, t, h, pipe, out, admissions, speakFor, mix, mixer };
}

describe("DAVE session replacement: Codex's queued-frame reproduction (finding 1)", () => {
  for (const [how, replace] of REPLACEMENTS) {
    it(`real runtime: a frame queued under session A is not mixed after session A is replaced by ${how}`, async (c) => {
      const r = realRuntime({ users: 1, timing: { watchdogMs: 5000 } });
      try {
        await r.rt.start();
        await r.rt.idle();
        const receiver = r.election.receiver!;
        const t = r.tests.get(receiver)!;
        const h = t.latest();
        let admission: Admission | undefined;
        const forward = r.rt.onHumanOpus;
        (r.rt as unknown as { onHumanOpus: typeof forward }).onHumanOpus = (b, g, u, op, a) => {
          admission ??= a;
          forward(b, g, u, op, a);
        };
        const packet = validOpus();
        h.mapUser("human", 4321);
        const stop = talk(h, "human", () => packet);
        await waitFor(() => admission, 1500, "a receiver-issued admission");
        stop();
        await tick(150); // everything said so far is mixed out

        // One synchronous stretch: queue under A, replace A with B, mix.
        r.ts.out.length = 0;
        const gen = r.election.generation;
        assert.equal(t.bot.humanAdmitted("human", admission), true, "control: the admission is valid under session A");
        r.rt.onHumanOpus(receiver, gen, "human", validOpus(), admission);
        replace(h);
        r.rt.d2t.tick(20);
        const staleForwarded = r.ts.out.length;
        c.diagnostic(`finding 1 (${how}): staleFramesForwarded=${staleForwarded} admissionDropped=${r.rt.status().d2t.admissionDropped}`);
        assert.equal(staleForwarded, 0, `no frame queued under session A reaches TeamSpeak (saw ${staleForwarded})`);
        assert.equal(t.bot.humanAdmitted("human", admission), false, "the old admission is rejected at the last boundary");
      } finally {
        await r.cleanup();
      }
    });
  }

  for (const [how, replace] of REPLACEMENTS) {
    it(`bare pipeline: every frame queued under session A is dropped at the mixer after ${how}, and none is forwarded`, async (c) => {
      const { t, h, pipe, out, admissions, speakFor, mix, mixer } = await pipelineReceiver();
      try {
        await speakFor("human", 4100, 6);
        const queued = mixer.queuedFrames();
        assert.ok(queued >= 1, `frames are queued (${queued})`);
        const old = admissions[0];
        replace(h);
        mix(20);
        c.diagnostic(`finding 1 bare (${how}): queued=${queued} staleFramesForwarded=${out.length} admissionDropped=${pipe.admissionDropped}`);
        assert.equal(out.length, 0, `none of the ${queued} queued frames reached TeamSpeak (saw ${out.length})`);
        assert.ok(pipe.admissionDropped >= queued, `all ${queued} were refused by the admission check at mix (${pipe.admissionDropped})`);
        assert.equal(t.bot.humanAdmitted("human", old), false);
      } finally {
        await t.bot.destroy();
        pipe.dispose();
      }
    });
  }
});

/** Re-elect like the runtime does: a teardown stops reception, an election starts it under the new generation. */
function followElection(t: ReturnType<typeof testBot>, election: ReceiverElection, onTeardown?: () => void) {
  election.on("teardown", ({ bot }: { bot: BotId }) => {
    if (bot !== t.bot.id) return;
    t.bot.stopReceive();
    onTeardown?.();
  });
  election.on("elected", ({ bot, generation }: { bot: BotId; generation: number }) => {
    if (bot === t.bot.id) t.bot.startReceive(generation);
  });
}

describe("DAVE session replacement on the bot: old admissions end for good, the new session gets its own", () => {
  for (const [how, replace] of REPLACEMENTS) {
    it(`after ${how}: the old admission is permanently rejected, late callbacks under it are refused, and a fresh admission under the new session is heard`, async (c) => {
      const { election, t, h, pipe, out, admissions, speakFor, mix } = await pipelineReceiver();
      followElection(t, election, () => pipe.flush());
      try {
        await speakFor("human", 4400, 3);
        mix(10);
        const old = admissions[0];
        const before = { session: t.bot.daveSession, receive: t.bot.receiveDaveSession, generation: election.generation };
        assert.equal(old.session, before.receive, "the admission carries the session its generation was bound to");
        out.length = 0;

        replace(h);
        assert.equal(t.bot.humanAdmitted("human", old), false, "rejected at the first check after the replacement, before any reaction");
        const droppedBefore = pipe.admissionDropped;
        pipe.onDiscordOpus("slot-0", before.generation, "human", validOpus(), 0, old); // a delayed callback from session A
        assert.equal(pipe.admissionDropped, droppedBefore + 1, "a late frame under the old admission is refused at push");

        await speakFor("human", 4400, 3); // the human keeps talking: heard again under the new session
        const fresh = admissions[admissions.length - 1];
        mix(10);
        const after = { session: t.bot.daveSession, receive: t.bot.receiveDaveSession, generation: election.generation };
        c.diagnostic(`session fencing (${how}): before=${JSON.stringify(before)} after=${JSON.stringify(after)} oldAdmission.session=${old.session} freshAdmission.session=${fresh.session} replacements=${t.bot.daveReplacements}`);
        assert.notEqual(fresh, old);
        assert.ok(after.session! > before.session!, "the new session has a later epoch");
        assert.equal(fresh.session, after.session, "the fresh admission is bound to the new session");
        assert.ok(after.generation > before.generation, "and was issued under a new receive generation");
        assert.ok(out.length > 0, "frames under the fresh admission reach TeamSpeak");
        assert.equal(t.bot.daveReplacements, 1);
        assert.equal(t.bot.humanAdmitted("human", old), false, "the old admission stays dead after the new one was issued");
        assert.equal(t.bot.humanAdmitted("human", fresh), true);
      } finally {
        await t.bot.destroy();
        pipe.dispose();
      }
    });
  }

  it("the old subscription is closed and its stream callbacks are stale; no user ever holds two streams or forwards a packet twice", async () => {
    const election = newElection();
    const got: { user: string; seq: number; admission: Admission }[] = [];
    const t = testBot("slot-0", election, { timing: { watchdogMs: 5000 }, onHumanOpus: (_b, _g, user, opus, admission) => got.push({ user, seq: opus[1], admission }) });
    followElection(t, election);
    const h = await t.join({ receive: true });
    assert.equal(t.bot.startReceive(election.generation), true);
    const users = ["h1", "h2", "h3"];
    const stops = users.map((u, i) => {
      h.mapUser(u, 5000 + i);
      return talk(h, u);
    });
    const maxStreams: number[] = [];
    const sample = setInterval(() => maxStreams.push(h.conn.receiver.subscriptions.size), 2);
    try {
      await waitFor(() => users.every((u) => got.some((g) => g.user === u)), 1500, "all three heard under session A");
      const oldAdmissions = new Set(got.map((g) => g.admission));
      const oldSession = t.bot.receiveDaveSession;
      const oldStreams = users.map((u) => h.conn.receiver.subscriptions.get(u));
      const at = got.length;
      h.reinitDave(); // mid-speech, all three talking
      await waitFor(() => users.every((u) => got.slice(at).some((g) => g.user === u && !oldAdmissions.has(g.admission))), 1500, "all three heard under session B");
      const afterReplacement = got.slice(at);
      assert.deepEqual(afterReplacement.filter((g) => oldAdmissions.has(g.admission) && g.admission.session === oldSession).length, 0, "no packet was forwarded under a session A admission after the replacement");
      for (const s of oldStreams) assert.ok(s?.destroyed, "every session A stream was closed");
      for (const u of users) {
        const seqs = got.filter((g) => g.user === u).map((g) => g.seq);
        assert.equal(new Set(seqs).size, seqs.length, `no packet of ${u} was forwarded twice`);
      }
      assert.ok(Math.max(...maxStreams) <= users.length, `never more than one stream per user (max ${Math.max(...maxStreams)})`);
      assert.equal(t.bot.openSubscriptions, users.length);
      assert.deepEqual(election.duplicateReceivers(), []);
    } finally {
      clearInterval(sample);
      for (const s of stops) s();
      await t.bot.destroy();
    }
  });

  it("DAVE unavailable, re-initialised during the outage, then established: reception resumes under a fresh admission and the old one stays dead", async () => {
    const election = newElection();
    const got: Admission[] = [];
    const t = testBot("slot-0", election, { onHumanOpus: (_b, _g, _u, _o, a) => got.push(a) }); // watchdog at 5 ms: the loss is seen
    followElection(t, election);
    const h = await t.join({ receive: true });
    assert.equal(t.bot.startReceive(election.generation), true);
    h.mapUser("human", 5100);
    const stop = talk(h, "human");
    try {
      await waitFor(() => got.length > 0, 1500, "heard before the outage");
      const old = got[0];
      h.setDave({ ready: false });
      await waitFor(() => t.bot.receiveDaveSession === null, 1000, "reception stopped by the loss");
      h.reinitDave();
      h.setDave({ ready: true });
      await waitFor(() => got.some((a) => a !== old), 1500, "heard again after DAVE returned");
      const fresh = got[got.length - 1];
      assert.ok(fresh.session > old.session, `the fresh admission is bound to a later session (${old.session} -> ${fresh.session})`);
      assert.equal(t.bot.humanAdmitted("human", old), false);
      assert.equal(t.bot.daveReplacements, 0, "this went through the loss path, not the replacement path");
    } finally {
      stop();
      await t.bot.destroy();
    }
  });

  it("processWelcome after startReceive is not a session replacement; reinit still is", async () => {
    const election = newElection();
    const t = testBot("slot-0", election);
    followElection(t, election);
    const h = await t.join({ receive: true });
    assert.equal(t.bot.startReceive(election.generation), true);
    const bound = t.bot.daveSession;
    h.dave.processWelcome(Buffer.from([0, 0, 0, 0]));
    await tick(80);
    assert.equal(t.bot.daveReplacements, 0, "welcome after bind is the same session (live welcome:ok#0)");
    assert.equal(t.bot.daveSession, bound);
    assert.equal(t.bot.healthy, true);
    h.reinitDave();
    await tick(80);
    assert.equal(t.bot.daveReplacements, 1);
    await t.bot.destroy();
  });

  it("fail closed: a session the bot cannot identify (its wrapper cannot be instrumented) admits nobody and forwards nothing", async () => {
    const { election, t, h, pipe, out, admissions, speakFor, mix } = await pipelineReceiver();
    try {
      await speakFor("human", 4500, 2);
      mix(10);
      const old = admissions[0];
      out.length = 0;
      const pushedBefore = admissions.length;
      Object.freeze(h.replaceDave()); // a session object nothing can be attached to
      assert.equal(t.bot.daveSession, null, "no identity for it");
      assert.equal(t.bot.daveEstablished(), false, "so DAVE counts as not established");
      assert.equal(t.bot.humanAdmitted("human", old), false);
      h.mapUser("human", 4500);
      const stop = talk(h, "human");
      await tick(150);
      stop();
      mix(10);
      assert.equal(admissions.length, pushedBefore, "no packet reached the bot's output");
      assert.equal(out.length, 0, "and nothing reached TeamSpeak");
      assert.equal(t.bot.startReceive(election.generation), false, "and reception cannot be started on it");
    } finally {
      await t.bot.destroy();
      pipe.dispose();
    }
  });
});

describe("DAVE session replacement in the real runtime (six real bots)", () => {
  function speakOn(h: ReadyHandle, user: string, ssrc: number) {
    const packet = validOpus();
    h.mapUser(user, ssrc);
    return talk(h, user, () => packet);
  }

  /** Records which admissions were mixed into TeamSpeak, tick by tick. */
  function watchMix(r: ReturnType<typeof realRuntime>) {
    const mixed: Admission[] = [];
    const mixer = (r.rt.d2t as unknown as { mixer: { tick(): { metas: { admission?: Admission }[] } | null } }).mixer;
    const mixTick = mixer.tick.bind(mixer);
    mixer.tick = () => {
      const res = mixTick();
      for (const m of res?.metas ?? []) if (m.admission) mixed.push(m.admission);
      return res;
    };
    return mixed;
  }

  it("replacement during simultaneous speech: nothing under a session A admission is mixed afterwards, and every speaker is heard again under session B", async (c) => {
    const r = realRuntime({ users: 1, timing: { watchdogMs: 5000 } });
    const stops: (() => number)[] = [];
    try {
      await r.rt.start();
      await r.rt.idle();
      const receiver = r.tests.get(r.election.receiver as BotId)!;
      const mixed = watchMix(r);
      const users = ["s1", "s2", "s3"];
      users.forEach((u, i) => stops.push(speakOn(receiver.latest(), u, 6000 + i)));
      await waitFor(() => users.every((u) => mixed.some((a) => a.userId === u)), 2000, "all three mixed under session A");
      const oldAdmissions = new Set(mixed);
      const at = mixed.length;
      receiver.latest().reinitDave();
      await waitFor(() => users.every((u) => mixed.slice(at).some((a) => a.userId === u && !oldAdmissions.has(a))), 2000, "all three mixed under session B");
      const stale = mixed.slice(at).filter((a) => oldAdmissions.has(a)).length;
      c.diagnostic(`simultaneous speech: staleFramesMixedAfterReplacement=${stale} framesMixedAfter=${mixed.length - at} replacements=${receiver.bot.daveReplacements} duplicateReceivers=${r.election.duplicateReceivers().length}`);
      assert.equal(stale, 0, `no frame under a session A admission was mixed after the replacement (saw ${stale})`);
      assert.deepEqual(r.election.duplicateReceivers(), []);
      assert.equal(receiver.bot.openSubscriptions, users.length, "one stream per speaker");
    } finally {
      for (const s of stops) s();
      await r.cleanup();
    }
  });

  it("replacement during receiver failover: the successor binds the session in force, a replacement after it starts receiving ends its admissions, and only it is heard", async () => {
    const r = realRuntime({ users: 2, timing: { readyMs: 1500, watchdogMs: 5000 } });
    const seen: { bot: BotId; admission: Admission | undefined }[] = [];
    const forward = r.rt.onHumanOpus;
    (r.rt as unknown as { onHumanOpus: typeof forward }).onHumanOpus = (b, g, u, o, a) => {
      seen.push({ bot: b, admission: a });
      forward(b, g, u, o, a);
    };
    const stops: (() => number)[] = [];
    try {
      await r.rt.start();
      await r.rt.idle();
      const mixed = watchMix(r);
      const failedId = r.election.receiver as BotId;
      const failed = r.tests.get(failedId)!;
      const successorId = (["slot-1", "slot-0"] as BotId[]).find((id) => id !== failedId)!;
      const successor = r.tests.get(successorId)!;
      stops.push(speakOn(failed.latest(), "human-a", 1111), speakOn(successor.latest(), "human-a", 1111));
      await waitFor(() => seen.some((s) => s.bot === failedId), 1500, "the first receiver forwards human-a");

      // The successor's session is replaced as it is elected, before it has started receiving.
      r.election.once("elected", ({ bot }: { bot: BotId }) => {
        if (bot === successorId) successor.latest().replaceDave();
      });
      failed.autoReady = false;
      failed.latest().davey.decryptError = new Error("DecryptionFailed"); // poisoned: failover
      await waitFor(() => r.election.receiver === successorId && seen.some((s) => s.bot === successorId), 3000, "the successor forwards human-a");
      const first = seen.find((s) => s.bot === successorId)!.admission!;
      assert.equal(first.session, successor.bot.receiveDaveSession, "bound to the session in force when it started, not the one before");

      const at = mixed.length;
      successor.latest().reinitDave(); // and again while it is receiving
      assert.equal(successor.bot.humanAdmitted("human-a", first), false);
      await waitFor(() => seen.some((s) => s.bot === successorId && s.admission !== first && s.admission!.session > first.session), 2000, "a fresh admission under the next session");
      await waitFor(() => mixed.slice(at).some((a) => a !== first), 2000, "mixed under it");
      assert.equal(mixed.slice(at).filter((a) => a === first).length, 0, "nothing under the replaced session's admission was mixed after it");
      assert.ok(!seen.slice(seen.findIndex((s) => s.bot === successorId)).some((s) => s.bot === failedId), "the failed receiver forwards nothing after the failover");
      assert.deepEqual(r.election.duplicateReceivers(), []);
    } finally {
      for (const s of stops) s();
      await r.cleanup();
    }
  });
});
