/**
 * Runs the real `scripts/run-tests.mjs` against small fixture projects and checks its exit status.
 * The unit tests of `verify()` cannot show that the command itself refuses a run: this does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A package-shaped directory whose own `scripts/` are copies of the real runner. */
function fixture({ files, expected, extra = {} }) {
  const root = mkdtempSync(join(tmpdir(), "d1-runner-fixture-"));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  for (const f of ["run-tests.mjs", "test-verify.mjs", "test-reporter.mjs"]) copyFileSync(join(here, f), join(root, "scripts", f));
  symlinkSync(join(pkg, "node_modules"), join(root, "node_modules"));
  for (const [path, text] of Object.entries({ ...files, ...extra })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, "scripts", "expected-tests.json"), `${JSON.stringify(expected, null, 2)}\n`);
  return root;
}

function run(root, args = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // an inner `node --test` must not believe it is a child of this one
  const r = spawnSync(process.execPath, [join(root, "scripts", "run-tests.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const suite = (...names) => `import { it } from "node:test";\n${names.map((n) => `it(${JSON.stringify(n)}, () => {});`).join("\n")}\n`;

describe("the real test command refuses a run that does not match what was expected", () => {
  it("accepts a fixture that matches exactly (control)", () => {
    const root = fixture({ files: { "src/a.test.ts": suite("one", "two") }, expected: { "src/a.test.ts": ["one", "two"] } });
    const r = run(root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified: 2 tests in 1 files/);
  });

  it("exits nonzero when a test file outside the discovered set registers tests that pass", () => {
    const root = fixture({
      files: { "src/a.test.ts": `import "../extra/sneaky.mjs";\n${suite("one")}` },
      extra: { "extra/sneaky.mjs": suite("sneaky") },
      expected: { "src/a.test.ts": ["one"] },
    });
    const r = run(root);
    assert.notEqual(r.code, 0, `the runner accepted an unexpected reported file:\n${r.out}`);
    assert.match(r.out, /TEST RUN NOT ACCEPTED/);
    assert.match(r.out, /UNEXPECTED FILE extra\/sneaky\.mjs/);
    assert.doesNotMatch(r.out, /verified:/);
  });

  it("exits nonzero when a test was renamed or swapped, although the count is unchanged", () => {
    const root = fixture({ files: { "src/a.test.ts": suite("one", "renamed") }, expected: { "src/a.test.ts": ["one", "two"] } });
    const r = run(root);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /NOT REPORTED src\/a\.test\.ts: "two"/);
    assert.match(r.out, /UNEXPECTED TEST src\/a\.test\.ts: "renamed"/);
  });

  it("--update refuses to record an unexpected reported file and leaves the expected list untouched", () => {
    const root = fixture({
      files: { "src/a.test.ts": `import "../extra/sneaky.mjs";\n${suite("one")}` },
      extra: { "extra/sneaky.mjs": suite("sneaky") },
      expected: { "src/a.test.ts": ["one"] },
    });
    const before = readFileSync(join(root, "scripts", "expected-tests.json"), "utf8");
    const r = run(root, ["--update"]);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(readFileSync(join(root, "scripts", "expected-tests.json"), "utf8"), before);
  });

  it("--update records test names, and a second run against them is accepted", () => {
    const root = fixture({ files: { "src/a.test.ts": suite("one", "two") }, expected: {} });
    const u = run(root, ["--update"]);
    assert.equal(u.code, 0, u.out);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "scripts", "expected-tests.json"), "utf8")), { "src/a.test.ts": ["one", "two"] });
    assert.equal(run(root).code, 0);
    assert.ok(existsSync(join(root, "scripts", "expected-tests.json")));
  });
});
