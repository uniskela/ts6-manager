import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verify } from "./test-verify.mjs";

const pass = (file, name) => ({ file, name, status: "pass", skip: false, todo: false });
const base = () => ({
  events: [pass("a.test.ts", "one"), pass("a.test.ts", "two"), pass("b.test.ts", "one")],
  expected: { "a.test.ts": ["one", "two"], "b.test.ts": ["one"] },
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
    const problems = verify(partial).problems;
    assert.ok(problems.some((p) => p.includes("reported 1 tests, expected 2")));
    assert.ok(problems.some((p) => p.startsWith('NOT REPORTED a.test.ts: "two"')), "and it names the test that never reported");
  });

  it("fails a failed, skipped, todo or cancelled test", () => {
    for (const patch of [{ status: "fail" }, { skip: true }, { todo: true }, { cancelled: true }]) {
      const run = base();
      run.events[0] = { ...run.events[0], ...patch };
      assert.equal(verify(run).ok, false, JSON.stringify(patch));
    }
  });

  it("fails a test file that is not in the expected list, and one that vanished", () => {
    const added = base();
    added.discovered.push("c.test.ts");
    added.events.push(pass("c.test.ts", "one"));
    assert.ok(verify(added).problems.some((p) => p.startsWith("UNLISTED c.test.ts")));
    const removed = base();
    removed.discovered = ["a.test.ts"];
    removed.events = removed.events.filter((e) => e.file === "a.test.ts");
    assert.ok(verify(removed).problems.some((p) => p.startsWith("MISSING b.test.ts")));
  });

  it("fails a reported file that was never discovered or expected, even though every test in it passed", () => {
    const run = base();
    run.events.push(pass("extra/helper.mjs", "registered by an import"));
    const r = verify(run);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.startsWith("UNEXPECTED FILE extra/helper.mjs")), r.problems.join("\n"));
    // Listing it in the expected map does not make it a test file: it must also be discovered.
    run.expected["extra/helper.mjs"] = ["registered by an import"];
    assert.ok(verify(run).problems.some((p) => p.startsWith("UNEXPECTED FILE extra/helper.mjs")));
  });

  it("fails when the discovered, expected and reported files are not exactly the same set", () => {
    for (const mutate of [
      (r) => r.discovered.push("c.test.ts"), // on disk, not expected, not reported
      (r) => (r.expected["c.test.ts"] = ["one"]), // expected, not on disk, not reported
      (r) => r.events.push(pass("c.test.ts", "one")), // reported only
      (r) => r.events.pop(), // expected and discovered, not reported
    ]) {
      const run = base();
      mutate(run);
      assert.equal(verify(run).ok, false, mutate.toString());
    }
  });

  it("fails a test that was replaced by another with the same count", () => {
    const run = base();
    run.events[1] = pass("a.test.ts", "something else"); // still two tests in a.test.ts
    const problems = verify(run).problems;
    assert.ok(problems.some((p) => p.startsWith('NOT REPORTED a.test.ts: "two"')));
    assert.ok(problems.some((p) => p.startsWith('UNEXPECTED TEST a.test.ts: "something else"')));
    assert.ok(!problems.some((p) => p.startsWith("COUNT")), "the counts alone would have accepted this");
  });

  it("counts a name that is reported twice as two tests", () => {
    const run = base();
    run.events.push(pass("a.test.ts", "one"));
    const problems = verify(run).problems;
    assert.ok(problems.some((p) => p.startsWith('UNEXPECTED TEST a.test.ts: "one"')));
    run.expected["a.test.ts"] = ["one", "one", "two"];
    assert.equal(verify(run).ok, true);
  });
});
