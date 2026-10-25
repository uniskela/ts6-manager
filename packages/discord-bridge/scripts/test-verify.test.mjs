import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { namesByFile, readManifest, verify } from "./test-verify.mjs";

const pass = (file, name, nesting = 0) => ({ kind: "result", file, nesting, name, type: "test", status: "pass", skip: false, todo: false, cancelled: false, failureType: null });
const counts = (tests, topLevel, suites = 0) => ({ tests, passed: tests, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel, suites });
const summary = (file, tests) => ({ kind: "summary", file, counts: counts(tests, tests), success: true });

/** What the reporter writes for a run in which every file of `ran` (file -> names) reached its end. */
function records(ran) {
  const out = [];
  let total = 0;
  for (const [file, names] of Object.entries(ran)) {
    for (const name of names) out.push({ kind: "enqueue", file, nesting: 0, name });
    for (const name of names) out.push(pass(file, name));
    out.push(summary(file, names.length));
    total += names.length;
  }
  out.push({ kind: "summary", file: null, counts: counts(total, total), success: true }, { kind: "end" });
  return out;
}

const base = () => ({
  ran: { "a.test.ts": ["one", "two"], "b.test.ts": ["one"] },
  expected: { "a.test.ts": ["one", "two"], "b.test.ts": ["one"] },
  discovered: ["a.test.ts", "b.test.ts"],
});
const check = (r, edit = (x) => x) => verify({ records: edit(records(r.ran)), expected: r.expected, discovered: r.discovered });
const has = (problems, prefix) => problems.some((p) => p.startsWith(prefix));

describe("test-run verification", () => {
  it("accepts a complete, green run", () => {
    const r = check(base());
    assert.equal(r.ok, true, r.problems.join("\n"));
    assert.equal(r.total, 3);
  });

  it("fails a truncated report even though nothing failed (the forced-exit symptom)", () => {
    const r = check(base(), (rs) => rs.filter((x) => x.file !== "b.test.ts")); // b.test.ts reported nothing at all
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, "NOT RUN b.test.ts"));
    assert.ok(has(r.problems, "INCOMPLETE b.test.ts"));
    const partial = check(base(), (rs) => rs.filter((x) => !(x.kind === "result" && x.name === "two"))); // a.test.ts reported 1 of 2
    assert.ok(partial.problems.some((p) => p.includes("reported 1 tests, expected 2")));
    assert.ok(has(partial.problems, 'NOT REPORTED a.test.ts: "two"'), "and it names the test that never reported");
    assert.ok(has(partial.problems, 'NEVER FINISHED a.test.ts: "two"'), "and node:test's own record shows it was registered");
  });

  it("fails a failed, skipped, todo or cancelled test", () => {
    for (const patch of [{ status: "fail" }, { skip: true }, { todo: true }, { cancelled: true }]) {
      const r = check(base(), (rs) => rs.map((x) => (x.kind === "result" && x.name === "one" && x.file === "a.test.ts" ? { ...x, ...patch } : x)));
      assert.equal(r.ok, false, JSON.stringify(patch));
    }
  });

  it("fails a failing or skipped suite even when every test in it passed", () => {
    for (const patch of [{ status: "fail", failureType: "hookFailed" }, { skip: true }]) {
      const suite = { kind: "result", file: "a.test.ts", nesting: 0, name: "group", type: "suite", status: "pass", skip: false, todo: false, cancelled: false, failureType: null, ...patch };
      const r = check(base(), (rs) => [...rs, { kind: "enqueue", file: "a.test.ts", nesting: 0, name: "group" }, suite]);
      assert.ok(has(r.problems, "FAILED a.test.ts: suite: group") || has(r.problems, "SKIPPED a.test.ts: suite: group"), JSON.stringify(patch));
    }
  });

  it("fails a test file that is not in the expected list, and one that vanished", () => {
    const added = base();
    added.discovered.push("c.test.ts");
    added.ran["c.test.ts"] = ["one"];
    assert.ok(has(check(added).problems, "UNLISTED c.test.ts"));
    const removed = base();
    removed.discovered = ["a.test.ts"];
    delete removed.ran["b.test.ts"];
    assert.ok(has(check(removed).problems, "MISSING b.test.ts"));
  });

  it("fails a reported file that was never discovered or expected, even though every test in it passed", () => {
    const run = base();
    run.ran["extra/helper.mjs"] = ["registered by an import"];
    const r = check(run);
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, "UNEXPECTED FILE extra/helper.mjs"), r.problems.join("\n"));
    // Listing it in the expected map does not make it a test file: it must also be discovered.
    run.expected["extra/helper.mjs"] = ["registered by an import"];
    assert.ok(has(check(run).problems, "UNEXPECTED FILE extra/helper.mjs"));
  });

  it("fails when the discovered, expected and reported files are not exactly the same set", () => {
    for (const mutate of [
      (r) => r.discovered.push("c.test.ts"), // on disk, not expected, not reported
      (r) => (r.expected["c.test.ts"] = ["one"]), // expected, not on disk, not reported
      (r) => (r.ran["c.test.ts"] = ["one"]), // reported only
      (r) => delete r.ran["b.test.ts"], // expected and discovered, not reported
    ]) {
      const run = base();
      mutate(run);
      assert.equal(check(run).ok, false, mutate.toString());
    }
  });

  it("fails a test that was replaced by another with the same count", () => {
    const run = base();
    run.ran["a.test.ts"] = ["one", "something else"]; // still two tests in a.test.ts
    const problems = check(run).problems;
    assert.ok(has(problems, 'NOT REPORTED a.test.ts: "two"'));
    assert.ok(has(problems, 'UNEXPECTED TEST a.test.ts: "something else"'));
    assert.ok(!has(problems, "COUNT"), "the counts alone would have accepted this");
  });

  it("counts a name that is reported twice as two tests", () => {
    const run = base();
    run.ran["a.test.ts"] = ["one", "two", "one"];
    assert.ok(has(check(run).problems, 'UNEXPECTED TEST a.test.ts: "one"'));
    run.expected["a.test.ts"] = ["one", "one", "two"];
    assert.equal(check(run).ok, true);
  });
});

