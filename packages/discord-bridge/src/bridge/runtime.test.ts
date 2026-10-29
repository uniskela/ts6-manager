import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOrder, type BotId } from "../core/ids.js";
import { tsNickname } from "../core/nickname.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger } from "../core/redact.js";
import { FakeBot, FakeTs, settle as settleRuntime } from "../testing/fake-runtime.js";
import { BridgeRuntime, nickErrorKind } from "./runtime.js";

const quiet = createLogger("test", () => undefined);

async function build() {
  const ts = new FakeTs();
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
  const rt = new BridgeRuntime({ ts, bots, codecFactory: () => createOpusCodec("auto"), log: quiet });
  const settle = () => settleRuntime(rt);
  return { ts, bots, rt, settle };
}

describe("BridgeRuntime idle-overflow and receiver rules (simulated Discord, orchestration level)", () => {
  it("0 TeamSpeak users: only slot 0 is in Discord as the receiver and keeps its application name", async () => {
    const { bots, rt, settle } = await build();
    await rt.start();
    await settle();
    assert.deepEqual(rt.status().inChannel, ["slot-0"]);
    assert.equal(rt.status().receiver, "slot-0");
    assert.equal(bots.get("slot-0")!.nick, null);
    assert.equal(bots.get("overflow")!.inVoice, false);
    assert.equal(bots.get("slot-0")!.receiving, rt.status().generation);
    await rt.stop();
  });

  it("1-5 TeamSpeak users: those slot bots join as [TS] Username and overflow stays out", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1, "Alice");
    ts.addUser(2, "Bob");
    await settle();
    assert.deepEqual(rt.status().inChannel, ["slot-0", "slot-1"]);
    assert.equal(bots.get("slot-0")!.nick, "[TS] Alice");
    assert.equal(bots.get("slot-1")!.nick, "[TS] Bob");
    assert.equal(bots.get("overflow")!.inVoice, false);
    assert.equal(rt.status().duplicateReceivers.length, 0);
    await rt.stop();
  });

  it("6th user brings in [TS] Others and receive moves to overflow with teardown first; it moves back before overflow leaves", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    for (let i = 1; i <= 5; i++) ts.addUser(i);
    await settle();
    const gen5 = rt.status().generation;
    assert.equal(rt.status().receiver, "slot-0");
    ts.addUser(6);
    await settle();
    assert.equal(bots.get("overflow")!.nick, "[TS] Others");
    assert.equal(rt.status().receiver, "overflow");
    assert.ok(rt.status().generation > gen5);
    assert.equal(bots.get("slot-0")!.receiving, null, "old receiver dropped its subscriptions");
    assert.ok(bots.get("slot-0")!.log.includes("stopReceive"));
    assert.equal(bots.get("overflow")!.deaf, false, "overflow joined undeafened to receive");
    assert.equal(bots.get("overflow")!.receiving, rt.status().generation);

    ts.removeUser(6);
    await settle();
    assert.equal(rt.status().receiver !== "overflow", true);
    assert.equal(bots.get("overflow")!.inVoice, false, "[TS] Others left once empty");
    assert.equal(bots.get("overflow")!.nick, null);
    assert.equal(rt.status().inChannel.includes("overflow"), false);
    const log = bots.get("overflow")!.log;
    assert.ok(log.indexOf("stopReceive") < log.lastIndexOf("leave"), "receive moved off overflow before it left");
    await rt.stop();
  });

  it("killing the receiver elects exactly one successor and the old bot cannot resubscribe", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    ts.addUser(2);
    await settle();
    const dead = rt.status().receiver!;
    const oldGen = rt.status().generation;
    bots.get(dead)!.die();
    await settle();
    const s = rt.status();
    assert.notEqual(s.receiver, null);
    assert.notEqual(s.receiver, dead);
    assert.ok(s.generation > oldGen);
    assert.equal(s.duplicateReceivers.length, 0);
    const receivers = [...bots.values()].filter((b) => b.receiving !== null);
    assert.equal(receivers.length, 1, "exactly one bot holds human subscriptions");
    assert.equal(rt.election.admitSubscribe(dead as BotId, oldGen), false);
    await rt.stop();
  });

  it("killing the receiver mid-speech: stale frames fenced, TeamSpeak hears one copy per tick", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    ts.addUser(2);
    await settle();
    const dead = rt.status().receiver!;
    const oldGen = rt.status().generation;
    const enc = createOpusCodec("auto");
    for (let f = 0; f < 3; f++) rt.onHumanOpus(dead, oldGen, "human", enc.encode(toneFrame(440, f * 960)), );
    bots.get(dead)!.die();
    await settle();
    const successor = rt.status().receiver!;
    const gen = rt.status().generation;
    const before = ts.out.length;
    for (let f = 3; f < 8; f++) {
      rt.onHumanOpus(dead, oldGen, "human", enc.encode(toneFrame(440, f * 960))); // late callbacks from the dead bot
      rt.onHumanOpus(successor, gen, "human", enc.encode(toneFrame(440, f * 960)));
      rt.d2t.tick(f * 20);
    }
    assert.equal(ts.out.length - before, 5, "one mixed frame per tick");
    assert.ok(rt.status().election.fenceDrops >= 5);
    await rt.stop();
  });

  it("a non-receiver slot failure does not move receive and leaves the other slots running", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    for (let i = 1; i <= 3; i++) ts.addUser(i);
    await settle();
    const receiver = rt.status().receiver;
    const gen = rt.status().generation;
    bots.get("slot-2")!.die();
    await settle();
    assert.equal(rt.status().receiver, receiver);
    assert.equal(rt.status().generation, gen);
    assert.equal(bots.get("slot-1")!.inVoice, true);
    await rt.stop();
  });

  it("no healthy bot left: Discord to TeamSpeak fails closed while other slots keep sending", async () => {
    const { ts, bots, rt, settle } = await build();
    await rt.start();
    ts.addUser(1);
    await settle();
    const gen = rt.status().generation;
    bots.get("slot-0")!.die();
    await settle();
    assert.equal(rt.election.admitFrame("slot-0", gen), false);
    await rt.stop();
  });
});

