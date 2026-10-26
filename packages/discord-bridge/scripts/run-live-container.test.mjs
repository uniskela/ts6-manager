import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./run-live-container.sh", import.meta.url));

function writeEnv(body, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "d1-live-"));
  const file = join(dir, ".env");
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

function run(envFile, extra = {}) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, D1_ENV_FILE: envFile, ...extra },
  });
}

const secret = "d1-test-token-must-not-appear-in-output";
const present = [
  `D1_DISCORD_TOKEN_SLOT_0=${secret}`,
  "D1_DISCORD_TOKEN_SLOT_1=slot-1-dummy",
  "D1_DISCORD_TOKEN_SLOT_2=slot-2-dummy",
  "D1_DISCORD_TOKEN_SLOT_3=slot-3-dummy",
  "D1_DISCORD_TOKEN_SLOT_4=slot-4-dummy",
  "D1_DISCORD_TOKEN_OVERFLOW=overflow-dummy",
  "D1_DISCORD_GUILD_ID=111111111111111111",
  "D1_DISCORD_CHANNEL_ID=222222222222222222",
  "D1_TS_HOST=not-a-real-host.invalid",
].join("\n");

describe("run-live-container.sh presence-only", () => {
  it("exits 2 when the env file is missing", () => {
    const r = run(join(tmpdir(), "d1-missing-env-file"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing env file/);
  });

  it("exits 2 when the env file is not mode 0600", () => {
    const file = writeEnv(present, 0o644);
    const r = run(file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /0600/);
  });

  it("prints SET/MISSING only, never token values, and does not start live without --confirm", () => {
    const file = writeEnv(present);
    const r = run(file);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /D1_DISCORD_TOKEN_SLOT_0: SET/);
    assert.match(r.stdout, /D1_TS_HOST: SET/);
    assert.match(r.stdout, /presence complete/);
    assert.equal(r.stdout.includes(secret), false);
    assert.equal(r.stdout.includes("not-a-real-host"), false);
  });

  it("exits 2 when a required variable is MISSING", () => {
    const file = writeEnv(present.replace(/D1_TS_HOST=.*/, "D1_TS_HOST="));
    const r = run(file);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /D1_TS_HOST: MISSING/);
    assert.match(r.stdout, /live start blocked/);
  });
});
