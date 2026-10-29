import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./private-beta.sh", import.meta.url));
const compose = fileURLToPath(new URL("../lab/docker-compose.private-beta.yml", import.meta.url));

function writeEnv(body, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "d1-beta-"));
  const file = join(dir, ".env");
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

function run(args, envFile, extra = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, D1_ENV_FILE: envFile, ...extra },
  });
}

const secret = "d1-test-token-must-not-appear-in-output";
const present = [
  "D1_RUNTIME_MODE=private-beta",
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

describe("private-beta.sh", () => {
  it("prints SET/MISSING only and does not start without --confirm", () => {
    const file = writeEnv(present);
    const r = run(["up"], file);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /D1_RUNTIME_MODE: SET/);
    assert.match(r.stdout, /presence complete/);
    assert.match(r.stdout, /up --confirm/);
    assert.equal(r.stdout.includes(secret), false);
    assert.equal(r.stdout.includes("not-a-real-host"), false);
  });

  it("exits 2 when the env file is not mode 0600", () => {
    const file = writeEnv(present, 0o644);
    const r = run(["check"], file);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /0600/);
  });

  it("refuses an unknown command and requires a SHA for rollback", () => {
    const file = writeEnv(present);
    const unknown = run(["deploy"], file);
    assert.equal(unknown.status, 2);
    const rollback = spawnSync("bash", [script, "rollback"], {
      encoding: "utf8",
      env: { ...process.env, D1_ENV_FILE: file },
    });
    assert.equal(rollback.status, 2);
    assert.match(rollback.stderr, /rollback <full-sha>/);
  });

  it("compose file is opt-in, pinned, unrestarted and has no published ports", () => {
    const src = readFileSync(compose, "utf8");
    const sh = readFileSync(script, "utf8");
    assert.match(src, /name: d1-private-beta/);
    assert.match(src, /ts6-discord-bridge-private-beta:\$\{SOURCE_COMMIT/);
    assert.match(src, /D1_RUNTIME_MODE: private-beta/);
    assert.match(src, /restart: "no"/);
    assert.match(src, /mem_limit: 512m/);
    assert.match(src, /cpus: "1.0"/);
    assert.match(src, /max-size: "4m"/);
    assert.match(src, /external: true/);
    assert.match(src, /private-beta-health\.ts/);
    assert.equal(/\n\s+ports:/.test(src), false);
    assert.equal(src.includes("0.0.0.0"), false);
    assert.equal(src.includes("unless-stopped"), false);
    assert.equal(src.includes("restart: always"), false);
    assert.match(sh, /--no-build/);
    assert.match(sh, /do not push/);
    assert.match(sh, /chmod 0755/);
    assert.match(sh, /docker exec/);
    assert.equal(sh.includes("docker push"), false);
  });

  it("treats a leftover status file as stale when the container is not running", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-beta-evid-"));
    writeFileSync(join(dir, "host-status.json"), JSON.stringify({
      mode: "private-beta",
      health: "ok",
      daveReady: true,
      receiver: "slot-0",
      state: "running",
      counters: {},
    }));
    const envFile = writeEnv(present);
    const r = spawnSync("bash", [script, "status"], {
      encoding: "utf8",
      env: { ...process.env, D1_ENV_FILE: envFile, D1_EVIDENCE_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /health=stale/);
    assert.match(r.stdout, /container_running=no/);
    assert.equal(/^health=ok$/m.test(r.stdout), false);
  });
});
