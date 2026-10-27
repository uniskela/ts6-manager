import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labDaveDiagnostic, loadLabConfig, presenceReport } from "./config.js";

const full = {
  D1_DISCORD_TOKEN_SLOT_0: "aaaaaaaa-0", D1_DISCORD_TOKEN_SLOT_1: "aaaaaaaa-1", D1_DISCORD_TOKEN_SLOT_2: "aaaaaaaa-2",
  D1_DISCORD_TOKEN_SLOT_3: "aaaaaaaa-3", D1_DISCORD_TOKEN_SLOT_4: "aaaaaaaa-4", D1_DISCORD_TOKEN_OVERFLOW: "aaaaaaaa-5",
  D1_DISCORD_GUILD_ID: "1", D1_DISCORD_CHANNEL_ID: "2", D1_TS_HOST: "127.0.0.1",
};

describe("lab config", () => {
  it("reports missing requirements by name and never returns a value", () => {
    const r = loadLabConfig({});
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.missing.includes("D1_DISCORD_TOKEN_OVERFLOW") && r.missing.length === 9);
    const rep = presenceReport({ D1_TS_HOST: "secret-looking-host" });
    assert.equal(rep.D1_TS_HOST, "SET");
    assert.ok(!JSON.stringify(rep).includes("secret-looking-host"));
  });
  it("requires six distinct tokens", () => {
    const r = loadLabConfig({ ...full, D1_DISCORD_TOKEN_SLOT_1: full.D1_DISCORD_TOKEN_SLOT_0 });
    assert.equal(r.ok, false);
  });
  it("accepts a complete configuration", () => {
    const r = loadLabConfig(full);
    assert.equal(r.ok, true);
  });
  it("single-attempt diagnostic is off unless D1_DAVE_SINGLE_ATTEMPT=1", () => {
    assert.deepEqual(labDaveDiagnostic({}), { singleAttempt: false });
    assert.deepEqual(labDaveDiagnostic({ D1_DAVE_SINGLE_ATTEMPT: "1" }), {
      singleAttempt: true,
      timing: { maxRecoveries: 0 },
      retry: { maxAttempts: 1 },
    });
  });
});