describe("test-run completeness comes from node:test's own records, not from the expected list", () => {
  it("fails a file that never reported node:test's end-of-file summary, although every expected test passed", () => {
    const r = check(base(), (rs) => rs.filter((x) => !(x.kind === "summary" && x.file === "a.test.ts")));
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, "INCOMPLETE a.test.ts"), r.problems.join("\n"));
    const twice = check(base(), (rs) => [...rs, summary("a.test.ts", 2)]);
    assert.ok(has(twice.problems, "INCOMPLETE a.test.ts"), "a file has exactly one end");
  });

  it("fails a test that was registered and scheduled but never reported, even when the expected list agrees with the run", () => {
    // The incomplete list a broken --update would write: it matches what the unfinished file reported.
    const run = base();
    run.ran["a.test.ts"] = ["one"];
    run.expected["a.test.ts"] = ["one"];
    const r = check(run, (rs) => [...rs, { kind: "enqueue", file: "a.test.ts", nesting: 0, name: "two" }]);
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, 'NEVER FINISHED a.test.ts: "two"'), r.problems.join("\n"));
    const nested = check(base(), (rs) => [...rs, { kind: "enqueue", file: "b.test.ts", nesting: 1, name: "inner" }]);
    assert.ok(has(nested.problems, 'NEVER FINISHED b.test.ts: "inner"'), "at any depth");
  });

  it("fails a result node:test never registered", () => {
    const r = check(base(), (rs) => rs.filter((x) => !(x.kind === "enqueue" && x.name === "two")));
    assert.ok(has(r.problems, 'UNREGISTERED a.test.ts: "two"'), r.problems.join("\n"));
  });

  it("fails a file that node:test reported as a whole, whether it passed or failed", () => {
    for (const status of ["pass", "fail"]) {
      const r = check(base(), (rs) => [...rs, { kind: "wrapper", file: "b.test.ts", status }]);
      assert.equal(r.ok, false, status);
      assert.ok(has(r.problems, "FILE WRAPPER b.test.ts"), status);
    }
  });

  it("fails a run whose event stream was cut short, or whose end node:test never reported or reported as failed", () => {
    const noEnd = check(base(), (rs) => rs.filter((x) => x.kind !== "end"));
    assert.ok(has(noEnd.problems, "REPORT TRUNCATED"), noEnd.problems.join("\n"));
    const noWhole = check(base(), (rs) => rs.filter((x) => !(x.kind === "summary" && x.file === null)));
    assert.ok(has(noWhole.problems, "RUN INCOMPLETE"));
    const failed = check(base(), (rs) => rs.map((x) => (x.kind === "summary" && x.file === null ? { ...x, success: false } : x)));
    assert.ok(has(failed.problems, "RUN FAILED"));
    assert.equal(verify({ records: [], expected: base().expected, discovered: base().discovered }).ok, false, "no records at all");
  });

  it("fails a file summary that disagrees with the results reported for it", () => {
    for (const patch of [{ tests: 3 }, { passed: 1 }, { failed: 1 }, { cancelled: 1 }, { skipped: 1 }, { todo: 1 }, { suites: 1 }, { topLevel: 1 }]) {
      const r = check(base(), (rs) => rs.map((x) => (x.kind === "summary" && x.file === "a.test.ts" ? { ...x, counts: { ...x.counts, ...patch } } : x)));
      assert.equal(r.ok, false, JSON.stringify(patch));
    }
    const unsuccessful = check(base(), (rs) => rs.map((x) => (x.kind === "summary" && x.file === "a.test.ts" ? { ...x, success: false } : x)));
    assert.ok(has(unsuccessful.problems, "INCOMPLETE a.test.ts"));
  });

  it("records only leaf tests, never suites or files reported as a whole", () => {
    const rs = [...records({ "a.test.ts": ["two", "one"] }), { kind: "result", file: "a.test.ts", nesting: 0, name: "group", type: "suite", status: "pass" }, { kind: "wrapper", file: "a.test.ts", status: "pass" }];
    assert.deepEqual(namesByFile(rs), { "a.test.ts": ["one", "two"] });
  });
});

describe("the expected list is checked before it is trusted", () => {
  it("accepts exactly what --update writes", () => {
    const written = namesByFile(records({ "b.test.ts": ["z", "a"], "a.test.ts": ["one"] }));
    const m = readManifest(`${JSON.stringify(written, null, 2)}\n`);
    assert.deepEqual(m.problems, []);
    assert.deepEqual(m.expected, written);
  });

  it("reports an unreadable, misshapen or reordered list and trusts none of it", () => {
    for (const text of ["", "{ not json", "[]", "null", '"a"', '{"a.test.ts": "one"}', '{"a.test.ts": [1]}', '{"a.test.ts": ["two", "one"]}', '{"b.test.ts": [], "a.test.ts": []}']) {
      const m = readManifest(text);
      assert.ok(m.problems.length > 0 && m.problems.every((p) => p.startsWith("MANIFEST")), text);
    }
  });
});
