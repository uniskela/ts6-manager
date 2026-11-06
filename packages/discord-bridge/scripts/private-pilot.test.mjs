import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./private-pilot.sh", import.meta.url));
const compose = fileURLToPath(new URL("../lab/docker-compose.private-pilot.yml", import.meta.url));
const canonical = fileURLToPath(new URL("../lab/.env.pilot", import.meta.url));

function writeEnv(body, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "d1-pilot-"));
  const file = join(dir, ".env.pilot");
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

const digest = `ghcr.io/uniskela/ts6-manager/discord-bridge@sha256:${"a".repeat(64)}`;
const sha = "b".repeat(40);
const secret = "d1-test-token-must-not-appear-in-output";
const present = [
  "D1_RUNTIME_MODE=private-beta",
  "D1_PILOT_EXTERNAL_TS=1",
  "D1_PILOT_CHANNEL_CONFIRMED=1",
  "D1_PILOT_ACK=cross-platform-forwarding-informed",
  `D1_DISCORD_TOKEN_SLOT_0=${secret}`,
  "D1_DISCORD_TOKEN_SLOT_1=slot-1-dummy",
  "D1_DISCORD_TOKEN_SLOT_2=slot-2-dummy",
  "D1_DISCORD_TOKEN_SLOT_3=slot-3-dummy",
  "D1_DISCORD_TOKEN_SLOT_4=slot-4-dummy",
  "D1_DISCORD_TOKEN_OVERFLOW=overflow-dummy",
  "D1_DISCORD_GUILD_ID=111111111111111111",
  "D1_DISCORD_CHANNEL_ID=222222222222222222",
  "D1_TS_HOST=ts.example.invalid",
  "D1_TS_CHANNEL=bridge-pilot",
].join("\n");

function run(args, envFile, extra = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      D1_PILOT_ENV_FILE: envFile,
      D1_BRIDGE_IMAGE: digest,
      SOURCE_COMMIT: sha,
      ...extra,
    },
  });
}

function withCanonical(body, fn) {
  const existed = existsSync(canonical);
  const previous = existed ? { body: readFileSync(canonical), mode: 0o600 } : null;
  writeFileSync(canonical, body);
  chmodSync(canonical, 0o600);
  try {
    return fn();
  } finally {
    if (previous) {
      writeFileSync(canonical, previous.body);
      chmodSync(canonical, previous.mode);
    } else {
      unlinkSync(canonical);
    }
  }
}

describe("private-pilot.sh", () => {
  it("prints SET/MISSING only and does not start without --confirm", () => {
    withCanonical(present, () => {
      const r = run(["up"], canonical);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /presence complete/);
      assert.equal(r.stdout.includes(secret), false);
      assert.equal(r.stdout.includes("ts.example.invalid"), false);
    });
  });

  it("refuses the disposable lab host, a tag-only image, and a missing SHA", () => {
    withCanonical(present.replace("ts.example.invalid", "d1-ts6-lab"), () => {
      assert.equal(run(["check"], canonical).status, 2);
    });
    withCanonical(present, () => {
      const t = run(["check"], canonical, { D1_BRIDGE_IMAGE: "ghcr.io/uniskela/ts6-manager/discord-bridge:latest" });
      assert.equal(t.status, 2);
      const missing = run(["check"], canonical, { SOURCE_COMMIT: "" });
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /SOURCE_COMMIT/);
    });
  });

  it("refuses a custom env file that is not lab/.env.pilot", () => {
    withCanonical(present, () => {
      const other = writeEnv(present);
      const r = run(["check"], other);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /same file as lab\/\.env\.pilot/);
    });
  });

  it("compose file has no ports, no restart loop, and does not manage TeamSpeak", () => {
    const src = readFileSync(compose, "utf8");
    const sh = readFileSync(script, "utf8");
    assert.match(src, /name: d1-private-pilot/);
    assert.match(src, /restart: "no"/);
    assert.match(src, /@sha256:/);
    assert.equal(/\n\s+ports:/.test(src), false);
    assert.equal(src.includes("0.0.0.0"), false);
    assert.equal(src.includes("d1-ts6-lab"), false);
    assert.equal(src.includes("unless-stopped"), false);
    assert.match(sh, /TeamSpeak is not touched|not modified|not touched/);
    assert.match(sh, /same file as lab\/\.env\.pilot/);
    assert.match(sh, /org.opencontainers.image.revision/);
    assert.equal(sh.includes("docker push"), false);
  });
});
