import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AudioPlayerStatus, NetworkingStatusCode, VoiceConnectionStatus } from "@discordjs/voice";
import { preferredOrder, type BotId } from "../core/ids.js";
import { ReceiverElection } from "../core/receiver-election.js";
import { createLogger } from "../core/redact.js";
import { isSilence, makeReady, testBot, waitFor } from "../testing/fake-voice.js";
import type { OutboundTelemetry } from "../core/outbound-telemetry.js";

const opus = Buffer.from([0xfc, 42, 43, 44]);
const silence = Buffer.from([0xf8, 0xff, 0xfe]);

function botFor(ctx: TestContext, id: BotId = "slot-0", options: Parameters<typeof testBot>[2] = {}) {
  const t = testBot(id, new ReceiverElection(preferredOrder(5)), { timing: { watchdogMs: 5000 }, ...options });
  ctx.after(() => t.bot.destroy());
  return t;
}

function assertConserved(s: OutboundTelemetry): void {
  assert.ok(s.sentAudio <= s.preparedAudio);
  assert.ok(s.sentSilence <= s.preparedSilence);
  assert.equal(
    s.preparedAudio + s.preparedSilence,
    s.sentAudio + s.sentSilence + s.dispatchFenced + s.dispatchUnconfirmed + s.abandoned + s.pending,
  );
}

it("measures offers, real player reads, guarded audio and actual player silence padding", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  for (let i = 0; i < 3; i++) t.bot.sendOpus(opus);
  assert.equal(t.bot.framesSent, 3);
  assert.equal(t.bot.outboundTelemetry.consumed, 0);
  t.bot.endSpeech();
  await waitFor(() => t.bot.playerStatus === AudioPlayerStatus.Idle, 1500, "player padding completed");
  const s = t.bot.outboundTelemetry;
  assert.equal(s.consumed, 3, "a finished feed still drains without changing the offer total");
  assert.equal(t.bot.framesSent, 3);
  assert.equal(s.preparedAudio, 3);
  assert.equal(s.sentAudio, h.networking.wire.filter((packet) => !isSilence(packet)).length);
  assert.equal(s.sentAudio, 3);
  assert.equal(s.preparedSilence, 5);
  assert.equal(s.sentSilence, h.networking.wire.filter(isSilence).length);
  assert.equal(s.sentSilence, 4);
  assert.equal(s.pending, 1, "the final silence stays prepared when the player becomes idle");
  assertConserved(s);
});

it("attributes a packet fenced by an epoch change once without sending it", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  assert.ok(h.conn.prepareAudioPacket(opus));
  h.reinitDave();
  assert.equal(h.conn.dispatchAudio(), false);
  assert.equal(h.conn.dispatchAudio(), false);
  assert.equal(h.networking.wire.length, 0);
  assert.equal(t.bot.outboundTelemetry.dispatchFenced, 1);
  assert.equal(t.bot.outboundTelemetry.sentAudio, 0);
  assert.equal(t.bot.outboundTelemetry.pending, 0);
  t.bot.leave();
  assert.equal(t.bot.outboundTelemetry.abandoned, 0);
  assertConserved(t.bot.outboundTelemetry);
});

it("counts guarded refusals without emitting plaintext before DAVE is ready or at protocol zero", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  h.setDave({ ready: false });
  assert.equal(h.conn.prepareAudioPacket(opus), undefined);
  assert.equal(h.conn.dispatchAudio(), false);
  h.setDave({ protocolVersion: 0, ready: true });
  assert.equal(h.conn.prepareAudioPacket(silence), undefined);
  assert.equal(h.conn.dispatchAudio(), false);
  const s = t.bot.outboundTelemetry;
  assert.equal(s.prepareRefusedAudio, 1);
  assert.equal(s.prepareRefusedSilence, 1);
  assert.equal(s.dispatchFenced, 0);
  assert.equal(h.networking.wire.length, 0);
  assertConserved(s);
});

