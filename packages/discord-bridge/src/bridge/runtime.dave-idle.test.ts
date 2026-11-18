import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { EndBehaviorType } from "@discordjs/voice";
import { isJoinCancelled } from "../core/join-errors.js";
import { labDaveDiagnostic } from "../lab/config.js";
import { createLogger } from "../core/redact.js";
import type { Admission } from "../core/voice-admission.js";
import type { ReadyHandle } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";

// Real runtime, DiscordBot, VoiceConnection, receiver and DAVESession wrapper. Only the network
// and native MLS state are simulated. A welcome here is an input, never a claim about Discord's
// server policy. Virtual time uses the actual 10 s join wait / 5 s loss grace, without sleeps.
const drain = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve)); // readable streams deliver on nextTick
};

async function advance(t: TestContext, ms: number): Promise<void> {
  for (let n = 0; n < ms; n += 100) {
    t.mock.timers.tick(Math.min(100, ms - n));
    await drain();
  }
}

function setup(t: TestContext, o: { humans?: boolean; ready?: boolean; users?: number; self?: boolean; watchdogMs?: number } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  const lines: string[] = [];
  const diag = labDaveDiagnostic({ D1_DAVE_SINGLE_ATTEMPT: "1" });
  const r = realRuntime({
    users: o.users ?? 0,
    daveReady: o.ready ?? false,
    timing: { readyMs: 20_000, daveWaitMs: 10_000, pollMs: 200, watchdogMs: o.watchdogMs ?? 100, daveGraceMs: 5_000, ...diag.timing },
    retry: diag.retry,
    log: createLogger("idle-regression", (s) => lines.push(s)),
  });
  for (const b of r.tests.values()) {
    b.autoVoice = false;
    if (o.self !== false) b.voice(b.bot.userId, "channel-1", { member: { bot: true } });
    if (o.humans) b.voice("human", "channel-1", { member: { bot: false } });
  }
  t.after(async () => {
    const cleanup = r.cleanup();
    await advance(t, 300);
    await cleanup;
    t.mock.timers.reset();
  });
  return { ...r, slot: r.tests.get("slot-0")!, lines };
}

function welcome(h: ReadyHandle): void {
  h.dave.setExternalSender(Buffer.alloc(1));
  assert.equal(h.dave.processWelcome(Buffer.alloc(3)).success, true);
  h.setDave({ ready: true }); // stand-in for the native MLS group becoming ready, not the bridge gate
}

