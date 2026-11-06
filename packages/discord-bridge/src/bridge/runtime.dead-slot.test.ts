import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOrder, type BotId } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { RebuildBudgetExhausted } from "../core/rebuild-budget.js";
import { createLogger } from "../core/redact.js";
import { deriveHealth, type BetaSnapshotIn } from "../lab/beta-status.js";
import { FakeBot, FakeTs, settle } from "../testing/fake-runtime.js";
import { talk, tick, waitFor } from "../testing/fake-voice.js";
import { realRuntime, validOpus } from "../testing/real-runtime.js";
import { BridgeRuntime } from "./runtime.js";

const quiet = createLogger("test", () => undefined);

function build(slotCount = 5, retry?: { baseMs?: number; maxMs?: number; maxAttempts?: number }) {
  const ts = new FakeTs();
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(slotCount)) bots.set(id, new FakeBot(id, `discord-${id}`));
  const election = new ReceiverElection(preferredOrder(slotCount));
  const rt = new BridgeRuntime({
    ts,
    bots,
    election,
    slotCount,
    codecFactory: () => createOpusCodec("auto"),
    log: quiet,
    retry: { baseMs: 5, maxMs: 20, maxAttempts: 3, ...retry },
  });
  return { ts, bots, rt, election };
}

function routingHealth(r: ReturnType<typeof realRuntime>) {
  const st = r.rt.status();
  const snap: BetaSnapshotIn = {
    state: st.state,
    receiver: st.receiver,
    generation: st.generation,
    scheduledReconnects: st.scheduledReconnects,
    duplicateReceivers: st.duplicateReceivers,
    dave: Object.fromEntries([...r.tests].map(([id, t]) => [id, t.bot.daveInfo])),
    senders: Object.fromEntries(
      [...r.tests].map(([id, t]) => [
        id,
        { healthy: t.bot.healthy, inChannel: st.inChannel.includes(id), daveReady: t.bot.daveEstablished() },
      ]),
    ),
    refusedSlots: st.refused,
    unavailableRoutes: st.unavailableRoutes,
    occupiedSlots: st.slots.filter(Boolean).length,
    desiredSlots: st.slotHealth.desired,
    connectedSlots: st.slotHealth.connected,
    occupancy: st.occupancy,
    recovery: st.recovery,
  };
  return deriveHealth(snap, true);
}

function moveUser(ts: FakeTs, n: number, channelId: number) {
  for (const ev of ts.directory.ingest({
    name: "notifyclientmoved",
    params: { clid: String(100 + n), ctid: String(channelId) },
  })) {
    ts.emit("directory", ev);
  }
}

async function exhaustSlot1Joins(
  ts: FakeTs,
  bots: Map<BotId, FakeBot>,
  rt: BridgeRuntime,
  attempts = 5,
) {
  ts.addUser(1);
  ts.addUser(2);
  await settle(rt);
  const slot0 = bots.get("slot-0")!;
  const slot1 = bots.get("slot-1")!;
  const slot0Joins = slot0.joinCount;
  const before = slot1.joinCount;
  slot1.failJoin = new Error("adapter unavailable");
  slot1.die();
  await waitFor(() => {
    const retry = rt.status().retries["slot-1"];
    return slot1.joinCount >= before + attempts && retry?.attempts === attempts && retry.cooldown && retry.timer === "cooldown";
  }, 2000, "ordinary join attempts exhausted with a cooldown wake");
  await tick(40);
  await settle(rt);
  return { slot0, slot1, slot0Joins, before };
}

describe("D1 dead-slot routing: single-attempt", () => {
  it("one TeamSpeak user: slot-0 DAVE loss is refused, occupant moves to slot-1, slot-1 stays up", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      assert.equal(rt.router.destinationFor("uid1"), "slot-0");
      const joins = slot0.joinCount;
      slot0.recoveryMax = 0;
      slot0.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      assert.deepEqual(rt.status().refused, ["slot-0"]);
      assert.equal(rt.status().refuseReasons["slot-0"], "single-attempt-policy");
      assert.equal(rt.status().occupancy[0]!.eligible, false);
      assert.equal(slot0.inVoice, false);
      assert.equal(slot1.inVoice, true);
      assert.equal(slot1.healthy, true);
      assert.equal(slot0.joinCount, joins, "single-attempt must not reconnect slot-0");
      const text = JSON.stringify(rt.status());
      assert.equal(text.includes("uid1"), false);
      assert.equal(rt.status().occupancy[1]!.occupied, true);
      assert.equal(rt.status().occupancy[1]!.occupant, null);
      assert.equal(rt.status().occupancy[0]!.occupied, false);
    } finally {
      await rt.stop();
    }
  });

  it("two TeamSpeak users: refused slot-0 moves that occupant to free capacity and does not overwrite slot-1", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      const joins = slot0.joinCount;
      assert.equal(rt.router.destinationFor("uid1"), "slot-0");
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      slot0.recoveryMax = 0;
      slot0.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-2");
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      assert.equal(rt.router.slotOccupant(1), "uid2");
      assert.equal(slot1.inVoice, true);
      assert.equal(slot1.healthy, true);
      assert.equal(slot0.joinCount, joins, "single-attempt does not reconnect the dead slot");
      assert.equal(bots.get("slot-2")!.inVoice, true);
    } finally {
      await rt.stop();
    }
  });

  it("two users and two slots: no spare capacity drops the refused occupant fail-closed", async () => {
    const { ts, bots, rt } = build(2);
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      bots.get("slot-1")!;
      slot0.recoveryMax = 0;
      slot0.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), null);
      assert.equal(rt.router.isUnavailable("uid1"), true);
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      assert.equal(rt.status().unavailableRoutes, 1);
    } finally {
      await rt.stop();
    }
  });

  it("leave/rejoin and a new identity never reuse a refused slot or duplicate a mapping", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      await settle(rt);
      bots.get("slot-0")!.recoveryMax = 0;
      bots.get("slot-0")!.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      ts.removeUser(1);
      await settle(rt);
      ts.addUser(1);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      ts.addUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid2"), "slot-2");
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      assert.equal(new Set([rt.router.destinationFor("uid1"), rt.router.destinationFor("uid2")]).size, 2);
    } finally {
      await rt.stop();
    }
  });
});

