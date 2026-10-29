import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallbackErrors } from "./callback-errors.js";
import { registerSecret } from "./redact.js";

describe("callback failures are counted in full and logged a bounded number of times", () => {
  it("a million failures at one site write the first five lines and then one per power of two", () => {
    const lines: string[] = [];
    const errors = new CallbackErrors((l) => lines.push(l));
    const failure = new Error("same failure");
    for (let i = 0; i < 1_000_000; i++) errors.note("tick: Discord to TeamSpeak mix", failure);
    assert.equal(errors.count("tick: Discord to TeamSpeak mix"), 1_000_000);
    assert.equal(errors.total, 1_000_000);
    // 1..5, then 8, 16, ..., 2^19 = 524 288.
    assert.equal(lines.length, 5 + 17, `lines written: ${lines.length}`);
    assert.match(lines.at(-1)!, /\(524288 so far there, 524288 in all\)/);
  });

  it("counts each site separately, so a noisy site does not hide the first failures of another", () => {
    const lines: string[] = [];
    const errors = new CallbackErrors((l) => lines.push(l));
    for (let i = 0; i < 1000; i++) errors.note("tick: TeamSpeak to Discord overflow", new Error("noisy"));
    errors.note("discord opus", new Error("first opus failure"));
    assert.equal(errors.count("discord opus"), 1);
    assert.equal(errors.count("tick: TeamSpeak to Discord overflow"), 1000);
    assert.equal(errors.total, 1001);
    assert.ok(lines.at(-1)!.includes("first opus failure"), "the other site's first failure is logged at once");
  });

  it("logs the error's name and message only, redacted, never a stack", () => {
    const lines: string[] = [];
    const errors = new CallbackErrors((l) => lines.push(l));
    registerSecret("super-secret-token-value");
    errors.note("teamspeak voice", new TypeError("bad packet from super-secret-token-value"));
    errors.note("teamspeak voice", "a thrown string");
    assert.equal(lines[0], "teamspeak voice callback failed (1 so far there, 1 in all): TypeError: bad packet from [REDACTED]");
    assert.equal(lines[1], "teamspeak voice callback failed (2 so far there, 2 in all): a thrown string");
    assert.ok(lines.every((l) => !l.includes("    at ")));
  });
});
