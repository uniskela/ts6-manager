import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanFilter, type DiscordUserInfo } from "./human-filter.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

function filter(o: {
  cache?: Record<string, DiscordUserInfo>;
  users?: Record<string, DiscordUserInfo | null | "throw">;
  excluded?: string[];
  retryMs?: number;
  maxEntries?: number;
}) {
  let now = 0;
  const lookups: string[] = [];
  const f = new HumanFilter({
    cached: (id) => o.cache?.[id],
    lookup: async (id) => {
      lookups.push(id);
      const u = o.users?.[id];
      if (u === "throw") throw new Error("REST failed");
      return u ?? null;
    },
    excluded: (id) => (o.excluded ?? []).includes(id),
    now: () => now,
    retryMs: o.retryMs ?? 1000,
    maxEntries: o.maxEntries ?? 1000,
  });
  return { f, lookups, advance: (ms: number) => (now += ms) };
}

describe("HumanFilter admits only users known to be human (fail closed)", () => {
  it("admits a cached human and rejects a cached bot", () => {
    const { f, lookups } = filter({ cache: { h: { bot: false }, b: { bot: true } } });
    assert.equal(f.isHuman("h"), true);
    assert.equal(f.isHuman("b"), false);
    assert.deepEqual(lookups, [], "a cached identity needs no lookup");
  });

  it("rejects an unknown user until the lookup says human, then admits", async () => {
    const { f, lookups } = filter({ users: { u: { bot: false } } });
    assert.equal(f.isHuman("u"), false, "unknown is not human");
    assert.equal(f.isHuman("u"), false, "still unknown while the lookup is in flight");
    await tick();
    assert.equal(f.isHuman("u"), true);
    assert.deepEqual(lookups, ["u"], "one lookup, not one per call");
  });

  it("never admits a user the lookup says is a bot", async () => {
    const { f } = filter({ users: { b: { bot: true } } });
    f.isHuman("b");
    await tick();
    assert.equal(f.isHuman("b"), false);
  });

  it("stays closed when the lookup fails or finds nothing, and retries only after the cooldown", async () => {
    const { f, lookups, advance } = filter({ users: { x: "throw", y: null }, retryMs: 1000 });
    for (const id of ["x", "y"]) {
      assert.equal(f.isHuman(id), false);
      await tick();
      assert.equal(f.isHuman(id), false);
    }
    assert.deepEqual(lookups, ["x", "y"]);
    advance(500);
    f.isHuman("x");
    await tick();
    assert.deepEqual(lookups, ["x", "y"], "no lookup storm inside the cooldown");
    advance(600);
    f.isHuman("x");
    await tick();
    assert.deepEqual(lookups, ["x", "y", "x"], "one retry once the cooldown passed");
  });

  it("never admits the bridge's own identities or itself, whatever the cache says", () => {
    const { f } = filter({ cache: { mine: { bot: false } }, excluded: ["mine"] });
    assert.equal(f.isHuman("mine"), false);
  });

  it("is bounded under many distinct users", async () => {
    const users: Record<string, DiscordUserInfo> = {};
    for (let i = 0; i < 5000; i++) users[`u${i}`] = { bot: false };
    const { f } = filter({ users, maxEntries: 100 });
    for (let i = 0; i < 5000; i++) {
      f.isHuman(`u${i}`);
      if (i % 50 === 0) await tick();
    }
    await tick();
    assert.ok(f.size <= 200, `remembered identities stay bounded (saw ${f.size})`);
  });
});