describe("D1 dead-slot routing: normal recovery", () => {
  it("rebuilds only the failed slot, then forwards again after a fresh join", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      slot0.failJoin = new Error("dave lost");
      slot0.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), null, "dead slot is not a usable audio route");
      assert.equal(rt.router.slotOccupant(0), "uid1");
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      assert.equal(slot1.healthy, true);
      slot0.failJoin = null;
      await tick(30);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-0");
      assert.equal(slot0.inVoice, true);
      assert.equal(slot0.healthy, true);
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
    } finally {
      await rt.stop();
    }
  });

  it("cancelled slot-1 recovery is eligible again after five occupants return", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      const slot0Joins = slot0.joinCount;
      const release = slot1.hang();
      try {
        slot1.die();
        await tick(20);
        ts.removeUser(2);
        await tick(20);
      } finally {
        release();
      }
      await settle(rt);
      assert.equal(rt.status().refused.includes("slot-1"), false);
      ts.removeUser(1);
      await settle(rt);
      for (let i = 3; i <= 7; i++) ts.addUser(i);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid4"), "slot-1");
      assert.equal(rt.router.destinationFor("uid7") === "overflow", false);
      assert.equal(rt.status().occupancy[1]!.eligible, true);
      assert.equal(slot0.joinCount, slot0Joins);
      assert.equal(slot0.healthy, true);
    } finally {
      await rt.stop();
    }
  });

  it("stale recoveries stop at the budget and do not start a second join for the same slot", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 2, baseMs: 5, maxMs: 10 });
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const before = slot0.joinCount;
      slot0.failJoin = new RebuildBudgetExhausted(1, 0, 60_000);
      slot0.die();
      await settle(rt);
      await tick(40);
      await settle(rt);
      assert.equal(slot0.joinCount, before + 1, "one in-flight rebuild, then refuse");
      assert.equal(rt.status().refuseReasons["slot-0"], "single-attempt-policy");
      assert.deepEqual(rt.status().refused, ["slot-0"]);
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
    } finally {
      await rt.stop();
    }
  });
});

