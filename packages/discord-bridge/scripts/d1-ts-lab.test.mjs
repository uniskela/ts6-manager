import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./d1-ts-lab.sh", import.meta.url));

describe("d1-ts-lab.sh", () => {
  it("documents isolated names and refuses an unknown command", () => {
    const src = readFileSync(script, "utf8");
    assert.match(src, /d1-ts6-lab/);
    assert.match(src, /d1-ts-lab/);
    assert.match(src, /d1-ts6-lab-data/);
    assert.match(src, /127\.0\.0\.1/);
    assert.match(src, /19987/);
    assert.equal(src.includes("network create --internal"), false);
    assert.equal(/\s-p\s+0\.0\.0\.0/.test(src), false);
    const r = spawnSync("bash", [script, "nope"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /start\|stop\|status\|handshake/);
  });
});