it("preserves inner arguments, return values and exceptions with one call per operation", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  const packet = Buffer.from([1]);
  const failure = new Error("synthetic voice failure");
  const prepare = ctx.mock.method(h.networking, "prepareAudioPacket", () => packet);
  const dispatch = ctx.mock.method(h.networking, "dispatchAudio", () => true);
  assert.equal(h.conn.prepareAudioPacket(opus), packet);
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(prepare.mock.calls[0].arguments[0], opus);
  assert.equal(prepare.mock.calls[0].this, h.networking);
  assert.equal(h.conn.dispatchAudio(), true);
  assert.equal(dispatch.mock.callCount(), 1);
  assert.deepEqual(dispatch.mock.calls[0].arguments, []);
  assert.equal(dispatch.mock.calls[0].this, h.networking);

  prepare.mock.mockImplementation(() => undefined as never);
  assert.equal(h.conn.prepareAudioPacket(opus), undefined);
  assert.equal(prepare.mock.callCount(), 2);
  prepare.mock.mockImplementation(() => { throw failure; });
  assert.throws(() => h.conn.prepareAudioPacket(opus), (error) => error === failure);
  assert.equal(prepare.mock.callCount(), 3);

  prepare.mock.mockImplementation(() => packet);
  assert.equal(h.conn.prepareAudioPacket(silence), packet);
  dispatch.mock.mockImplementation(() => false);
  assert.equal(h.conn.dispatchAudio(), false);
  assert.equal(dispatch.mock.callCount(), 2);
  assert.equal(t.bot.outboundTelemetry.dispatchFenced, 1);

  assert.equal(h.conn.prepareAudioPacket(opus), packet);
  dispatch.mock.mockImplementation(() => { throw failure; });
  assert.throws(() => h.conn.dispatchAudio(), (error) => error === failure);
  assert.equal(dispatch.mock.callCount(), 3);
  assert.equal(h.conn.dispatchAudio(), false, "the original guard still consumes its epoch");
  assert.equal(dispatch.mock.callCount(), 3);

  assert.equal(h.conn.prepareAudioPacket(opus), packet);
  dispatch.mock.mockImplementation(() => undefined as never);
  assert.equal(h.conn.dispatchAudio(), undefined);
  assert.equal(dispatch.mock.callCount(), 4);
  assert.equal(t.bot.outboundTelemetry.dispatchUnconfirmed, 2);
  assert.equal(t.bot.outboundTelemetry.sentAudio, 1);
  assertConserved(t.bot.outboundTelemetry);
});

it("counts exactly three abandonments for three real prepare-then-leave cycles", async (ctx) => {
  const t = botFor(ctx);
  for (let n = 1; n <= 3; n++) {
    const h = await t.join();
    const prepare = h.networking.prepareAudioPacket.bind(h.networking);
    let observed!: () => void;
    const prepared = new Promise<void>((resolve) => { observed = resolve; });
    ctx.mock.method(h.networking, "prepareAudioPacket", (frame: Buffer) => {
      const packet = prepare(frame);
      observed();
      return packet;
    });
    t.bot.sendOpus(opus);
    await prepared;
    assert.equal(t.bot.outboundTelemetry.pending, 1);
    assertConserved(t.bot.outboundTelemetry);
    t.bot.leave();
    assert.equal(h.conn.state.status, VoiceConnectionStatus.Destroyed);
    assert.equal(t.bot.playerStatus, AudioPlayerStatus.Idle);
    assert.equal(h.networking.wire.length, 0);
    assert.equal(t.bot.outboundTelemetry.abandoned, n);
    assert.equal(t.bot.outboundTelemetry.pending, 0);
    assert.equal(h.conn.dispatchAudio(), false);
    assertConserved(t.bot.outboundTelemetry);
  }
  assert.equal(t.bot.framesSent, 3);
  const s = t.bot.outboundTelemetry;
  assert.equal(s.consumed, 3);
  assert.equal(s.preparedAudio, 3);
  assert.equal(s.sentAudio, 0);
  assert.equal(s.dispatchFenced, 0);
  assert.equal(s.abandoned, 3);
  await t.bot.destroy();
  assert.deepEqual(t.bot.outboundTelemetry, s);
});