describe("D1 dead-slot routing: overflow and capacity restore", () => {
  it("six occupants: overflow failure drops the sixth, then a recovered overflow takes them back", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      for (let i = 1; i <= 6; i++) ts.addUser(i);
      await settle(rt);
      for (let i = 0; i < 5; i++) assert.equal(rt.router.destinationFor(`uid${i + 1}`), `slot-${i}`);
      assert.equal(rt.router.destinationFor("uid6"), "overflow");
      const overflow = bots.get("overflow")!;
      const slot0 = bots.get("slot-0")!;
      const slot0Joins = slot0.joinCount;
      overflow.failJoin = new Error("overflow down");
      overflow.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid6"), null);
      assert.equal(rt.router.isUnavailable("uid6"), true);
      for (let i = 0; i < 5; i++) assert.equal(rt.router.destinationFor(`uid${i + 1}`), `slot-${i}`);
      overflow.failJoin = null;
      await tick(30);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid6"), "overflow");
      assert.equal(overflow.inVoice, true);
      assert.equal(overflow.healthy, true);
      assert.equal(rt.router.overflowMembers().includes("uid6"), true);
      assert.equal(rt.router.isUnavailable("uid6"), false);
      assert.equal(slot0.joinCount, slot0Joins);
      assert.equal(slot0.inVoice, true);
    } finally {
      await rt.stop();
    }
  });

  it("A on slot-0, B on slot-1: refused A becomes unavailable, then receives B's slot when B leaves", async () => {
    const { ts, bots, rt } = build(2);
    const changes: { uniqueId: string; from: string | null; to: string | null }[] = [];
    const onChange = (c: { uniqueId: string; from: string | null; to: string | null }) => changes.push(c);
    rt.on("slotChange", onChange);
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-0");
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      bots.get("slot-0")!.recoveryMax = 0;
      bots.get("slot-0")!.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), null);
      assert.equal(rt.router.isUnavailable("uid1"), true);
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      changes.length = 0;
      ts.removeUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      assert.equal(rt.router.isUnavailable("uid1"), false);
      assert.equal(bots.get("slot-1")!.inVoice, true);
      assert.ok(changes.some((c) => c.uniqueId === "uid1" && c.to === "slot-1"));
    } finally {
      rt.off("slotChange", onChange);
      await rt.stop();
    }
  });

  it("A/B/C: unavailable A outranks overflow C when B leaves", async () => {
    const { ts, bots, rt } = build();
    const changes: { uniqueId: string; from: string | null; to: string | null }[] = [];
    const onChange = (c: { uniqueId: string; from: string | null; to: string | null }) => changes.push(c);
    rt.on("slotChange", onChange);
    try {
      await rt.start();
      for (let i = 1; i <= 5; i++) ts.addUser(i);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-0");
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      bots.get("slot-0")!.recoveryMax = 0;
      bots.get("slot-0")!.die();
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), null);
      assert.equal(rt.router.isUnavailable("uid1"), true);
      assert.equal(rt.router.destinationFor("uid2"), "slot-1");
      ts.addUser(6);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid6"), "overflow");
      changes.length = 0;
      ts.removeUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1", "unavailable A must take B's slot");
      assert.equal(rt.router.isUnavailable("uid1"), false);
      assert.equal(rt.router.destinationFor("uid6"), "overflow", "newcomer C stays on overflow");
      assert.equal(rt.router.slotOccupant(1), "uid1");
      assert.equal(bots.get("slot-1")!.inVoice, true);
      assert.equal(bots.get("slot-1")!.healthy, true);
      assert.ok(changes.some((c) => c.uniqueId === "uid1" && c.to === "slot-1"));
      assert.equal(changes.some((c) => c.uniqueId === "uid6" && c.to === "slot-1"), false);
      assert.equal(rt.router.overflowMembers().includes("uid6"), true);
    } finally {
      rt.off("slotChange", onChange);
      await rt.stop();
    }
  });

  it("leave/rejoin after A/B/C does not duplicate, overwrite, or resurrect mappings", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      for (let i = 1; i <= 5; i++) ts.addUser(i);
      await settle(rt);
      bots.get("slot-0")!.recoveryMax = 0;
      bots.get("slot-0")!.die();
      await settle(rt);
      ts.addUser(6);
      await settle(rt);
      ts.removeUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      assert.equal(rt.router.destinationFor("uid6"), "overflow");
      ts.addUser(2);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid2"), "overflow");
      assert.equal(rt.router.destinationFor("uid1"), "slot-1");
      assert.equal(rt.router.destinationFor("uid6"), "overflow");
      ts.removeUser(1);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid6"), "slot-1", "longest-waiting overflow after A leaves");
      assert.equal(rt.router.destinationFor("uid2"), "overflow");
      assert.equal(rt.router.destinationFor("uid1"), null);
      assert.equal(rt.router.isUnavailable("uid1"), false);
      ts.addUser(7);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid7"), "overflow");
      assert.equal(rt.status().refused.includes("slot-0"), true);
      assert.equal(rt.router.destinationFor("uid7") === "slot-0", false);
      const dests = ["uid3", "uid4", "uid5", "uid6", "uid2", "uid7"].map((u) => rt.router.destinationFor(u));
      assert.equal(dests.filter((d) => d === "slot-1").length, 1);
      assert.equal(new Set(["uid3", "uid4", "uid5", "uid6"].map((u) => rt.router.destinationFor(u))).has(null), false);
    } finally {
      await rt.stop();
    }
  });
});

