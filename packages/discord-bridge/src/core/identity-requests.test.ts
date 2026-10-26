import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdentityRequests, type DiscordUserInfo } from "./identity-requests.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("IdentityRequests: the process-wide count of identity requests", () => {
  it("holds each request until it settles, one per user, and refuses over the cap without queueing", async () => {
    let now = 0;
    const r = new IdentityRequests({ maxPending: 2, stallMs: 100, now: () => now });
    const settle = new Map<string, (v: DiscordUserInfo | null) => void>();
    const start = (id: string) => new Promise<DiscordUserInfo | null>((resolve) => settle.set(id, resolve));
    const a = r.request("a", start);
    assert.ok(a);
    assert.equal(r.request("a", start), a, "a second ask for the same user is the same request");
    assert.ok(r.request("b", start));
    assert.equal(r.request("c", start), null, "over the cap: refused");
    assert.deepEqual([...settle.keys()], ["a", "b"], "and nothing was started for it");
    now = 150;
    assert.deepEqual({ ...r.stats() }, { pending: 2, stalled: 2, refused: 1, shared: 1, started: 2, settled: 0 });
    settle.get("a")!({ bot: false });
    assert.deepEqual(await a, { bot: false });
    assert.equal(r.has("a"), false, "a slot frees only when its request settles");
    assert.ok(r.request("c", start));
  });

  it("a request that rejects, throws synchronously or answers without a boolean resolves null and frees its slot", async () => {
    const r = new IdentityRequests({ maxPending: 1 });
    assert.equal(await r.request("x", () => Promise.reject(new Error("503"))), null);
    assert.equal(
      await r.request("y", () => {
        throw new Error("boom");
      }),
      null,
    );
    assert.equal(await r.request("z", async () => ({}) as DiscordUserInfo), null);
    await tick();
    assert.equal(r.stats().pending, 0);
    assert.equal(r.stats().settled, 3);
  });
});
