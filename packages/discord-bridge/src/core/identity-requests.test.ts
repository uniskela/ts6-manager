import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alive } from "../testing/gc.js";
import { IdentityRequests, type DiscordUserInfo } from "./identity-requests.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Requests the test settles by hand, and the answers each subscriber received. */
function controlled() {
  const settle = new Map<string, (v: DiscordUserInfo | null) => void>();
  const start = (id: string) => new Promise<DiscordUserInfo | null>((resolve) => settle.set(id, resolve));
  const heard: string[] = [];
  const listen = (who: string) => (info: DiscordUserInfo | null) => heard.push(`${who}:${info ? info.bot : "null"}`);
  return { settle, start, heard, listen };
}

describe("IdentityRequests: the process-wide count of identity requests", () => {
  it("holds each request until it settles, one per user, and refuses over the cap without queueing", async () => {
    let now = 0;
    const r = new IdentityRequests({ maxPending: 2, stallMs: 100, now: () => now });
    const { settle, start, heard, listen } = controlled();
    assert.ok(r.request("a", start, listen("a1")));
    assert.ok(r.request("a", start, listen("a2")), "a second ask for the same user subscribes to the same request");
    assert.ok(r.request("b", start, listen("b")));
    assert.equal(r.request("c", start, listen("c")), null, "over the cap: refused");
    assert.deepEqual([...settle.keys()], ["a", "b"], "and nothing was started for it");
    now = 150;
    assert.deepEqual({ ...r.stats() }, { pending: 2, stalled: 2, subscribers: 3, refused: 1, shared: 1, started: 2, settled: 0 });
    settle.get("a")!({ bot: false });
    await tick();
    assert.deepEqual(heard, ["a1:false", "a2:false"], "every subscriber hears the one answer");
    assert.equal(r.has("a"), false, "a slot frees only when its request settles");
    assert.ok(r.request("c", start, listen("c")));
  });

  it("a request that rejects, throws synchronously or answers without a boolean resolves null and frees its slot", async () => {
    const r = new IdentityRequests({ maxPending: 1 });
    const heard: (DiscordUserInfo | null)[] = [];
    r.request("x", () => Promise.reject(new Error("503")), (i) => heard.push(i));
    await tick();
    r.request(
      "y",
      () => {
        throw new Error("boom");
      },
      (i) => heard.push(i),
    );
    await tick();
    r.request("z", async () => ({}) as DiscordUserInfo, (i) => heard.push(i));
    await tick();
    assert.deepEqual(heard, [null, null, null]);
    assert.equal(r.stats().pending, 0);
    assert.equal(r.stats().settled, 3);
  });
});

describe("IdentityRequests: owning a request and waiting for its answer are separate (finding 2)", () => {
  it("cancelling a subscription drops the subscriber, and the request stays out and counted", async () => {
    const r = new IdentityRequests({ maxPending: 8 });
    const { settle, start, heard, listen } = controlled();
    const sub = r.request("u", start, listen("old"))!;
    assert.equal(r.stats().subscribers, 1);
    sub.cancel();
    sub.cancel(); // idempotent
    assert.deepEqual({ pending: r.stats().pending, subscribers: r.stats().subscribers }, { pending: 1, subscribers: 0 }, "unsubscribing is not cancelling the request");
    r.request("u", start, listen("new"));
    assert.equal(settle.size, 1, "a new subscriber joins the request still out instead of starting another");
    settle.get("u")!({ bot: false });
    await tick();
    assert.deepEqual(heard, ["new:false"], "late settlement reaches only the subscriber still waiting");
    assert.equal(r.stats().pending, 0);
  });

  it("30 subscribe-and-cancel rounds on one request that never settles: one request, no subscriber growth, and the callers are reclaimable", async () => {
    const r = new IdentityRequests({ maxPending: 8 });
    const { settle, start } = controlled();
    const refs: WeakRef<object>[] = [];
    // In a function of its own, so the test's suspended async frame cannot be what holds the last owner.
    const round = (i: number) => {
      const owner = { name: `filter-${i}`, heard: [] as unknown[] }; // stands for a filter and its bot
      const sub = r.request("stuck", start, (info) => owner.heard.push(info))!;
      refs.push(new WeakRef(owner));
      sub.cancel();
    };
    for (let i = 0; i < 30; i++) {
      round(i);
      assert.equal(r.stats().subscribers, 0);
    }
    assert.equal(settle.size, 1, "one underlying request");
    assert.deepEqual({ pending: r.stats().pending, shared: r.stats().shared }, { pending: 1, shared: 29 });
    const retained = await alive(refs);
    assert.equal(retained, 0, `no cancelled caller is reachable from the unsettled request (${retained} of 30 were)`);
  });

  it("an uncancelled caller is reachable from the request until it settles (the control for the test above)", async () => {
    const r = new IdentityRequests();
    const { settle, start } = controlled();
    const refs: WeakRef<object>[] = [];
    (() => {
      const owner = { heard: [] as unknown[] };
      r.request("held", start, (info) => owner.heard.push(info));
      refs.push(new WeakRef(owner));
    })();
    assert.equal(await alive(refs), 1, "held through its subscription");
    settle.get("held")!(null);
    await tick();
    assert.equal(await alive(refs), 0, "and released by settlement");
  });

  it("the start function is not kept by an unsettled request", async () => {
    const r = new IdentityRequests();
    const refs: WeakRef<object>[] = [];
    const held: unknown[] = []; // the request stays reachable, as an open socket would keep it
    (() => {
      const owner = { client: "stands for a bot" };
      const start = () => {
        void owner;
        return new Promise<DiscordUserInfo | null>((resolve) => held.push(resolve));
      };
      refs.push(new WeakRef(owner));
      r.request("forever", start, () => undefined)!.cancel();
    })();
    assert.equal(await alive(refs), 0);
    assert.equal(r.stats().pending, 1);
  });

  it("concurrent subscribers: one cancels, the other still gets the answer; a throwing subscriber does not stop the rest", async () => {
    const r = new IdentityRequests();
    const { settle, start, heard, listen } = controlled();
    const gone = r.request("u", start, listen("gone"))!;
    r.request("u", start, () => {
      throw new Error("subscriber failed");
    });
    r.request("u", start, listen("kept"));
    gone.cancel();
    settle.get("u")!({ bot: true });
    await tick();
    assert.deepEqual(heard, ["kept:true"]);
    assert.equal(r.stats().subscribers, 0, "settlement drops every subscription");
  });

  it("the eight-request cap is unchanged by subscriptions and cancellations", async () => {
    const r = new IdentityRequests();
    const { settle, start } = controlled();
    for (let i = 0; i < 8; i++) r.request(`u${i}`, start, () => undefined)!.cancel();
    assert.equal(r.request("u8", start, () => undefined), null, "cancelled subscriptions still leave eight requests out");
    assert.equal(r.stats().pending, 8);
    assert.ok(r.request("u3", start, () => undefined), "a user already out can still be subscribed to");
    settle.get("u0")!(null);
    await tick();
    assert.ok(r.request("u8", start, () => undefined), "a slot frees only by settlement");
  });
});
