#!/usr/bin/env node
/**
 * Runs every test file and then verifies that the run is complete: every discovered file reported,
 * each with its expected number of tests, none failed, skipped, todo or cancelled. Exit code zero
 * from node:test alone is not accepted.
 *
 *   node scripts/run-tests.mjs            run and verify
 *   node scripts/run-tests.mjs --update   run, then rewrite scripts/expected-tests.json (review the diff)
 *
 * No --test-force-exit: it exits 0 after a truncated report. Tests must close what they open.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "./test-verify.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const expectedPath = join(root, "scripts", "expected-tests.json");
const update = process.argv.includes("--update");
const TEST_TIMEOUT_MS = 120_000;
const RUN_DEADLINE_MS = 600_000;

function discover(dir, match, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== ".vendor") discover(p, match, out);
    } else if (match(name)) out.push(relative(root, p).split("\\").join("/"));
  }
  return out;
}

const discovered = [...discover(join(root, "src"), (n) => n.endsWith(".test.ts")), ...discover(join(root, "scripts"), (n) => n.endsWith(".test.mjs"))].sort();
const work = mkdtempSync(join(tmpdir(), "d1-tests-"));
const resultsFile = join(work, "results.jsonl");

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    `--test-timeout=${TEST_TIMEOUT_MS}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${join(root, "scripts", "test-reporter.mjs")}`,
    `--test-reporter-destination=${resultsFile}`,
    ...discovered,
  ],
  { cwd: root, stdio: "inherit" },
);
const deadline = setTimeout(() => {
  process.stderr.write(`\ntest run exceeded ${RUN_DEADLINE_MS} ms; killing it\n`);
  child.kill("SIGKILL");
}, RUN_DEADLINE_MS);

child.on("exit", (code, signal) => {
  clearTimeout(deadline);
  let events = [];
  try {
    events = readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no results file: verification below reports every file as not run */
  }
  rmSync(work, { recursive: true, force: true });
  const problems = [];
  if (code !== 0) problems.push(`node:test exited with ${signal ?? code}`);

  if (update) {
    const counts = {};
    for (const e of events) counts[e.file] = (counts[e.file] ?? 0) + 1;
    const r = verify({ events, expected: counts, discovered });
    problems.push(...r.problems);
    if (problems.length === 0) {
      writeFileSync(expectedPath, `${JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
      process.stdout.write(`\nupdated ${relative(root, expectedPath)}: ${events.length} tests in ${Object.keys(counts).length} files\n`);
    }
  } else {
    const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
    const r = verify({ events, expected, discovered });
    problems.push(...r.problems);
    if (problems.length === 0) process.stdout.write(`\nverified: ${r.total} tests in ${r.files} files, none failed, skipped, todo or cancelled\n`);
  }
  if (problems.length) {
    process.stderr.write(`\nTEST RUN NOT ACCEPTED:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
});