/** A lookup the test settles by hand, so "never settles", "settles late" and "settles after teardown" are all expressible. */
function controlled(o: { maxPending?: number; lookupTimeoutMs?: number; retryMs?: number; maxRetryMs?: number; maxEntries?: number } = {}) {
  let now = 0;
  const started: string[] = [];
  const pending = new Map<string, { resolve: (v: DiscordUserInfo | null) => void; reject: (e: Error) => void }[]>();
  const f = new HumanFilter({
    cached: () => undefined,
    lookup: (id) => {
      started.push(id);
      return new Promise<DiscordUserInfo | null>((resolve, reject) => pending.set(id, [...(pending.get(id) ?? []), { resolve, reject }]));
    },
    excluded: () => false,
    now: () => now,
    retryMs: o.retryMs ?? 1000,
    maxRetryMs: o.maxRetryMs ?? 8000,
    maxEntries: o.maxEntries ?? 4,
    maxPending: o.maxPending ?? 4,
    lookupTimeoutMs: o.lookupTimeoutMs ?? 20,
  });
  return {
    f,
    started,
    advance: (ms: number) => (now += ms),
    settle: (id: string, v: DiscordUserInfo | null) => pending.get(id)?.shift()?.resolve(v),
    fail: (id: string) => pending.get(id)?.shift()?.reject(new Error("REST failed")),
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("HumanFilter bounds the lookups it has outstanding (R3)", () => {
  it("100 distinct unknown speakers whose lookups never settle start at most maxPending lookups and keep every one excluded", async () => {
    const c = controlled({ maxPending: 4, maxEntries: 4 });
    for (let i = 0; i < 100; i++) assert.equal(c.f.isHuman(`u${i}`), false);
    await tick();
    assert.equal(c.started.length, 4, "only the lookups the cap allows were started");
    assert.equal(c.f.stats().pending, 4);
    assert.equal(c.f.stats().refused, 96, "the rest were refused, not queued");
    assert.ok(c.f.size <= 8, `and nothing else is remembered for them (saw ${c.f.size})`);
  });

  it("does not queue what it refused: nothing starts when a slot frees unless that speaker is asked about again", async () => {
    const c = controlled({ maxPending: 2 });
    for (const id of ["a", "b", "c", "d"]) c.f.isHuman(id);
    assert.deepEqual(c.started, ["a", "b"]);
    c.settle("a", { bot: false });
    await tick();
    assert.deepEqual(c.started, ["a", "b"], "no backlog is drained behind the caller's back");
    assert.equal(c.f.isHuman("a"), true, "the answer that came back is used");
    assert.equal(c.f.isHuman("d"), false, "asked again, d takes the freed slot and is excluded until it is answered");
    assert.deepEqual(c.started, ["a", "b", "d"]);
    c.settle("d", { bot: true });
    await tick();
    assert.equal(c.f.isHuman("d"), false, "a bot stays excluded");
  });

  it("a stalled lookup times out, puts its user on a cooldown, but keeps its slot until the lookup really settles", async () => {
    const c = controlled({ maxPending: 1, lookupTimeoutMs: 20, retryMs: 1000 });
    c.f.isHuman("slow");
    await sleep(60);
    assert.equal(c.f.stats().timedOut, 1);
    assert.equal(c.f.stats().stalled, 1, "abandoned by the filter, still unsettled underneath");
    assert.equal(c.f.stats().pending, 1, "so it still counts against the cap");
    c.f.isHuman("other");
    assert.deepEqual(c.started, ["slow"], "a second lookup cannot pile up behind a stalled one");
    c.advance(5000);
    c.f.isHuman("slow");
    assert.deepEqual(c.started, ["slow"], "and the same user is not looked up again while their lookup is out");
    c.settle("slow", { bot: false });
    await tick();
    assert.equal(c.f.stats().pending, 0);
    assert.equal(c.f.isHuman("other"), false);
    assert.deepEqual(c.started, ["slow", "other"], "the slot is free once the stalled lookup finished");
  });

  it("a user whose lookup is stalled is not looked up again while it is out, even after the cooldown, so one user cannot fill the slots", async () => {
    const c = controlled({ maxPending: 4, lookupTimeoutMs: 20, retryMs: 10, maxRetryMs: 10 });
    c.f.isHuman("stuck");
    for (let i = 0; i < 6; i++) {
      await sleep(40); // past the timeout, and the cooldown it starts
      c.advance(1000);
      assert.equal(c.f.isHuman("stuck"), false);
    }
    assert.deepEqual(c.started, ["stuck"], "one request for the user, however often they are asked about");
    assert.equal(c.f.stats().pending, 1);
    assert.equal(c.f.stats().timedOut, 1, "the one lookup timed out once");
    c.f.isHuman("someone-else");
    assert.deepEqual(c.started, ["stuck", "someone-else"], "the other slots are still free for other users");
    c.settle("stuck", null); // it finally settles, without an answer
    await tick();
    c.advance(1000);
    c.f.isHuman("stuck");
    assert.deepEqual(c.started, ["stuck", "someone-else", "stuck"], "and only then is the user looked up again");
  });

  it("retries a failing user on a doubling cooldown that is capped, and forgets the failures after a success", async () => {
    const c = controlled({ retryMs: 1000, maxRetryMs: 4000, lookupTimeoutMs: 60_000 });
    /** Fail the user's lookup, then find how long the cooldown is by asking every 50 ms until a lookup starts. */
    const failThenWait = async (id: string) => {
      c.fail(id);
      await tick();
      const startedBefore = c.started.length;
      let waited = 0;
      for (; waited < 20_000; waited += 50) {
        c.f.isHuman(id);
        if (c.started.length > startedBefore) return waited;
        c.advance(50);
      }
      return waited;
    };
    c.f.isHuman("y");
    const gaps = [];
    for (let i = 0; i < 5; i++) gaps.push(await failThenWait("y"));
    assert.deepEqual(gaps, [1000, 2000, 4000, 4000, 4000], "doubles, then holds at the cap");

    c.settle("y", { bot: false });
    await tick();
    assert.equal(c.f.isHuman("y"), true);
    c.f.forget("y");
    c.f.isHuman("y");
    c.fail("y");
    await tick();
    const startedBefore = c.started.length;
    c.advance(1000);
    c.f.isHuman("y");
    assert.equal(c.started.length, startedBefore + 1, "after a success the next failure starts from the base cooldown again");
  });

  it("a lookup that throws synchronously is a failure and does not leak a slot", async () => {
    let calls = 0;
    const f = new HumanFilter({
      cached: () => undefined,
      lookup: () => {
        calls += 1;
        throw new Error("boom");
      },
      excluded: () => false,
      maxPending: 1,
    });
    assert.equal(f.isHuman("a"), false);
    await tick();
    assert.equal(f.stats().pending, 0, "the failed lookup released its slot");
    assert.equal(f.stats().failed, 1);
    assert.equal(f.isHuman("b"), false);
    assert.equal(calls, 2, "so the next user could be looked up");
  });

  it("known identities are still answered while every lookup slot is stuck", async () => {
    let cached = false;
    const f = new HumanFilter({
      cached: (id) => (cached && id === "known" ? { bot: false } : undefined),
      lookup: () => new Promise(() => undefined),
      excluded: () => false,
      maxPending: 1,
    });
    f.isHuman("stuck");
    assert.equal(f.isHuman("known"), false);
    cached = true;
    assert.equal(f.isHuman("known"), true, "a human the client already knows needs no slot");
  });
});

describe("HumanFilter late answers cannot revive anyone (R3)", () => {
  it("a late answer for a user that was forgotten is dropped", async () => {
    const c = controlled();
    c.f.isHuman("gone");
    c.f.forget("gone");
    c.settle("gone", { bot: false });
    await tick();
    assert.equal(c.f.size, 0, "nothing was remembered");
    assert.equal(c.f.stats().pending, 0, "and the slot was released");
    assert.equal(c.f.isHuman("gone"), false, "the departed user is unknown again, not admitted");
  });

  it("a late answer after the timeout is still used for a user who did not leave", async () => {
    const c = controlled({ lookupTimeoutMs: 20 });
    c.f.isHuman("late");
    await sleep(50);
    assert.equal(c.f.isHuman("late"), false);
    c.settle("late", { bot: false });
    await tick();
    assert.equal(c.f.isHuman("late"), true);
  });

  it("reset() ends the session: answers that arrive afterwards are dropped, and the slots come back as the lookups settle", async () => {
    const c = controlled({ maxPending: 2 });
    c.f.isHuman("a");
    c.f.isHuman("b");
    c.f.reset();
    assert.equal(c.f.stats().pending, 2, "unsettled lookups still count: the bound is on real outstanding work");
    c.settle("a", { bot: false });
    c.settle("b", { bot: false });
    await tick();
    assert.equal(c.f.size, 0, "nothing from the ended session was recorded");
    assert.equal(c.f.stats().pending, 0);
    assert.equal(c.f.isHuman("a"), false);
  });

  it("dispose() stops every timer and refuses to start another lookup", async () => {
    const c = controlled({ lookupTimeoutMs: 20 });
    c.f.isHuman("a");
    c.f.dispose();
    await sleep(50);
    assert.equal(c.f.stats().timedOut, 0, "the timeout of a cancelled lookup never fires");
    assert.equal(c.f.isHuman("b"), false);
    assert.deepEqual(c.started, ["a"], "no lookup starts after dispose");
    c.settle("a", { bot: false });
    await tick();
    assert.equal(c.f.isHuman("a"), false);
    assert.equal(c.f.size, 0);
  });
});
