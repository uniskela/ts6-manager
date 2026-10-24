import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verify } from "./test-verify.mjs";

const pass = (file, name) => ({ file, name, status: "pass", skip: false, todo: false });
const base = () => ({
  events: [pass("a.test.ts", "one"), pass("a.test.ts", "two"), pass("b.test.ts", "one")],
  expected: { "a.test.ts": 2, "b.test.ts": 1 },
  discovered: ["a.test.ts", "b.test.ts"],
});

describe("test-run verification", () => {
  it("accepts a complete, green run", () => {
    const r = verify(base());
    assert.equal(r.ok, true);
    assert.equal(r.total, 3);
  });

  it("fails a truncated report even though nothing failed (the forced-exit symptom)", () => {
    const run = base();
    run.events.pop(); // b.test.ts reported nothing at all
    const r = verify(run);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.startsWith("NOT RUN b.test.ts")));
    const partial = base();
    partial.events.splice(1, 1); // a.test.ts reported 1 of 2
    assert.ok(verify(partial).problems.some((p) => p.includes("reported 1 tests, expected 2")));
  });

  it("fails a failed, skipped, todo or cancelled test", () => {
    for (const patch of [{ status: "fail" }, { skip: true }, { todo: true }, { cancelled: true }]) {
      const run = base();
      run.events[0] = { ...run.events[0], ...patch };
      assert.equal(verify(run).ok, false, JSON.stringify(patch));
    }
  });

  it("fails a test file that is not in the expected counts, and one that vanished", () => {
    const added = base();
    added.discovered.push("c.test.ts");
    added.events.push(pass("c.test.ts", "one"));
    assert.ok(verify(added).problems.some((p) => p.startsWith("UNLISTED c.test.ts")));
    const removed = base();
    removed.discovered = ["a.test.ts"];
    removed.events = removed.events.filter((e) => e.file === "a.test.ts");
    assert.ok(verify(removed).problems.some((p) => p.startsWith("MISSING b.test.ts")));
  });
});