describe("DAVE transition at the receiver while audio is queued (simulated Discord, orchestration level)", () => {
  async function buildWithElection() {
    const ts = new FakeTs();
    const election = new ReceiverElection(preferredOrder(5));
    const bots = new Map<BotId, FakeBot>();
    for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
    const rt = new BridgeRuntime({ ts, bots, election, codecFactory: () => createOpusCodec("auto"), log: quiet });
    const settle = () => settleRuntime(rt);
    await rt.start();
    ts.addUser(1);
    await settle();
    return { ts, bots, rt, election, settle };
  }

  it("flushes queued frames, stops receiving, and never forwards stale audio after DAVE returns", async () => {
    const { ts, bots, rt, election, settle } = await buildWithElection();
    const receiver = rt.status().receiver!;
    const gen = rt.status().generation;
    const enc = createOpusCodec("auto");
    for (let f = 0; f < 3; f++) rt.onHumanOpus(receiver, gen, "human", enc.encode(toneFrame(440, f * 960)));

    election.daveLost(receiver, "mls transition"); // what the bot does the moment DAVE is unavailable
    await settle();
    assert.equal(bots.get(receiver)!.receiving, null, "reception is torn down");
    const before = ts.out.length;
    for (let t = 0; t < 4; t++) rt.d2t.tick(t * 20);
    assert.equal(ts.out.length - before, 0, "frames queued before the loss are never mixed into TeamSpeak");
    rt.onHumanOpus(receiver, gen, "human", enc.encode(toneFrame(440, 3 * 960))); // a late callback from the old reception
    rt.d2t.tick(100);
    assert.equal(ts.out.length - before, 0, "late callbacks from the invalidated reception are fenced");

    election.daveRestored(receiver);
    await settle();
    assert.equal(rt.status().receiver, receiver, "the holder is kept through the transition");
    assert.ok(rt.status().generation > gen);
    assert.equal(bots.get(receiver)!.receiving, rt.status().generation, "reception resumed under the fresh generation");
    rt.onHumanOpus(receiver, gen, "human", enc.encode(toneFrame(440, 4 * 960)));
    rt.d2t.tick(140);
    assert.equal(ts.out.length - before, 0, "the old generation stays fenced after the restore");
    rt.onHumanOpus(receiver, rt.status().generation, "human", enc.encode(toneFrame(440, 5 * 960)));
    rt.d2t.tick(160);
    assert.equal(ts.out.length - before, 1, "new reception flows");
    await rt.stop();
  });
});

