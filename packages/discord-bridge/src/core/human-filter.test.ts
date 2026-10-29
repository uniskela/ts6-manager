import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HumanFilter, type DiscordUserInfo } from "./human-filter.js";
import { alive } from "../testing/gc.js";
import { IdentityRequests } from "./identity-requests.js";

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
    requests: new IdentityRequests(),
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

/**
 * A lookup the test settles by hand, so "never settles", "settles late" and "settles after teardown"
 * are all expressible. `requests` is the process-wide registry stand-in; pass one to share it between
 * filters (a bot and its replacement).
 */
function controlled(o: { maxPending?: number; lookupTimeoutMs?: number; retryMs?: number; maxRetryMs?: number; maxEntries?: number; requests?: IdentityRequests } = {}) {
  let now = 0;
  const started: string[] = [];
  const pending = new Map<string, { resolve: (v: DiscordUserInfo | null) => void; reject: (e: Error) => void }[]>();
  const lookupTimeoutMs = o.lookupTimeoutMs ?? 20;
  const requests = o.requests ?? new IdentityRequests({ maxPending: o.maxPending ?? 4, stallMs: lookupTimeoutMs });
  const make = () =>
    new HumanFilter({
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
      requests,
      lookupTimeoutMs,
    });
  const f = make();
  return {
    f,
    /** Another filter on the same registry and the same lookup (a replacement bot in the same process). */
    another: make,
    requests,
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
    assert.equal(c.f.size, 1, "the success replaced the cooldown and its failure count: one remembered identity, no cooldown");
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
      requests: new IdentityRequests({ maxPending: 1 }),
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
      requests: new IdentityRequests({ maxPending: 1 }),
    });
    f.isHuman("stuck");
    assert.equal(f.isHuman("known"), false);
    cached = true;
    assert.equal(f.isHuman("known"), true, "a human the client already knows needs no slot");
  });
});

describe("HumanFilter late answers, resets and replacement (R1)", () => {
  it("a late answer after the timeout is still used for a user who did not leave", async () => {
    const c = controlled({ lookupTimeoutMs: 20 });
    c.f.isHuman("late");
    await sleep(50);
    assert.equal(c.f.isHuman("late"), false);
    c.settle("late", { bot: false });
    await tick();
    assert.equal(c.f.isHuman("late"), true);
  });

  it("reset() ends the session: answers that arrive afterwards are dropped, and the slots come back only as the requests settle", async () => {
    const c = controlled({ maxPending: 2 });
    c.f.isHuman("a");
    c.f.isHuman("b");
    c.f.reset();
    assert.equal(c.f.stats().pending, 2, "unsettled lookups still count: the bound is on real outstanding work");
    assert.equal(c.f.stats().waiting, 0, "although this filter no longer waits on them");
    c.f.isHuman("a");
    c.f.isHuman("c");
    assert.deepEqual(c.started, ["a", "b"], "asking again joins a's request still out, and c finds the cap still full");
    c.settle("a", { bot: false });
    c.settle("b", { bot: false });
    await tick();
    assert.equal(c.f.size, 1, "only a, asked about again after the reset, was recorded; b's answer belonged to the ended session");
    assert.equal(c.f.isHuman("b"), false, "b is unknown again");
    assert.equal(c.f.isHuman("a"), true);
    assert.equal(c.f.stats().pending, 1, "b's new lookup is the only request out");
  });

  it("dispose() stops every timer and refuses to start another lookup", async () => {
    const c = controlled({ lookupTimeoutMs: 20 });
    c.f.isHuman("a");
    c.f.dispose();
    assert.equal(c.f.stats().pending, 1, "dispose does not pretend to cancel the request: it stays counted");
    await sleep(50);
    assert.equal(c.f.stats().timedOut, 0, "the timeout of a dropped wait never fires");
    assert.equal(c.f.isHuman("b"), false);
    assert.deepEqual(c.started, ["a"], "no lookup starts after dispose");
    assert.equal(c.f.stats().pending, 1, "the slot is still held after the timeout would have passed");
    c.settle("a", { bot: false });
    await tick();
    assert.equal(c.f.stats().pending, 0, "and is released only when the request settles");
    assert.equal(c.f.isHuman("a"), false);
    assert.equal(c.f.size, 0);
  });

  it("timeout, cooldown, reset and dispose never free a slot or start a second request for the same user", async () => {
    const c = controlled({ maxPending: 2, lookupTimeoutMs: 10, retryMs: 10, maxRetryMs: 10 });
    c.f.isHuman("u");
    await sleep(30); // timed out, and the cooldown it started has passed
    c.advance(100);
    c.f.isHuman("u");
    c.f.reset();
    c.f.isHuman("u"); // a new wait joins the request still out
    const replacement = c.another();
    replacement.isHuman("u");
    c.f.dispose();
    replacement.isHuman("u");
    assert.deepEqual(c.started, ["u"], "one request for u through timeout, cooldown, reset, a replacement filter and dispose");
    assert.equal(c.requests.stats().pending, 1);
    assert.ok(c.requests.stats().shared >= 2, "the later asks joined the request instead of starting one");
    c.settle("u", { bot: false });
    await tick();
    assert.equal(c.requests.stats().pending, 0);
    assert.equal(replacement.isHuman("u"), true, "the replacement, which was waiting on it, uses the answer");
  });

  it("a replacement filter on the same registry cannot add requests on top of the ones its predecessor left out", async () => {
    const requests = new IdentityRequests({ maxPending: 4 });
    const c = controlled({ requests });
    for (let i = 0; i < 6; i++) c.f.isHuman(`old-${i}`);
    c.f.dispose(); // the bot is replaced; its requests stay out
    const next = c.another();
    for (let i = 0; i < 6; i++) next.isHuman(`new-${i}`);
    const third = c.another();
    for (let i = 0; i < 6; i++) third.isHuman(`third-${i}`);
    assert.equal(c.started.length, 4, `requests started across three filters (${c.started.join(", ")})`);
    assert.equal(requests.stats().pending, 4);
    assert.equal(next.stats().refused + third.stats().refused, 12, "the replacements were refused, not queued");
    c.settle("old-0", null);
    await tick();
    assert.equal(next.isHuman("new-0"), false);
    assert.equal(c.started.length, 5, "a slot frees only when a request settles, and then one new request may start");
  });
});

