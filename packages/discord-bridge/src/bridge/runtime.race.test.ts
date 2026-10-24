/**
 * Randomised concurrency check of the runtime. Seeded operation sequences (TeamSpeak joins and
 * leaves, bot deaths, failed reconnects, DAVE loss and restore, Discord frames from current and
 * stale receivers) are fired back to back, often without waiting, so queued membership work,
 * background joins and receiver activations interleave. After every group the invariants below
 * must hold. A failure prints the seed so the exact sequence can be replayed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preferredOrder, type BotId } from "../core/ids.js";
import { createOpusCodec } from "../core/opus.js";
import { toneFrame } from "../core/pcm.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger } from "../core/redact.js";
import { FakeBot, FakeTs } from "../testing/fake-runtime.js";
import { BridgeRuntime } from "./runtime.js";

const quiet = createLogger("race", () => undefined);

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(seed: number, steps: number): Promise<void> {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ts = new FakeTs();
  const election = new ReceiverElection(preferredOrder(5));
  const bots = new Map<BotId, FakeBot>();
  for (const id of preferredOrder(5)) bots.set(id, new FakeBot(id, `discord-${id}`));
  const rt = new BridgeRuntime({ ts, bots, election, codecFactory: () => createOpusCodec("auto"), log: quiet, retry: { baseMs: 1, maxMs: 4, maxAttempts: 3 } });
  const enc = createOpusCodec("auto");
  const frame = enc.encode(toneFrame(440, 0));
  const ids = preferredOrder(5);
  const present = new Set<number>();
  /** Independent model of which bots currently lack DAVE (what the oracle below relies on). */
  const lost = new Set<BotId>();
  let lastGen = 0;
  let clock = 0;
  const where = (step: number, op: string) => `seed ${seed} step ${step} (${op})`;

  await rt.start();
  await rt.idle();

  const ops: [string, () => void][] = [
    ["user joins", () => {
      const n = 1 + Math.floor(rnd() * 8);
      if (!present.has(n)) {
        present.add(n);
        ts.addUser(n);
      }
    }],
    ["user leaves", () => {
      const n = pick([...present, 99]);
      if (present.delete(n)) ts.removeUser(n);
    }],
    ["bot dies", () => {
      const b = bots.get(pick(ids))!;
      if (b.inVoice) b.die();
    }],
    ["reconnects start failing", () => {
      bots.get(pick(ids))!.failJoin = new Error("gateway");
    }],
    ["reconnects recover", () => {
      for (const b of bots.values()) b.failJoin = null;
    }],
    ["dave lost", () => {
      const b = pick(ids);
      lost.add(b);
      election.daveLost(b, "transition");
    }],
    ["dave restored", () => {
      const b = pick(ids);
      lost.delete(b);
      election.daveRestored(b);
    }],
  ];

  for (let step = 0; step < steps; step++) {
    const group = 1 + Math.floor(rnd() * 4);
    const names: string[] = [];
    for (let i = 0; i < group; i++) {
      const [name, fn] = pick(ops);
      names.push(name);
      fn();
      if (rnd() < 0.3) await Promise.resolve(); // sometimes let a microtask through, sometimes not
    }
    await rt.idle();
    const w = where(step, names.join(" + "));

    // 1. At most one bot receives, and it is the elected one under the current generation.
    const receiving = [...bots.values()].filter((b) => b.receiving !== null);
    assert.ok(receiving.length <= 1, `${w}: ${receiving.length} bots receiving`);
    for (const b of receiving) {
      assert.equal(election.receiver, b.id, `${w}: ${b.id} receives but is not the elected receiver`);
      assert.equal(b.receiving, election.generation, `${w}: ${b.id} receives under a stale generation`);
    }
    // 2. The generation never goes backwards.
    assert.ok(election.generation >= lastGen, `${w}: generation moved backwards`);
    lastGen = election.generation;
    // 2b. Liveness: an elected holder whose DAVE is up is actually receiving under the current generation.
    if (election.receiver && !lost.has(election.receiver)) {
      assert.equal(bots.get(election.receiver)!.receiving, election.generation, `${w}: ${election.receiver} is elected with DAVE up but is not receiving`);
    }
    // 3. A frame reaches TeamSpeak exactly when the receiver, the generation and DAVE all say so.
    const holder = election.receiver;
    const candidates: [BotId, number][] = [[holder ?? "slot-0", election.generation], [pick(ids), election.generation], [holder ?? "slot-0", Math.max(0, election.generation - 1)], [pick(ids), pick([0, 1, election.generation + 1])]];
    for (const [bot, gen] of candidates) {
      const expected = bot === election.receiver && gen === election.generation && !lost.has(bot); // independent oracle
      const before = ts.out.length;
      rt.onHumanOpus(bot, gen, "human", frame); // synchronous with the tick below: the 20 ms timer cannot run between
      rt.d2t.tick((clock += 20));
      assert.equal(ts.out.length - before, expected ? 1 : 0, `${w}: frame from ${bot}@${gen} (oracle admits=${expected}) reached TeamSpeak ${ts.out.length - before} time(s)`);
    }
  }

  // 4. After stop nothing joins, whatever arrives.
  await rt.stop();
  const joins = new Map([...bots].map(([id, b]) => [id, b.joinCount]));
  ts.addUser(50);
  for (const b of bots.values()) b.emit("unhealthy", "late");
  election.daveRestored("slot-0");
  await new Promise((r) => setTimeout(r, 15));
  for (const [id, b] of bots) assert.equal(b.joinCount, joins.get(id), `seed ${seed}: ${id} joined after stop`);
}

describe("runtime race check (seeded, simulated Discord)", () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}: invariants hold across 60 interleaved operation groups`, async () => {
      await run(seed, 60);
    });
  }
});