describe("D1 dead-slot routing: ordinary retry exhaustion", () => {
  it("pending ordinary backoff is replaced by a cooldown wake at retry exhaustion", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 5, baseMs: 50, maxMs: 400 });
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      const slot0Joins = slot0.joinCount;
      const before = slot1.joinCount;
      slot1.failJoin = new Error("lookup failed");
      slot1.die();
      await settle(rt);
      for (let i = 0; i < 4; i++) {
        await rt.refreshExclusions();
        await settle(rt);
      }
      const exhausted = rt.status().retries["slot-1"]!;
      assert.equal(exhausted.attempts, 5, "retryAttempts reaches maxAttempts in one sequence");
      assert.equal(exhausted.cooldown, true);
      assert.equal(exhausted.timer, "cooldown", "exhaustion must arm a cooldown wake, not keep ordinary backoff");
      assert.equal(slot1.joinCount, before + 5);
      assert.equal(rt.status().recovery["slot-1"]!.used, 0, "ordinary retries do not spend rebuild tokens");
      await tick(120);
      const afterBackoff = rt.status().retries["slot-1"]!;
      assert.equal(afterBackoff.attempts, 5, "stale backoff must not reset attempts");
      assert.equal(afterBackoff.cooldown, true);
      assert.equal(afterBackoff.timer, "cooldown", "stale backoff must not drop the cooldown timer");
      assert.equal(rt.status().scheduledReconnects, 1);
      slot1.failJoin = null;
      ts.removeUser(2);
      await settle(rt);
      assert.equal(slot1.joinCount, before + 5, "no-demand must not start another join");
      for (let i = 3; i <= 7; i++) ts.addUser(i);
      await waitFor(() => slot1.inVoice && slot1.healthy && rt.router.slotOccupant(1) !== null, 2000, "cooldown wake unstrands slot-1");
      await settle(rt);
      assert.equal(rt.status().occupancy[1]!.eligible, true);
      assert.equal(rt.router.destinationFor("uid7") === "overflow" && rt.router.slotOccupant(1) === null, false);
      assert.equal(slot0.joinCount, slot0Joins);
      assert.equal(slot0.healthy, true);
    } finally {
      await rt.stop();
    }
  });

  it("repeated sync while join attempts are exhausted does not busy-loop", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 5, baseMs: 5, maxMs: 80 });
    try {
      await rt.start();
      const { slot1, before } = await exhaustSlot1Joins(ts, bots, rt);
      for (let i = 0; i < 6; i++) await rt.refreshExclusions();
      await settle(rt);
      assert.equal(slot1.joinCount, before + 5, "sync must not start another attempt sequence");
      assert.equal(slot1.inVoice, false);
    } finally {
      await rt.stop();
    }
  });

  it("membership churn during retry cooldown does not start a new attempt sequence", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 5, baseMs: 5, maxMs: 80 });
    try {
      await rt.start();
      const { slot1, before } = await exhaustSlot1Joins(ts, bots, rt);
      ts.removeUser(2);
      for (let i = 3; i <= 7; i++) ts.addUser(i);
      await settle(rt);
      await tick(20);
      assert.equal(slot1.joinCount, before + 5, "churn must not bypass the cooldown");
      assert.equal(slot1.inVoice, false);
    } finally {
      await rt.stop();
    }
  });

  it("no demand during retry cooldown cancels recovery work without stranding later demand", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 5, baseMs: 5, maxMs: 80 });
    try {
      await rt.start();
      const { slot0, slot1, slot0Joins, before } = await exhaustSlot1Joins(ts, bots, rt);
      ts.removeUser(2);
      await settle(rt);
      assert.equal(slot1.joinCount, before + 5, "empty demand must not keep joining");
      assert.equal(slot1.inVoice, false);
      slot1.failJoin = null;
      await tick(120);
      await settle(rt);
      assert.equal(slot1.joinCount, before + 5, "no occupant must not start a join after the wake");
      for (let i = 3; i <= 6; i++) ts.addUser(i);
      await settle(rt);
      await waitFor(() => slot1.inVoice && slot1.healthy, 2000, "fresh demand after cooldown restores the slot");
      assert.equal(rt.router.slotOccupant(1) !== null, true);
      assert.equal(rt.router.destinationFor("uid6") === "overflow", false);
      assert.equal(slot0.joinCount, slot0Joins);
      assert.equal(slot0.healthy, true);
    } finally {
      await rt.stop();
    }
  });

  it("additional transient failure after a recovered slot stays bounded", async () => {
    const { ts, bots, rt } = build(5, { maxAttempts: 5, baseMs: 5, maxMs: 80 });
    try {
      await rt.start();
      const { slot1 } = await exhaustSlot1Joins(ts, bots, rt);
      slot1.failJoin = null;
      ts.removeUser(1);
      ts.removeUser(2);
      await tick(120);
      await settle(rt);
      ts.addUser(3);
      ts.addUser(4);
      await settle(rt);
      await waitFor(() => slot1.inVoice, 2000, "slot-1 recovered");
      const recovered = slot1.joinCount;
      slot1.failJoin = new Error("adapter unavailable again");
      slot1.die();
      await waitFor(() => slot1.joinCount >= recovered + 5, 2000, "second exhaustion");
      await tick(30);
      await settle(rt);
      assert.equal(slot1.joinCount, recovered + 5, "the next failure sequence stays at maxAttempts");
    } finally {
      await rt.stop();
    }
  });

  it("single-attempt mode still permanently refuses after membership churn", async () => {
    const { ts, bots, rt } = build();
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot1 = bots.get("slot-1")!;
      const joins = slot1.joinCount;
      slot1.recoveryMax = 0;
      slot1.failJoin = new Error("adapter unavailable");
      slot1.die();
      await settle(rt);
      ts.removeUser(2);
      for (let i = 3; i <= 7; i++) ts.addUser(i);
      await settle(rt);
      await tick(80);
      assert.deepEqual(rt.status().refused, ["slot-1"]);
      assert.equal(rt.status().refuseReasons["slot-1"], "single-attempt-policy");
      assert.equal(slot1.joinCount, joins, "membership must not reset maxRecoveries=0");
      assert.equal(slot1.inVoice, false);
    } finally {
      await rt.stop();
    }
  });
});

