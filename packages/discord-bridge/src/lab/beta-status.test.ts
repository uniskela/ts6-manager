import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EVENT_CAP,
  buildBetaStatus,
  deriveHealth,
  diffEvents,
  pushEvent,
  writeAtomicJson,
  type BetaEvent,
  type BetaSnapshotIn,
} from "./beta-status.js";

const running: BetaSnapshotIn = {
  state: "running",
  receiver: "slot-0",
  generation: 1,
  scheduledReconnects: 0,
  duplicateReceivers: [],
  dave: { "slot-0": { protocolVersion: 1, ready: true } },
  decryptErrors: { "slot-0": 0 },
  daveReplacements: { "slot-0": 0 },
  recoveries: { "slot-0": 0 },
  d2t: { framesSent: 12, daveDropped: 0, admissionDropped: 0, selfSourceDrops: 0 },
};

describe("private-beta status", () => {
  it("derives fail-closed when DAVE is down or a duplicate receiver appears", () => {
    assert.equal(deriveHealth(running, true), "ok");
    assert.equal(deriveHealth({ ...running, dave: { "slot-0": { protocolVersion: 1, ready: false } } }, true), "fail-closed");
    assert.equal(deriveHealth({ ...running, receiver: null }, true), "fail-closed");
    assert.equal(deriveHealth({ ...running, duplicateReceivers: ["slot-1"] }, true), "fail-closed");
    assert.equal(deriveHealth({ ...running, scheduledReconnects: 1 }, true), "degraded");
    assert.equal(deriveHealth({ ...running, state: "stopping" }, true), "fail-closed");
  });

  it("records bounded lifecycle events and never copies a secret-shaped field", () => {
    const events: BetaEvent[] = [];
    const lost = { ...running, dave: { "slot-0": { protocolVersion: 1, ready: false } } };
    const added = diffEvents(running, lost, events);
    assert.equal(added[0]?.kind, "dave_lost");
    const status = buildBetaStatus({
      sourceCommit: "abc123",
      snap: { ...lost, token: "d1-test-token-must-not-appear" } as BetaSnapshotIn,
      events,
      started: true,
      singleAttempt: true,
    });
    const text = JSON.stringify(status);
    assert.equal(status.mode, "private-beta");
    assert.equal(status.experimental, true);
    assert.equal(status.health, "fail-closed");
    assert.equal(text.includes("d1-test-token-must-not-appear"), false);
    assert.equal(text.includes("token"), false);
    for (let i = 0; i < EVENT_CAP + 5; i++) pushEvent(events, "unhealthy");
    assert.equal(events.length, EVENT_CAP);
  });

  it("writes status atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-beta-"));
    const path = join(dir, "private-beta-status.json");
    writeAtomicJson(path, { mode: "private-beta" });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).mode, "private-beta");
  });
});
