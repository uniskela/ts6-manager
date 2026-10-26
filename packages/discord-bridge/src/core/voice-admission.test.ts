import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceAdmission } from "./voice-admission.js";

/** A source channel, a gateway voice-state map and an identity table the test edits directly. */
function admission(o: { humans?: string[]; excluded?: string[] } = {}) {
  const channel = new Map<string, string | null>();
  const humans = new Set(o.humans ?? []);
  const asked: string[] = [];
  const revoked: string[] = [];
  const a = new VoiceAdmission({
    channelId: "source",
    channelOf: (u) => channel.get(u),
    isHuman: (u) => {
      asked.push(u);
      return humans.has(u);
    },
    excluded: (u) => (o.excluded ?? []).includes(u),
    onRevoked: (u) => revoked.push(u),
  });
  return { a, channel, humans, asked, revoked };
}

describe("VoiceAdmission: identity, membership and continuity are all required", () => {
  it("admits a verified human only while the gateway puts them in the source channel, and checks membership before identity", () => {
    const { a, channel, asked } = admission({ humans: ["h"] });
    assert.equal(a.admit("h"), null, "no voice state: not admitted");
    channel.set("h", "elsewhere");
    assert.equal(a.admit("h"), null, "in another channel: not admitted");
    assert.deepEqual(asked, [], "identity is not even asked about for someone who is not present");
    channel.set("h", "source");
    const granted = a.admit("h");
    assert.ok(granted);
    assert.equal(a.admit("h"), granted, "the same admission while it lasts");
    assert.equal(a.valid(granted), true);
  });

  it("a present user who is not a verified human, or is one of the bridge's own identities, is not admitted", () => {
    const { a, channel, humans } = admission({ humans: ["mine"], excluded: ["mine"] });
    channel.set("unknown", "source");
    channel.set("mine", "source");
    assert.equal(a.admit("unknown"), null);
    assert.equal(a.admit("mine"), null);
    humans.add("unknown");
    assert.ok(a.admit("unknown"), "admitted once identity is verified");
  });

  it("revoke ends an admission for good; a return is a new admission and the old one never becomes valid again", () => {
    const { a, channel, revoked } = admission({ humans: ["h"] });
    channel.set("h", "source");
    const first = a.admit("h")!;
    a.revoke("h");
    assert.deepEqual(revoked, ["h"]);
    assert.equal(a.valid(first), false, "revoked although the voice state still says present (a leave and rejoin between two checks)");
    const second = a.admit("h")!;
    assert.notEqual(second, first);
    assert.ok(second.id > first.id);
    assert.equal(a.valid(first), false);
    assert.equal(a.valid(second), true);
    a.revoke("h");
    a.revoke("h");
    assert.deepEqual(revoked, ["h", "h"], "revoking someone without an admission notifies nobody");
  });

  it("a validity check that finds the user gone revokes the admission, so it stays dead if they come back", () => {
    const { a, channel, revoked } = admission({ humans: ["h"] });
    channel.set("h", "source");
    const first = a.admit("h")!;
    channel.set("h", null);
    assert.equal(a.valid(first), false);
    assert.deepEqual(revoked, ["h"]);
    channel.set("h", "source");
    assert.equal(a.valid(first), false, "not restored by the user coming back");
    assert.notEqual(a.admit("h"), first);
  });

  it("close ends every admission and admits nobody afterwards", () => {
    const { a, channel } = admission({ humans: ["h", "g"] });
    channel.set("h", "source");
    channel.set("g", "source");
    const h = a.admit("h")!;
    const g = a.admit("g")!;
    a.close();
    assert.equal(a.valid(h), false);
    assert.equal(a.valid(g), false);
    assert.equal(a.admit("h"), null);
    assert.equal(a.size, 0);
    assert.equal(a.isClosed, true);
    assert.equal(a.valid(undefined), false, "and nothing without an admission is ever valid");
  });
});
