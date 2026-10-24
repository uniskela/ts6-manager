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
