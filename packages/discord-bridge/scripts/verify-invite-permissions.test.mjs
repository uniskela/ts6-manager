import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-invite-permissions.mjs", import.meta.url));

describe("verify-invite-permissions.mjs", () => {
  it("accepts mask 103810048 and rejects the previous Administrator-including integer", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /103810048/);
    assert.match(r.stdout, /does not include Administrator/);
    assert.match(r.stdout, /103809148 is not the approved mask/);
  });
});