describe("D1 dead-slot routing: rebuild-budget cooldown with occupant remaining", () => {
  it("occupied exhausted slot keeps its original cooldown through membership and nick activity", async () => {
    const cooldownMs = 80;
    const { ts, bots, rt } = build(2, { maxAttempts: 3, baseMs: 5, maxMs: cooldownMs });
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      slot0.failJoin = new RebuildBudgetExhausted(cooldownMs, 1, cooldownMs);
      slot0.die();
      await settle(rt);
      const exhaustedJoins = slot0.joinCount;
      const slot1Joins = slot1.joinCount;
      const retry = rt.status().retries["slot-0"]!;
      assert.equal(retry.cooldown, true);
      assert.equal(retry.timer, "cooldown");
      assert.equal(typeof retry.dueAt, "number");
      const dueAt = retry.dueAt;
      assert.equal(rt.status().scheduledReconnects, 1, "budget exhaustion arms exactly one cooldown wake");
      assert.equal(rt.router.slotOccupant(0), "uid1");
      assert.equal(rt.router.destinationFor("uid1"), null);
      assert.equal(rt.status().refused.includes("slot-0"), false);

      ts.addUser(3);
      await settle(rt);
      ts.renameUser(1, "Renamed1");
      await settle(rt);
      moveUser(ts, 2, 2);
      await settle(rt);
      moveUser(ts, 2, 1);
      await settle(rt);
      for (let i = 0; i < 4; i++) await rt.refreshExclusions();
      await settle(rt);

      assert.equal(slot0.joinCount, exhaustedJoins, "extra TeamSpeak joins and nicks must not start another join");
      assert.equal(rt.status().retries["slot-0"]!.timer, "cooldown");
      assert.equal(rt.status().retries["slot-0"]!.dueAt, dueAt, "membership activity must not change the original deadline");
      assert.equal(rt.status().scheduledReconnects, 1, "activity must not replace the armed cooldown");
      assert.equal(rt.router.slotOccupant(0), "uid1", "occupant remains on the exhausted slot");
      assert.equal(slot1.joinCount, slot1Joins);
      assert.equal(slot1.healthy, true);

      slot0.failJoin = null;
      await tick(40);
      await settle(rt);
      assert.equal(slot0.inVoice, false, "must not recover before the original cooldown");
      assert.equal(slot0.joinCount, exhaustedJoins);

      ts.renameUser(1, "LateNick");
      await settle(rt);
      ts.removeUser(3);
      await settle(rt);
      await rt.refreshExclusions();
      await settle(rt);
      assert.equal(slot0.joinCount, exhaustedJoins, "late nick/leave/sync must not start a join or reset the wake");
      assert.equal(rt.status().retries["slot-0"]!.timer, "cooldown");
      assert.equal(rt.status().retries["slot-0"]!.dueAt, dueAt, "repeated sync must not change the original deadline");
      assert.equal(slot0.inVoice, false);

      await waitFor(() => slot0.inVoice && slot0.healthy && rt.router.destinationFor("uid1") === "slot-0", 2000, "original cooldown recovers the occupied slot");
      await settle(rt);
      assert.equal(rt.router.slotOccupant(0), "uid1");
      assert.equal(rt.status().retries["slot-0"]!.cooldown, false);
      assert.equal(slot1.joinCount, slot1Joins);
      assert.equal(slot1.healthy, true);
      assert.equal(slot1.inVoice, true);
    } finally {
      await rt.stop();
    }
  });

  it("occupied budget cooldown cancels recovery when demand leaves, then accepts later demand", async () => {
    const cooldownMs = 80;
    const { ts, bots, rt } = build(2, { maxAttempts: 3, baseMs: 5, maxMs: cooldownMs });
    try {
      await rt.start();
      ts.addUser(1);
      ts.addUser(2);
      await settle(rt);
      const slot0 = bots.get("slot-0")!;
      const slot1 = bots.get("slot-1")!;
      slot0.failJoin = new RebuildBudgetExhausted(cooldownMs, 1, cooldownMs);
      slot0.die();
      await settle(rt);
      const exhaustedJoins = slot0.joinCount;
      const slot1Joins = slot1.joinCount;
      assert.equal(rt.router.slotOccupant(0), "uid1");
      assert.equal(rt.status().retries["slot-0"]!.timer, "cooldown");

      ts.removeUser(1);
      await settle(rt);
      assert.equal(slot0.joinCount, exhaustedJoins, "clearing demand must not start another join");
      assert.equal(rt.router.slotOccupant(0), null);

      slot0.failJoin = null;
      await tick(140);
      await settle(rt);
      assert.equal(slot0.joinCount, exhaustedJoins, "wake with no occupant must not join");
      assert.equal(rt.status().occupancy[0]!.eligible, true);
      assert.equal(slot1.joinCount, slot1Joins);

      ts.addUser(3);
      await settle(rt);
      assert.equal(rt.router.destinationFor("uid3") === "slot-0" || rt.router.destinationFor("uid3") === "slot-1", true);
      assert.equal(rt.status().occupancy[0]!.eligible, true);
      assert.equal(slot1.healthy, true);
    } finally {
      await rt.stop();
    }
  });
});

