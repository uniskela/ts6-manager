import assert from "node:assert/strict";
import { it } from "node:test";
import { isOutboundSilence, outboundCounters, trackOutboundConnection, type OutboundTelemetry } from "./outbound-telemetry.js";

function assertConserved(s: Pick<OutboundTelemetry,
  "preparedAudio" | "preparedSilence" | "sentAudio" | "sentSilence" | "dispatchFenced" | "dispatchUnconfirmed" | "abandoned" | "pending">): void {
  assert.ok(s.sentAudio <= s.preparedAudio);
  assert.ok(s.sentSilence <= s.preparedSilence);
  assert.equal(
    s.preparedAudio + s.preparedSilence,
    s.sentAudio + s.sentSilence + s.dispatchFenced + s.dispatchUnconfirmed + s.abandoned + s.pending,
  );
}

it("classifies only the exact library silence frame", () => {
  assert.equal(isOutboundSilence(Buffer.from([0xf8, 0xff, 0xfe])), true);
  assert.equal(isOutboundSilence(Buffer.from([0xf8, 0xff, 0xfe, 0])), false);
  assert.equal(isOutboundSilence(Buffer.from([0xf8, 0xff])), false);
  assert.equal(isOutboundSilence(Buffer.from([0xf8, 0xff, 0xfd])), false);
});

it("conserves prepared packets across replacement, refusal and reentrant invalidation", () => {
  const totals = outboundCounters();
  const c = trackOutboundConnection(totals, () => 123);
  c.prepare(false, true, c.revision);
  assert.equal(totals.pending, 1);
  assertConserved(totals);
  c.prepare(true, true, c.revision);
  assert.equal(totals.abandoned, 1);
  assert.equal(totals.pending, 1);
  c.prepare(true, false, c.revision);
  assert.equal(totals.abandoned, 2);
  assert.equal(totals.prepareRefusedSilence, 1);
  assertConserved(totals);
  assert.equal(c.dispatch(() => false), false);
  assert.equal(totals.dispatchFenced, 0);

  c.prepare(false, true, c.revision);
  assert.equal(c.dispatch(() => {
    c.invalidate();
    assert.equal(totals.pending, 1, "the dispatch still owns this packet");
    assertConserved(totals);
    return true;
  }), true);
  assert.equal(totals.sentAudio, 1);
  assert.equal(totals.lastAudioSentAt, 123);
  const before = c.revision;
  c.invalidate();
  c.prepare(false, true, before);
  assert.equal(totals.abandoned, 3);
  assert.equal(totals.pending, 0);
  assertConserved(totals);
});