it("preserves totals across rejoin, recovery and teardown after a successful dispatch", async (ctx) => {
  const t = botFor(ctx, "slot-0", { now: () => 100 });
  const h = await t.join();
  assert.ok(h.conn.prepareAudioPacket(opus));
  assert.equal(h.conn.dispatchAudio(), true);
  assert.equal((await t.join()).conn, h.conn);
  assert.equal(t.bot.outboundTelemetry.sentAudio, 1);
  assert.equal(t.bot.outboundTelemetry.abandoned, 0);

  assert.ok(h.conn.prepareAudioPacket(opus));
  t.bot.markUnhealthy("synthetic transport loss", { fresh: true });
  assert.equal(t.bot.outboundTelemetry.abandoned, 1);
  const next = await t.join();
  assert.notEqual(next.conn, h.conn);
  assert.equal(next.conn.dispatchAudio(), false);
  assert.equal(h.conn.dispatchAudio(), false);
  assert.equal(t.bot.outboundTelemetry.pending, 0);
  h.conn.emit("error", new Error("synthetic disconnected voice event"));
  assert.equal(t.bot.outboundTelemetry.connectionErrors, 1);

  assert.ok(next.conn.prepareAudioPacket(opus));
  next.replaceDave();
  assert.equal(next.conn.dispatchAudio(), false);
  t.bot.leave();
  assert.equal(t.bot.outboundTelemetry.sentAudio, 1);
  assert.equal(t.bot.outboundTelemetry.abandoned, 1);
  assert.equal(t.bot.outboundTelemetry.dispatchFenced, 1);
  assertConserved(t.bot.outboundTelemetry);
  const replacementBot = botFor(ctx);
  assert.equal(replacementBot.bot.outboundTelemetry.preparedAudio, 0);
  assert.equal(replacementBot.bot.outboundTelemetry.lastAudioSentAgeMs, null);
});

it("distinguishes same-transport resume from replacement and permanent invalidation", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  const ready = h.conn.state;
  assert.equal(ready.status, VoiceConnectionStatus.Ready);
  assert.ok(h.conn.prepareAudioPacket(opus));
  h.conn.state = { ...ready, status: VoiceConnectionStatus.Connecting };
  assert.equal(t.bot.outboundTelemetry.pending, 1);
  h.conn.state = ready;
  assert.equal(h.conn.dispatchAudio(), true);

  assert.ok(h.conn.prepareAudioPacket(opus));
  const newTransport = makeReady(h.conn);
  assert.equal(h.networking.destroyed, true);
  assert.equal(t.bot.outboundTelemetry.abandoned, 1);
  assert.equal(t.bot.outboundTelemetry.pending, 0);
  assert.equal(h.conn.dispatchAudio(), false);

  assert.ok(h.conn.prepareAudioPacket(opus));
  const replacementReady = h.conn.state;
  newTransport.networking.state.code = NetworkingStatusCode.Closed;
  h.conn.state = { ...replacementReady, status: VoiceConnectionStatus.Connecting };
  assert.equal(t.bot.outboundTelemetry.abandoned, 2);
  assert.equal(t.bot.outboundTelemetry.pending, 0);
  assertConserved(t.bot.outboundTelemetry);
});

it("settles a replaced preparation and a preparation invalidated by a refused prepare", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  assert.ok(h.conn.prepareAudioPacket(opus));
  assert.ok(h.conn.prepareAudioPacket(silence));
  assert.equal(t.bot.outboundTelemetry.abandoned, 1);
  assert.equal(h.conn.dispatchAudio(), true);
  assert.equal(t.bot.outboundTelemetry.sentSilence, 1);
  assert.equal(t.bot.outboundTelemetry.sentAudio, 0);

  assert.ok(h.conn.prepareAudioPacket(opus));
  h.setDave({ ready: false });
  assert.equal(h.conn.prepareAudioPacket(opus), undefined);
  assert.equal(h.conn.dispatchAudio(), false);
  assert.equal(t.bot.outboundTelemetry.abandoned, 2);
  assert.equal(t.bot.outboundTelemetry.dispatchFenced, 0);
  assert.equal(t.bot.outboundTelemetry.pending, 0);
  assertConserved(t.bot.outboundTelemetry);
});