describe("D1 dead-slot routing: real adapter", () => {
  it("DAVE negotiation timeout is refused, occupant moves, replacement joins, slot-1 is untouched", async () => {
    const r = realRuntime({
      users: 2,
      timing: { maxRecoveries: 0, daveWaitMs: 80, pollMs: 10, readyMs: 400, daveGraceMs: 40 },
      retry: { maxAttempts: 1, baseMs: 5, maxMs: 10 },
      bot: (id) => ({ daveReady: id !== "slot-0" }),
    });
    try {
      await r.rt.start();
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t1.bot.healthy && t1.ready.length === 1, 2000, "healthy slot-1 finished its first join");
      const slot1Conn = t1.latest().conn;
      const slot1Joins = t1.adapter.sent.filter((p) => p.d.channel_id !== null).length;
      await waitFor(() => r.rt.status().refused.includes("slot-0"), 2000, "slot-0 refused after DAVE timeout");
      await r.rt.idle();
      assert.equal(r.rt.router.destinationFor("uid1"), "slot-2");
      assert.equal(r.rt.router.destinationFor("uid2"), "slot-1");
      const t2 = r.tests.get("slot-2")!;
      await waitFor(() => t2.bot.healthy && t2.ready.length === 1, 2000, "replacement slot-2 joined");
      assert.equal(r.tests.get("slot-0")!.ready.length, 1, "single-attempt must not rebuild slot-0");
      assert.equal(t1.ready.length, 1);
      assert.equal(t1.latest().conn, slot1Conn);
      assert.equal(t1.adapter.sent.filter((p) => p.d.channel_id !== null).length, slot1Joins);
      assert.equal(t1.bot.healthy, true);
      assert.equal(JSON.stringify(r.rt.status()).includes("uid1"), false);
    } finally {
      await r.cleanup();
    }
  });

  it("cancels a hung recovery lookup when the last occupant leaves a failed non-receiver slot", async () => {
    const r = realRuntime({ users: 2, timing: { maxRecoveries: 2, recoveryWindowMs: 60_000, readyMs: 400 } });
    try {
      await r.rt.start();
      await r.rt.idle();
      const t0 = r.tests.get("slot-0")!;
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t0.bot.healthy && t1.bot.healthy, 2000, "both slots joined");
      const used = t0.bot.recoveryBudget().used;
      const ready = t0.ready.length;
      const slot1Conn = t1.latest().conn;
      const release = t0.holdTarget();
      try {
        t0.latest().conn.destroy(false);
        await waitFor(() => !t0.bot.healthy, 1000, "slot-0 unhealthy");
        await tick(20);
        r.ts.removeUser(1);
        await tick(20);
      } finally {
        release();
      }
      await r.rt.idle();
      await tick(50);
      assert.equal(t0.ready.length, ready, "stale lookup must not create a Discord connection");
      assert.equal(t0.bot.recoveryBudget().used, used, "cancelled recovery must not spend a token");
      assert.equal(t1.latest().conn, slot1Conn);
      assert.equal(t1.bot.healthy, true);
      assert.equal(r.rt.router.destinationFor("uid2"), "slot-1");
    } finally {
      await r.cleanup();
    }
  });

  it("cancelled slot-1 recovery becomes reusable when five occupants return", async () => {
    const r = realRuntime({ users: 2, timing: { maxRecoveries: 2, recoveryWindowMs: 60_000, readyMs: 400 } });
    try {
      await r.rt.start();
      await r.rt.idle();
      const t0 = r.tests.get("slot-0")!;
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t0.bot.healthy && t1.bot.healthy, 2000, "both slots joined");
      const slot0Conn = t0.latest().conn;
      const slot0Joins = t0.adapter.sent.filter((p) => p.d.channel_id !== null).length;
      const used = t1.bot.recoveryBudget().used;
      const ready = t1.ready.length;
      const release = t1.holdTarget();
      try {
        t1.latest().conn.destroy(false);
        await waitFor(() => !t1.bot.healthy, 1000, "slot-1 unhealthy");
        await tick(20);
        r.ts.removeUser(2);
        await tick(20);
      } finally {
        release();
      }
      await r.rt.idle();
      await tick(50);
      assert.equal(t1.ready.length, ready, "stale lookup must not create a Discord connection");
      assert.equal(t1.bot.recoveryBudget().used, used, "cancelled recovery must not spend a token");
      assert.equal(r.rt.status().refused.includes("slot-1"), false);
      r.ts.removeUser(1);
      await r.rt.idle();
      for (let i = 3; i <= 7; i++) r.ts.addUser(i);
      await r.rt.idle();
      await waitFor(() => r.rt.router.destinationFor("uid4") === "slot-1", 2000, "slot-1 takes renewed demand");
      assert.equal(r.rt.router.destinationFor("uid7") === "overflow", false, "fifth occupant must not overflow while slot-1 is reusable");
      assert.equal(r.rt.status().occupancy[1]!.eligible, true);
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.adapter.sent.filter((p) => p.d.channel_id !== null).length, slot0Joins);
      assert.equal(t0.bot.healthy, true);
    } finally {
      await r.cleanup();
    }
  });

  it("exhausted slot-1 budget ignores membership churn until the window, then accepts demand", async () => {
    const r = realRuntime({ users: 2, timing: { maxRecoveries: 1, recoveryWindowMs: 700, readyMs: 400 } });
    try {
      await r.rt.start();
      await r.rt.idle();
      const t0 = r.tests.get("slot-0")!;
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t0.bot.healthy && t1.bot.healthy, 2000, "both slots joined");
      const slot0Conn = t0.latest().conn;
      const slot0Joins = t0.adapter.sent.filter((p) => p.d.channel_id !== null).length;
      t1.latest().conn.destroy(false);
      await waitFor(() => t1.ready.length === 2 && t1.bot.healthy, 2000, "slot-1 spent its one rebuild");
      await r.rt.idle();
      const spentAt = Date.now();
      const readyAfterRebuild = t1.ready.length;
      t1.latest().conn.destroy(false);
      await waitFor(() => r.rt.status().scheduledReconnects >= 1, 1000, "slot-1 waiting on the window");
      await r.rt.idle();
      assert.equal(r.rt.status().refused.includes("slot-1"), false, "exhaustion is not permanent refusal");
      assert.equal(r.rt.status().refuseReasons["slot-1"], "rebuild-budget-exhausted");
      r.ts.removeUser(2);
      for (let i = 3; i <= 7; i++) r.ts.addUser(i);
      await r.rt.idle();
      await tick(80);
      assert.equal(t1.ready.length, readyAfterRebuild, "churn must not bypass the window");
      assert.equal(r.rt.status().refused.includes("slot-1"), false);
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.adapter.sent.filter((p) => p.d.channel_id !== null).length, slot0Joins);
      await waitFor(() => r.rt.router.slotEligible(1) && r.rt.router.slotOccupant(1) !== null, 3000, "slot-1 unlocks after the window");
      assert.ok(Date.now() - spentAt >= 600, "not before the spent token left the window");
      await r.rt.idle();
      assert.equal(r.rt.router.destinationFor("uid7") === "overflow" && r.rt.router.slotOccupant(1) === null, false);
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.bot.healthy, true);
    } finally {
      await r.cleanup();
    }
  });

  it("occupied exhausted slot does not rebuild on churn, then forwards only after a fresh DAVE join", async () => {
    const r = realRuntime({ users: 2, timing: { maxRecoveries: 1, recoveryWindowMs: 400, readyMs: 400 } });
    try {
      await r.rt.start();
      await r.rt.idle();
      const t0 = r.tests.get("slot-0")!;
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t0.bot.healthy && t1.bot.healthy && t0.bot.daveEstablished() && t1.bot.daveEstablished(), 2000, "both slots joined with DAVE");
      const slot0Conn = t0.latest().conn;
      const slot0Joins = t0.adapter.sent.filter((p) => p.d.channel_id !== null).length;
      t1.latest().conn.destroy(false);
      await waitFor(() => t1.ready.length === 2 && t1.bot.healthy, 2000, "slot-1 spent its one rebuild");
      await r.rt.idle();
      const spentAt = Date.now();
      const readyAfterRebuild = t1.ready.length;
      t1.latest().conn.destroy(false);
      await waitFor(() => r.rt.status().scheduledReconnects >= 1 && r.rt.status().retries["slot-1"]?.timer === "cooldown", 1000, "slot-1 waiting on the window");
      await r.rt.idle();
      assert.equal(r.rt.router.slotOccupant(1), "uid2", "occupant remains on the exhausted slot");
      assert.equal(r.rt.router.destinationFor("uid2"), null);
      assert.equal(r.rt.status().refused.includes("slot-1"), false);

      r.ts.renameUser(2, "StillHere");
      r.ts.addUser(3);
      r.ts.addUser(4);
      await r.rt.idle();
      moveUser(r.ts, 3, 2);
      moveUser(r.ts, 3, 1);
      await r.rt.idle();
      for (let i = 0; i < 4; i++) await r.rt.refreshExclusions();
      await r.rt.idle();
      await tick(40);
      assert.equal(t1.ready.length, readyAfterRebuild, "occupant-remaining churn must not start another rebuild");
      assert.equal(r.rt.status().retries["slot-1"]!.timer, "cooldown");
      assert.equal(r.rt.status().scheduledReconnects, 1);
      assert.equal(r.rt.router.slotOccupant(1), "uid2");
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.adapter.sent.filter((p) => p.d.channel_id !== null).length, slot0Joins);
      assert.equal(t0.bot.healthy, true);

      await waitFor(() => t1.bot.healthy && t1.bot.daveEstablished() && r.rt.router.destinationFor("uid2") === "slot-1", 3000, "original window recovers the occupied slot with DAVE");
      assert.ok(Date.now() - spentAt >= 350, "not before the spent token left the window");
      await r.rt.idle();
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.bot.healthy, true);
      assert.equal(t0.bot.daveEstablished(), true);
      assert.ok(t1.ready.length > readyAfterRebuild);
      assert.equal(t1.bot.daveEstablished(), true);

      r.election.setState("slot-1", { healthy: true, inChannel: true, dave: true });
      r.election.pin("slot-1");
      r.election.reconcile("prove recovered slot-1 audio");
      await waitFor(() => r.election.receiver === "slot-1", 2000, "recovered slot-1 is elected");
      await r.rt.idle();
      const live = t1.latest();
      live.mapUser("human", 4242);
      r.ts.out.length = 0;
      live.setDave({ protocolVersion: 0 });
      r.rt.onHumanOpus("slot-1", r.election.generation, "human", validOpus());
      r.rt.d2t.tick(20);
      assert.equal(r.ts.out.length, 0, "DAVE-unready audio must not be forwarded");
      live.setDave({ protocolVersion: 1 });
      const packet = validOpus();
      const stop = talk(live, "human", () => packet);
      try {
        await waitFor(() => r.ts.out.length > 0, 1500, "audio is delivered after a fresh DAVE join");
      } finally {
        stop();
      }
      assert.equal(t0.latest().conn, slot0Conn, "healthy slot-0 keeps its connection");
    } finally {
      await r.cleanup();
    }
  });

  it("ordinary join-retry exhaustion does not strand a reusable slot after the budget window", async () => {
    const r = realRuntime({
      users: 2,
      timing: { maxRecoveries: 3, recoveryWindowMs: 700, readyMs: 400 },
      retry: { maxAttempts: 5, baseMs: 50, maxMs: 400 },
    });
    try {
      await r.rt.start();
      await r.rt.idle();
      const t0 = r.tests.get("slot-0")!;
      const t1 = r.tests.get("slot-1")!;
      await waitFor(() => t0.bot.healthy && t1.bot.healthy && t0.bot.daveEstablished() && t1.bot.daveEstablished(), 2000, "both slots joined with DAVE");
      const slot0Conn = t0.latest().conn;
      const slot0Joins = t0.adapter.sent.filter((p) => p.d.channel_id !== null).length;
      const lookupsBefore = t1.lookupAttempts;
      const readyAtHealthy = t1.ready.length;
      assert.equal(routingHealth(r), "ok");

      t1.failTarget = new Error("lookup failed");
      t1.latest().conn.destroy(false);
      await r.rt.idle();
      for (let i = 0; i < 4; i++) {
        await r.rt.refreshExclusions();
        await r.rt.idle();
      }
      const exhausted = r.rt.status().retries["slot-1"]!;
      assert.equal(exhausted.attempts, 5, "retryAttempts reaches maxAttempts in one sequence");
      assert.equal(exhausted.cooldown, true);
      assert.equal(exhausted.timer, "cooldown");
      assert.ok(t1.lookupAttempts - lookupsBefore >= 5, "failed lookups, not successful rejoins");
      assert.equal(t1.bot.recoveryBudget().used, 0, "lookup failures do not spend rebuild tokens");
      assert.equal(t1.bot.healthy, false);
      assert.equal(t1.ready.length, readyAtHealthy, "no new Ready connection while exhausted");

      for (let i = 0; i < 6; i++) await r.rt.refreshExclusions();
      await r.rt.idle();
      assert.equal(r.rt.status().retries["slot-1"]!.attempts, 5, "repeated sync must not start another sequence");
      await tick(120);
      assert.equal(r.rt.status().retries["slot-1"]!.timer, "cooldown", "stale backoff cannot drop the cooldown wake");

      r.ts.removeUser(2);
      for (let i = 3; i <= 7; i++) r.ts.addUser(i);
      await r.rt.idle();
      await tick(40);
      assert.equal(t1.ready.length, readyAtHealthy, "membership churn must not bypass the cooldown");
      assert.equal(t1.bot.healthy, false);

      r.ts.removeUser(3);
      r.ts.removeUser(4);
      r.ts.removeUser(5);
      r.ts.removeUser(6);
      r.ts.removeUser(7);
      await r.rt.idle();
      assert.equal(t1.ready.length, readyAtHealthy, "no slot-1 demand must not keep building connections");
      assert.equal(t0.latest().conn, slot0Conn, "slot-0 stays on its original connection while demand is gone");

      t1.failTarget = null;
      await tick(450);
      await r.rt.idle();
      for (let i = 8; i <= 12; i++) r.ts.addUser(i);
      await r.rt.idle();
      await waitFor(() => t1.bot.healthy && t1.bot.daveEstablished() && r.rt.router.slotOccupant(1) !== null, 3000, "previously stranded slot-1 joins with DAVE");
      assert.equal(r.rt.status().occupancy[1]!.eligible, true);
      assert.ok(t1.ready.length > readyAtHealthy, "slot-1 established a fresh connection");
      assert.equal(t0.latest().conn, slot0Conn);
      assert.equal(t0.adapter.sent.filter((p) => p.d.channel_id !== null).length, slot0Joins);
      assert.equal(t0.bot.healthy, true);
      assert.equal(t0.bot.daveEstablished(), true);

      r.election.setState("slot-1", { healthy: true, inChannel: true, dave: true });
      r.election.pin("slot-1");
      r.election.reconcile("prove recovered slot-1 audio");
      await waitFor(() => r.election.receiver === "slot-1", 2000, "recovered slot-1 is elected");
      await r.rt.idle();
      assert.equal(t0.latest().conn, slot0Conn, "electing slot-1 must not rebuild slot-0");
      r.ts.out.length = 0;
      const packet = validOpus();
      t1.latest().mapUser("human", 4242);
      const stop = talk(t1.latest(), "human", () => packet);
      try {
        await waitFor(() => r.ts.out.length > 0, 1500, "audio is delivered through recovered slot-1");
      } finally {
        stop();
      }
      assert.equal(routingHealth(r), "ok");
    } finally {
      await r.cleanup();
    }
  });
});