describe("HumanFilter subscriptions: a reset, disposed or replaced filter is not held or called by a request still out (finding 2)", () => {
  it("30 sequential filter replacements on one never-settling request: one request, no subscriber growth, and the old filters are reclaimable", async () => {
    const c = controlled({ lookupTimeoutMs: 5 });
    const refs: WeakRef<object>[] = [];
    // Each replacement in a function of its own, so this test's frame holds none of them.
    const replace = () => {
      const f = c.another();
      assert.equal(f.isHuman("stuck"), false);
      assert.equal(f.stats().waiting, 1);
      refs.push(new WeakRef(f));
      f.dispose();
    };
    c.f.dispose();
    for (let i = 0; i < 30; i++) {
      replace();
      assert.equal(c.requests.stats().subscribers, 0, `no subscriber left after replacement ${i + 1}`);
    }
    await sleep(20); // past every lookup timeout
    assert.deepEqual(c.started, ["stuck"], "one underlying request");
    assert.deepEqual({ pending: c.requests.stats().pending, subscribers: c.requests.stats().subscribers }, { pending: 1, subscribers: 0 });
    const retained = await alive(refs);
    assert.equal(retained, 0, `no disposed filter is reachable from the request (${retained} of 30 were)`);
  });

  it("late settlement reaches only the filter still waiting: a reset or disposed filter learns nothing and is not called", async () => {
    const c = controlled();
    const old = c.f;
    const reset = c.another();
    const current = c.another();
    for (const f of [old, reset, current]) assert.equal(f.isHuman("u"), false);
    assert.equal(c.started.length, 1);
    assert.equal(c.requests.stats().subscribers, 3);
    old.dispose();
    reset.reset();
    assert.equal(c.requests.stats().subscribers, 1, "only the current filter is still subscribed");
    c.settle("u", { bot: false });
    await tick();
    assert.equal(current.isHuman("u"), true, "the current filter learns the answer");
    assert.equal(old.size, 0, "the disposed filter learned nothing");
    assert.equal(reset.size, 0, "nor did the reset one");
    assert.equal(reset.isHuman("u"), false, "it asks again instead (a new request: the old one has settled)");
    assert.equal(c.started.length, 2);
  });

  it("concurrent active filters on one request both learn the answer, and one disposing does not affect the other", async () => {
    const c = controlled();
    const a = c.f;
    const b = c.another();
    a.isHuman("u");
    b.isHuman("u");
    a.isHuman("v");
    b.isHuman("v");
    assert.equal(c.started.length, 2, "one request per user, shared");
    a.dispose();
    c.settle("u", { bot: false });
    c.settle("v", { bot: true });
    await tick();
    assert.equal(b.isHuman("u"), true);
    assert.equal(b.isHuman("v"), false, "a bot stays a bot");
    assert.equal(b.stats().waiting, 0);
    assert.equal(c.requests.stats().subscribers, 0);
  });

  it("a filter disposed by an earlier subscriber during settlement is not called by that settlement", async () => {
    const c = controlled();
    const b = c.another();
    const calls: string[] = [];
    const bSettled = (b as unknown as { settled: (...args: unknown[]) => void }).settled.bind(b);
    (b as unknown as { settled: (...args: unknown[]) => void }).settled = (...args) => {
      calls.push("B");
      bSettled(...args);
    };
    c.requests.request("u", () => Promise.resolve(null), () => {
      calls.push("A");
      b.dispose();
    });
    assert.equal(b.isHuman("u"), false);
    assert.deepEqual(c.started, [], "B subscribed to the request A's caller started");
    await tick();
    assert.deepEqual(calls, ["A"], "B's settlement handler is not invoked after B was disposed");
    assert.deepEqual({ waiting: b.stats().waiting, size: b.size }, { waiting: 0, size: 0 });
  });

  it("the stats report the registry's subscriber count alongside pending and stalled", () => {
    const c = controlled({ maxPending: 8 });
    c.f.isHuman("a");
    c.another().isHuman("a");
    assert.deepEqual({ pending: c.f.stats().pending, waiting: c.f.stats().waiting, subscribers: c.f.stats().subscribers }, { pending: 1, waiting: 1, subscribers: 2 });
  });
});