describe("DAVE idle lifecycle (deterministic simulated Discord)", () => {
  it("empty-channel startup parks the transport beyond 10 s, with both audio boundaries closed", async (t) => {
    const r = setup(t);
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    h.dave.setExternalSender(Buffer.alloc(1));
    const opus = validOpus();
    assert.deepEqual(h.dave.encrypt(opus), opus, "the library would send plaintext without the bridge guard");
    const injected: Buffer[] = [];
    h.mapUser("probe", 123);
    const stream = h.conn.receiver.subscribe("probe", { end: { behavior: EndBehaviorType.Manual } });
    stream.on("data", (p) => injected.push(p));
    h.udp("probe", opus, { dave: false });
    assert.equal(h.conn.prepareAudioPacket(opus), undefined);
    assert.equal(h.conn.dispatchAudio(), false);
    assert.equal(h.conn.playOpusPacket(opus), undefined);
    r.slot.bot.sendOpus(opus);
    r.rt.onHumanOpus("slot-0", r.election.generation, "probe", opus);
    await advance(t, 30_000);
    assert.ok(r.slot.bot.voiceConnection === h.conn, "an empty MLS group is not a failed voice transport");
    assert.equal(r.slot.bot.healthy, false);
    assert.equal(r.slot.bot.daveEstablished(), false);
    assert.equal(r.election.receiver, null);
    assert.equal(r.slot.bot.openSubscriptions, 0);
    assert.deepEqual(h.networking.wire, []);
    assert.deepEqual(injected, []);
    assert.deepEqual(r.ts.out, []);
    assert.equal(r.slot.bot.daveNegotiation?.events.external_sender, 1);
    assert.equal(r.slot.bot.daveNegotiation?.events.welcome, undefined);
    assert.equal(r.slot.bot.rejoins, 0);
    stream.destroy();
  });

  it("human-first startup elects and undeafens only after an established MLS session", async (t) => {
    const r = setup(t, { humans: true });
    await r.rt.start();
    await drain();
    assert.equal(r.election.receiver, null);
    await advance(t, 9_000);
    welcome(r.slot.latest());
    await advance(t, 300);
    assert.equal(r.slot.bot.healthy, true);
    assert.equal(r.election.receiver, "slot-0");
    assert.equal(r.slot.bot.deaf, false);
    assert.ok(r.slot.bot.receiveDaveSession);
    assert.equal(r.slot.bot.rejoins, 0);
  });

  it("a late human gets a fresh bounded wait and can establish DAVE on the parked connection", async (t) => {
    const r = setup(t);
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    await advance(t, 30_000);
    r.slot.voice("human", "channel-1", { member: { bot: false } });
    await advance(t, 9_000);
    assert.equal(r.election.receiver, null, "membership never establishes DAVE");
    welcome(h);
    await advance(t, 300);
    assert.ok(r.slot.bot.voiceConnection === h.conn);
    assert.equal(r.election.receiver, "slot-0");
    assert.equal(r.slot.bot.rejoins, 0);
    assert.equal(r.slot.ready.length, 1);
  });

  it("a present human without a welcome still times out and permanent budget refusal is logged once across syncs", async (t) => {
    const r = setup(t, { humans: true });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    await advance(t, 10_100);
    assert.equal(h.conn.state.status, "destroyed");
    assert.equal(r.slot.bot.voiceConnection, null);
    assert.equal(r.election.receiver, null);
    for (let n = 1; n <= 4; n++) {
      r.ts.addUser(n);
      await drain();
      r.ts.removeUser(n);
      await drain();
    }
    const refused = r.lines.filter((s) => s.includes("slot-0 reconnect refused:"));
    assert.equal(refused.length, 1, "max=0 is a terminal refusal, not a warning on every sync");
    assert.equal(r.slot.ready.length, 1, "the budget already prevented actual reconnects");
    assert.equal(r.rt.status().scheduledReconnects, 0);
  });

  it("last-human departure fences queued audio, parks a lost session beyond 5 s, then uses fresh admissions", async (t) => {
    const r = setup(t, { humans: true, ready: true });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    const packet = validOpus();
    let admission: Admission | undefined;
    const forward = r.rt.onHumanOpus;
    (r.rt as unknown as { onHumanOpus: typeof forward }).onHumanOpus = (b, g, u, op, a) => {
      admission = a;
      forward(b, g, u, op, a);
    };
    h.mapUser("human", 456);
    h.udp("human", packet);
    await drain();
    assert.ok(admission, "the real receiver issued an admission");
    const gen = r.election.generation;
    r.slot.voice("human", null);
    h.setDave({ ready: false });
    assert.equal(h.conn.prepareAudioPacket(packet), undefined, "guard closes before the watchdog");
    h.udp("human", packet, { dave: false });
    r.rt.d2t.tick(20);
    assert.deepEqual(r.ts.out, [], "the frame queued before departure never reached TeamSpeak");
    await advance(t, 15_000);
    assert.ok(r.slot.bot.voiceConnection === h.conn);
    assert.equal(r.slot.bot.openSubscriptions, 0);
    assert.equal(r.election.admitFrame("slot-0", gen), false);
    assert.equal(r.slot.bot.humanAdmitted("human", admission), false);
    assert.deepEqual(h.networking.wire, []);
    r.slot.voice("human", "channel-1", { member: { bot: false } });
    await advance(t, 4_000);
    assert.ok(r.slot.bot.voiceConnection === h.conn);
    welcome(h);
    await advance(t, 300);
    assert.ok(r.election.generation > gen);
    assert.equal(r.slot.bot.humanAdmitted("human", admission), false);
    h.udp("human", packet);
    await drain();
    r.rt.d2t.tick(40);
    assert.ok(r.ts.out.length > 0, "fresh encrypted media flows after restoration");
  });

  it("last-human departure during initial negotiation resets the wait without a recovery charge", async (t) => {
    const r = setup(t, { humans: true });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    await advance(t, 9_000);
    r.slot.voice("human", null);
    await advance(t, 20_000);
    r.slot.voice("human", "channel-1", { member: { bot: false } });
    await advance(t, 9_000);
    assert.ok(r.slot.bot.voiceConnection === h.conn);
    welcome(h);
    await advance(t, 300);
    assert.equal(r.slot.bot.healthy, true);
    assert.equal(r.slot.bot.rejoins, 0);
  });

  it("membership welcomes keep the session identity, while an in-place reinit fences the receive generation", async (t) => {
    const r = setup(t, { humans: true, ready: true });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    const session = r.slot.bot.receiveDaveSession;
    const generation = r.election.generation;
    r.slot.voice("second-human", "channel-1", { member: { bot: false } });
    welcome(h);
    await advance(t, 300);
    assert.equal(r.slot.bot.receiveDaveSession, session);
    assert.equal(r.election.generation, generation);
    h.reinitDave(); // fake native remains ready: availability polling alone would miss this reset
    await advance(t, 300);
    assert.ok(r.slot.bot.receiveDaveSession! > session!);
    assert.ok(r.election.generation > generation);
    assert.equal(r.election.admitFrame("slot-0", generation), false);
    assert.equal(r.slot.ready.length, 1);
  });

  it("grace expiry reads live DAVE readiness even when the watchdog has not seen restoration", async (t) => {
    const r = setup(t, { humans: true, ready: true, watchdogMs: 10_000 });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    h.setDave({ ready: false });
    assert.equal(r.slot.bot.daveEstablished(), false); // boundary schedules loss observation
    await drain();
    await advance(t, 4_900);
    welcome(h);
    await advance(t, 200);
    assert.ok(r.slot.bot.voiceConnection === h.conn, "a stale cached flag cannot destroy a restored connection");
    assert.equal(r.slot.bot.healthy, true);
    assert.equal(r.election.admitFrame("slot-0", r.election.generation), true);
  });

  it("a returning human without DAVE exhausts the loss grace and fails closed", async (t) => {
    const r = setup(t, { humans: true, ready: true });
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    r.slot.voice("human", null);
    h.setDave({ ready: false });
    await advance(t, 15_000);
    assert.ok(r.slot.bot.voiceConnection === h.conn);
    r.slot.voice("human", "channel-1", { member: { bot: false } });
    await advance(t, 5_200);
    assert.equal(r.slot.bot.voiceConnection, null);
    assert.equal(r.slot.bot.healthy, false);
    assert.equal(r.election.admitFrame("slot-0", r.election.generation), false);
    assert.equal(r.slot.ready.length, 1);
  });

  it("leave during the last DAVE poll is cancellation and does not poison a later planned join", async (t) => {
    const r = setup(t, { humans: true });
    const joining = r.slot.bot.join({ receive: true });
    const outcome = joining.catch((e: unknown) => e);
    await drain();
    await advance(t, 9_900);
    r.slot.bot.leave();
    await advance(t, 200);
    assert.ok(isJoinCancelled(await outcome), "the timeout path must re-check cancellation after its last sleep");
    const next = r.slot.bot.join({ receive: true });
    const nextOutcome = next.catch((e: unknown) => e);
    await drain();
    welcome(r.slot.latest());
    await advance(t, 300);
    assert.equal(await nextOutcome, undefined);
    assert.equal(r.slot.bot.healthy, true);
    assert.equal(r.slot.bot.rejoins, 0);
  });

  it("TeamSpeak membership cancels an unwanted pending join before it can become a receiver", async (t) => {
    const r = setup(t, { users: 2 });
    await r.rt.start();
    await drain();
    const other = r.tests.get("slot-1")!;
    const h = other.latest();
    const oldSession = other.bot.daveSession;
    assert.equal(h.conn.state.status, "ready");
    r.ts.removeUser(2);
    await drain();
    await advance(t, 300);
    assert.ok(other.bot.voiceConnection === null, "pending joins are membership intents too");
    assert.equal(h.conn.state.status, "destroyed");
    assert.equal(other.bot.healthy, false);
    assert.equal(other.bot.rejoins, 0);
    assert.equal(r.rt.status().inChannel.includes("slot-1"), false);
    assert.equal(r.election.admitFrame("slot-1", r.election.generation), false);
    r.ts.addUser(2);
    await drain();
    const fresh = other.latest();
    assert.ok(fresh.conn !== h.conn, "new membership intent uses a fresh connection");
    assert.ok(other.bot.daveSession! > oldSession!);
    welcome(fresh);
    await advance(t, 300);
    assert.equal(other.bot.healthy, true);
    assert.equal(other.bot.rejoins, 0, "intentional cancellation did not consume the zero recovery budget");
    assert.equal(r.election.receiver, "slot-1", "only the bot with established DAVE is elected");
  });

  it("shutdown cancels an empty-channel DAVE wait and never creates another connection", async (t) => {
    const r = setup(t);
    await r.rt.start();
    await drain();
    const h = r.slot.latest();
    const stopping = r.rt.stop();
    await advance(t, 500);
    await stopping;
    await advance(t, 30_000);
    assert.equal(r.rt.status().state, "stopped");
    assert.equal(h.conn.state.status, "destroyed");
    assert.equal(r.slot.bot.voiceConnection, null);
    assert.equal(r.slot.ready.length, 1);
    assert.equal(r.rt.status().scheduledReconnects, 0);
    assert.equal(r.slot.bot.openSubscriptions, 0);
    assert.equal(r.lines.some((s) => s.includes("DAVE not negotiated")), false);
  });

  for (const state of ["missing-self", "unknown-peer", "protocol-zero", "unknown-voice-peer"] as const) {
    it(`${state} cannot be mistaken for a known bots-only channel`, async (t) => {
      const r = setup(t, { self: state !== "missing-self" });
      if (state === "unknown-peer") r.slot.voice("unknown", "channel-1");
      await r.rt.start();
      await drain();
      if (state === "protocol-zero") r.slot.latest().setDave({ protocolVersion: 0 });
      if (state === "unknown-voice-peer") (r.slot.latest().networking.state.connectionData.connectedClients as Set<string>).add("ghost");
      await advance(t, 10_300);
      assert.equal(r.slot.bot.voiceConnection, null);
      assert.equal(r.slot.bot.healthy, false);
      assert.equal(r.election.receiver, null);
      assert.deepEqual(r.ts.out, []);
    });
  }
});
