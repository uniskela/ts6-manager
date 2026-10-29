import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EVENT_CAP,
  buildBetaStatus,
  deriveHealth,
  diffEvents,
  healthcheckOk,
  hostHealthLabel,
  hostStatusView,
  pushEvent,
  writeAtomicJson,
  writeBetaStatusFiles,
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
  t2d: {
    received: 40,
    forwarded: 38,
    unsupportedFrames: 1,
    invalidFrames: 0,
    decodeErrors: 0,
    voiceStops: 2,
    malformed: 0,
    unknownSpeakers: 3,
    ownVoice: 1,
    excluded: 0,
    notInChannel: 0,
  },
  tsTransport: { whisperDropped: 2 },
  senders: {
    "slot-0": {
      daveReady: true,
      framesSent: 20,
      playerStatus: "playing",
      playbackDropped: 0,
      playbackStarved: 0,
      playbackHealthRejected: 0,
      playbackDaveRejected: 4,
      healthy: true,
      inChannel: true,
    },
    "slot-1": {
      daveReady: true,
      framesSent: 0,
      playerStatus: "idle",
      playbackDropped: 0,
      playbackStarved: 1,
      playbackHealthRejected: 2,
      playbackDaveRejected: 0,
      healthy: true,
      inChannel: false,
    },
  },
  voiceMembers: 3,
  voiceBots: 2,
};

describe("private-beta status", () => {
  it("exposes TeamSpeak→Discord counters and per-slot sender readiness without identities", () => {
    const status = buildBetaStatus({ sourceCommit: "abc123", snap: running, events: [], started: true, singleAttempt: true });
    const counters = status.counters as Record<string, unknown>;
    assert.equal(counters.t2dReceived, 40);
    assert.equal(counters.t2dForwarded, 38);
    assert.equal(counters.t2dUnsupportedFrames, 1);
    assert.equal(counters.t2dUnknownSpeakers, 3);
    assert.equal(counters.tsWhisperDropped, 2);
    assert.equal(status.voiceMembers, 3);
    assert.equal(status.voiceBots, 2);
    const senders = status.senders as Record<string, Record<string, unknown>>;
    assert.equal(senders["slot-1"]!.playerStatus, "idle");
    assert.equal(senders["slot-1"]!.daveReady, true);
    assert.equal(senders["slot-1"]!.playbackHealthRejected, 2);
    assert.equal(senders["slot-0"]!.playbackDaveRejected, 4);
    assert.equal(senders["slot-1"]!.inChannel, false);
    const text = JSON.stringify(status);
    assert.equal(text.includes("uid"), false);
    assert.equal(text.includes("Alice"), false);
    const host = hostStatusView(status);
    assert.equal("senders" in host, false);
    assert.equal("counters" in host, false);
    assert.equal(deriveHealth(running, true), "ok", "receiver DAVE health is independent of sender playback");
  });

  it("derives fail-closed when DAVE is down or a duplicate receiver appears", () => {
    assert.equal(deriveHealth(running, true), "ok");
    assert.equal(deriveHealth({ ...running, dave: { "slot-0": { protocolVersion: 1, ready: false } } }, true), "fail-closed");
    assert.equal(
      deriveHealth({ ...running, dave: { "slot-0": { protocolVersion: 1, ready: false } }, voiceMembers: 4, voiceBots: 4 }, true),
      "fail-closed",
      "stale occupancy integers must not park while a human may be present",
    );
    assert.equal(
      deriveHealth({ ...running, dave: { "slot-0": { protocolVersion: 1, ready: false } }, botsOnlyPark: true }, true),
      "parked",
    );
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
    const status = buildBetaStatus({ sourceCommit: "abc123", snap: running, events: [], started: true, singleAttempt: true });
    writeBetaStatusFiles(dir, status);
    const detailed = join(dir, "private-beta-status.json");
    const host = join(dir, "host-status.json");
    assert.equal(JSON.parse(readFileSync(detailed, "utf8")).mode, "private-beta");
    assert.equal((statSync(detailed).mode & 0o777).toString(8), "600");
    assert.equal((statSync(host).mode & 0o777).toString(8), "644");
    assert.equal((statSync(dir).mode & 0o777).toString(8), "755");
    const view = hostStatusView(status);
    assert.deepEqual(JSON.parse(readFileSync(host, "utf8")), view);
    assert.equal("events" in view, false);
    assert.equal("counters" in view, false);
    writeAtomicJson(join(dir, "other.json"), { mode: "private-beta" });
    assert.equal((statSync(join(dir, "other.json")).mode & 0o777).toString(8), "600");
  });

  it("healthcheck requires fresh DAVE and a receiver, and leftover files are stale when stopped", () => {
    const ok = buildBetaStatus({ sourceCommit: "x", snap: running, events: [], started: true, singleAttempt: true });
    const now = Date.parse(String(ok.at));
    assert.equal(healthcheckOk(ok, now), true);
    assert.equal(healthcheckOk({ ...ok, daveReady: false, health: "fail-closed" }, now), false);
    assert.equal(healthcheckOk({ ...ok, daveReady: false, health: "parked" }, now), true);
    assert.equal(healthcheckOk({ ...ok, receiver: null, health: "fail-closed" }, now), false);
    assert.equal(hostHealthLabel({ ...ok, health: "parked" }, true), "parked");
    assert.equal(healthcheckOk({ ...ok, state: "running" }, now + 31_000), false);
    assert.equal(hostHealthLabel(ok, true), "ok");
    assert.equal(hostHealthLabel(ok, false), "stale");
    assert.equal(hostHealthLabel(null, false), "absent");
  });
});