it("consumes real feed frames without preparing when no connection is playable", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  t.bot.sendOpus(opus);
  const ready = h.conn.state;
  assert.equal(ready.status, VoiceConnectionStatus.Ready);
  h.conn.state = { ...ready, status: VoiceConnectionStatus.Connecting };
  await waitFor(() => t.bot.outboundTelemetry.consumed === 1, 1500, "player reads without playable subscribers");
  const s = t.bot.outboundTelemetry;
  assert.equal(s.preparedAudio, 0);
  assert.equal(s.preparedSilence, 0);
  assert.equal(s.prepareRefusedAudio, 0);
  assert.equal(t.bot.framesSent, 1);
  assert.equal(h.networking.wire.length, 0);
  assertConserved(s);
});

it("uses the injected clock for audio age and keeps two bot slots isolated", async (ctx) => {
  let now = 1000;
  const a = botFor(ctx, "slot-0", { now: () => now });
  const b = botFor(ctx, "slot-1", { now: () => now });
  const [one, two] = await Promise.all([a.join(), b.join()]);
  assert.equal(a.bot.outboundTelemetry.lastAudioSentAgeMs, null);
  assert.ok(one.conn.prepareAudioPacket(opus));
  assert.ok(two.conn.prepareAudioPacket(silence));
  assert.equal(one.conn.dispatchAudio(), true);
  assert.equal(two.conn.dispatchAudio(), true);
  now += 19;
  assert.equal(a.bot.outboundTelemetry.lastAudioSentAgeMs, 19);
  assert.equal(a.bot.outboundTelemetry.sentAudio, 1);
  assert.equal(a.bot.outboundTelemetry.sentSilence, 0);
  assert.equal(b.bot.outboundTelemetry.lastAudioSentAgeMs, null);
  assert.equal(b.bot.outboundTelemetry.sentAudio, 0);
  assert.equal(b.bot.outboundTelemetry.sentSilence, 1);
  assertConserved(a.bot.outboundTelemetry);
  assertConserved(b.bot.outboundTelemetry);
});

it("adds no per-packet log lines across 500 guarded sends", async (ctx) => {
  let logs = 0;
  const t = botFor(ctx, "slot-0", { log: createLogger("test", () => { logs++; }) });
  const h = await t.join();
  const before = logs;
  for (let n = 0; n < 500; n++) {
    h.conn.prepareAudioPacket(opus);
    h.conn.dispatchAudio();
  }
  assert.equal(t.bot.outboundTelemetry.sentAudio, 500);
  assert.equal(logs, before);
  assertConserved(t.bot.outboundTelemetry);
});

it("keeps a fixed frozen numeric snapshot after 10000 packets", async (ctx) => {
  const t = botFor(ctx);
  const h = await t.join();
  const first = t.bot.outboundTelemetry;
  for (let n = 0; n < 10_000; n++) {
    h.conn.prepareAudioPacket(opus);
    h.conn.dispatchAudio();
    h.networking.wire.length = 0;
  }
  const last = t.bot.outboundTelemetry;
  assert.equal(last.sentAudio, 10_000);
  assert.equal(first.sentAudio, 0);
  assert.ok(Object.isFrozen(last));
  assert.equal(Object.getPrototypeOf(last), Object.prototype);
  assert.deepEqual(Object.keys(first), Object.keys(last));
  assert.ok(Object.values(last).every((value) => value === null || Number.isFinite(value)));
  assertConserved(last);
});
