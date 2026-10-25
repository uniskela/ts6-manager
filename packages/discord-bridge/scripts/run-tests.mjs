#!/usr/bin/env node
/**
 * Runs every test file and then verifies that the run is exactly what was expected: the files
 * discovered, the files listed in scripts/expected-tests.json and the files that reported results
 * are the same set, each reports exactly its listed tests, and none failed, was skipped, todo or
 * cancelled. Exit code zero from node:test alone is not accepted.
 *
 *   node scripts/run-tests.mjs            run and verify
 *   node scripts/run-tests.mjs --update   run, then rewrite scripts/expected-tests.json (review the diff:
 *                                         a renamed test shows up as one name removed and one added)
 *
 * No --test-force-exit: it exits 0 after a truncated report. Tests must close what they open.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit, namesByFile, verify } from "./test-verify.mjs";

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
    } else if (match(name)) out.push(relative(root, p).replaceAll("\\", "/"));
  }
  return out;
}

const discovered = [...discover(join(root, "src"), (n) => n.endsWith(".test.ts")), ...discover(join(root, "scripts"), (n) => n.endsWith(".test.mjs"))].sort(byCodeUnit);
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
  { cwd: root, stdio: "inherit", env: { ...process.env, D1_TEST_ROOT: root } },
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
    const names = namesByFile(events);
    const r = verify({ events, expected: names, discovered });
    problems.push(...r.problems);
    if (problems.length === 0) {
      writeFileSync(expectedPath, `${JSON.stringify(names, null, 2)}\n`);
      process.stdout.write(`\nupdated ${relative(root, expectedPath)}: ${events.length} tests in ${Object.keys(names).length} files\n`);
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