describe("TeamSpeak nickname → Discord slot nick", () => {
  async function aliceSlot() {
    const ctx = await build();
    await ctx.rt.start();
    ctx.ts.addUser(1, "Alice");
    await ctx.settle();
    return { ...ctx, slot: ctx.bots.get("slot-0")! };
  }

  function holdNick(slot: FakeBot): () => void {
    let release!: () => void;
    slot.nickDelay = new Promise<void>((r) => (release = r));
    return () => {
      slot.nickDelay = null;
      release();
    };
  }

  it("propagates a nickname change to the same uniqueId's slot without rejoining", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    const joins = slot.joinCount;
    ts.renameUser(1, "Alicia");
    await settle();
    assert.equal(slot.nick, "[TS] Alicia");
    assert.equal(slot.joinCount, joins, "audio membership is not rebuilt");
    assert.equal(rt.router.slotOccupant(0), "uid1");
    await rt.stop();
  });

  it("keeps the last nickname when a slower earlier Discord response arrives", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    const release = holdNick(slot);
    ts.renameUser(1, "First");
    await new Promise((r) => setImmediate(r));
    ts.renameUser(1, "Second");
    release();
    await settle();
    assert.equal(slot.nick, "[TS] Second");
    assert.equal(slot.nickCalls.at(-1), "[TS] Second");
    await rt.stop();
  });

  it("does not mark a failed Discord nick as applied, and does not drop the slot", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    const joins = slot.joinCount;
    slot.nickFailRemaining = 2;
    ts.renameUser(1, "Blocked");
    await settle();
    assert.equal(slot.nick, "[TS] Alice");
    assert.equal(slot.inVoice, true);
    assert.equal(slot.joinCount, joins);
    const spent = slot.nickCalls.length;
    ts.addUser(2, "Bob");
    await settle();
    assert.equal(slot.nickCalls.length, spent, "unrelated syncs do not spend more transient attempts");
    assert.equal(slot.nick, "[TS] Alice");
    slot.nickFailRemaining = 0;
    ts.renameUser(1, "Carol");
    await settle();
    assert.equal(slot.nick, "[TS] Carol");
    await rt.stop();
  });

  it("returning to the applied nickname still queues a compensating Discord request", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    const joins = slot.joinCount;
    const release = holdNick(slot);
    ts.renameUser(1, "Bob");
    await new Promise((r) => setImmediate(r));
    ts.renameUser(1, "Alice");
    release();
    await settle();
    assert.equal(slot.nick, "[TS] Alice");
    assert.equal(slot.nickCalls.at(-1), "[TS] Alice");
    assert.equal(slot.joinCount, joins, "audio membership is not rebuilt");
    await rt.stop();
  });

  it("does not retry a permission-denied nick across unrelated syncs", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    slot.nickDenied = true;
    const before = slot.nickCalls.length;
    ts.renameUser(1, "Blocked");
    await settle();
    assert.equal(slot.nick, "[TS] Alice");
    assert.equal(slot.nickCalls.length, before + 1);
    ts.addUser(2, "Bob");
    await settle();
    for (let i = 0; i < 12; i++) ts.renameUser(2, `Bob${i}`);
    await settle();
    assert.equal(slot.nickCalls.length, before + 1, "unrelated title changes must not retry a 403");
    slot.nickDenied = false;
    ts.renameUser(1, "Carol");
    await settle();
    assert.equal(slot.nick, "[TS] Carol");
    await rt.stop();
  });

  it("does not start a queued Discord nick after shutdown", async () => {
    const ts = new FakeTs();
    const bots = new Map<BotId, FakeBot>();
    for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
    const rt = new BridgeRuntime({ ts, bots, codecFactory: () => createOpusCodec("auto"), log: quiet, stopTimeoutMs: 30 });
    await rt.start();
    ts.addUser(1, "Alice");
    await settleRuntime(rt);
    const slot = bots.get("slot-0")!;
    const release = holdNick(slot);
    ts.renameUser(1, "First");
    await new Promise((r) => setImmediate(r));
    ts.renameUser(1, "Second");
    await new Promise((r) => setImmediate(r));
    const callsAtStop = slot.nickCalls.length;
    await rt.stop();
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(slot.nickCalls.length, callsAtStop);
    assert.equal(slot.nickCalls.includes("[TS] Second"), false);
  });

  it("classifies Discord 403 and missing-permissions as denied", () => {
    assert.equal(nickErrorKind({ status: 403, code: 0 }), "denied");
    assert.equal(nickErrorKind({ status: 400, code: 50013 }), "denied");
    assert.equal(nickErrorKind({ status: 403, code: 50001 }), "denied");
    assert.equal(nickErrorKind({ status: 500, code: 0 }), "failed");
  });

  it("a delayed Discord nick from before leave cannot overwrite the name after rejoin", async () => {
    const { ts, rt, settle, slot } = await aliceSlot();
    const release = holdNick(slot);
    ts.renameUser(1, "Old");
    await new Promise((r) => setImmediate(r));
    ts.removeUser(1);
    ts.addUser(1, "New");
    release();
    await settle();
    assert.equal(slot.nick, "[TS] New");
    await rt.stop();
  });
});

describe("tsNickname", () => {
  it("keeps the [TS] prefix and truncates the name to 32 UTF-16 units", () => {
    assert.equal(tsNickname("Alice"), "[TS] Alice");
    const long = tsNickname("x".repeat(60));
    assert.equal(long.length, 32);
    assert.ok(long.startsWith("[TS] "));
  });
  it("never splits a surrogate pair at the cut", () => {
    const n = tsNickname("a".repeat(26) + "😀");
    assert.ok(n.length <= 32);
    assert.ok(!/[\ud800-\udbff]$/.test(n));
  });
  it("falls back for an empty name", () => {
    assert.equal(tsNickname("   "), "[TS] Unknown");
  });
});
