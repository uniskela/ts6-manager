import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VideoStreamPresetKey } from '@ts6/common';
import {
  ADAPTIVE_QUALITY_TUNING,
  AdaptiveQualityController,
  type EncodeHealthSample,
} from './adaptive-quality.js';
import { PRESET_ORDER } from './types.js';

const OK: EncodeHealthSample = { speed: 1.0, belowRealtime: false, belowRealtimeSecs: 0, sampleAgeSecs: 1 };
const slow = (secs: number, speed = 0.6): EncodeHealthSample => ({
  speed,
  belowRealtime: secs >= 20,
  belowRealtimeSecs: secs,
  sampleAgeSecs: 1,
});

const POLL_MS = 10_000;
const rank = (key: VideoStreamPresetKey) => PRESET_ORDER.indexOf(key);

/**
 * A host that encodes in realtime up to `capacity()` and at 0.6x above it,
 * sampled every 10 s the way the sidecar reports it: 15 s of startup grace
 * after each ffmpeg restart, then a running below-realtime count.
 */
function simulate(
  ctl: AdaptiveQualityController,
  capacity: (nowMs: number) => VideoStreamPresetKey,
  durationMs: number,
  startMs = 0,
) {
  const changes: Array<{ at: number; to: VideoStreamPresetKey; direction: string; reason: string }> = [];
  let restartedAt = startMs;
  let belowSince: number | null = null;
  for (let now = startMs + POLL_MS; now <= startMs + durationMs; now += POLL_MS) {
    const overloaded = rank(ctl.current) > rank(capacity(now));
    if (!overloaded || now - restartedAt < 15_000) belowSince = null;
    else belowSince ??= now;
    const belowSecs = belowSince == null ? 0 : (now - belowSince) / 1000;
    const decision = ctl.observe(overloaded ? slow(belowSecs) : OK, now);
    assert.ok(rank(ctl.current) <= rank(ctl.ceiling), 'never above the ceiling');
    if (!decision) continue;
    assert.equal(Math.abs(rank(decision.to) - rank(decision.from)), 1, 'one preset per change');
    const change = ctl.commit(decision, now);
    changes.push({ at: now, to: decision.to, direction: decision.direction, reason: change.reason });
    restartedAt = now;
    belowSince = null;
  }
  return changes;
}

describe('adaptive Auto quality', () => {
  it('steps down one preset after a sustained slowdown, not a transient', () => {
    const ctl = new AdaptiveQualityController('1080p');
    assert.equal(ctl.observe(slow(10), 10_000), null);
    assert.equal(ctl.observe(slow(20), 20_000), null, 'the sidecar flag alone is not sustained enough');
    assert.equal(ctl.observe(OK, 30_000), null);
    assert.equal(ctl.observe(slow(10), 40_000), null);
    const decision = ctl.observe(slow(30, 0.62), 60_000);
    assert.deepEqual(decision, {
      direction: 'down',
      from: '1080p',
      to: '720p',
      reason: 'Encoding stayed below realtime (0.62x for 30 s) at 1080p',
    });
    assert.equal(ctl.current, '1080p', 'nothing changes until the restart is committed');
    ctl.commit(decision!, 60_000);
    assert.equal(ctl.current, '720p');
    assert.deepEqual(ctl.snapshot(), {
      ceiling: '1080p',
      changes: 1,
      lastChange: { direction: 'down', from: '1080p', to: '720p', at: 60_000, reason: decision!.reason },
    });
  });

  it('waits out the cooldown between two step-downs and stops at the lowest preset', () => {
    const ctl = new AdaptiveQualityController('1080p');
    ctl.commit(ctl.observe(slow(30), 0)!, 0);
    assert.equal(ctl.observe(slow(40), 50_000), null, 'still cooling down');
    const second = ctl.observe(slow(50), 60_000);
    assert.equal(second?.to, '480p');
    ctl.commit(second!, 60_000);
    assert.equal(ctl.observe(slow(300), 600_000), null, 'nothing below 480p');
    assert.equal(ctl.current, '480p');
  });

  it('steps back up one preset after a stable recovery window, never past the ceiling', () => {
    const ctl = new AdaptiveQualityController('1080p');
    ctl.commit(ctl.observe(slow(30), 0)!, 0);
    ctl.commit(ctl.observe(slow(30), 60_000)!, 60_000);
    assert.equal(ctl.current, '480p');

    let now = 70_000;
    for (; now < 70_000 + 110_000; now += POLL_MS) assert.equal(ctl.observe(OK, now), null);
    const up = ctl.observe(OK, 190_000);
    assert.equal(up?.direction, 'up');
    assert.equal(up?.to, '720p');
    assert.equal(up?.reason, 'Encoding held realtime for 2 minutes at 480p');
    ctl.commit(up!, 190_000);

    const changes = simulate(ctl, () => '2160p', 3_600_000);
    assert.equal(ctl.current, '1080p');
    assert.deepEqual(changes.map((c) => c.to), ['1080p'], 'one more step, then it holds at the ceiling');
  });

  it('needs a full, unbroken healthy window to step up', () => {
    const ctl = new AdaptiveQualityController('720p');
    ctl.commit(ctl.observe(slow(30), 0)!, 0);
    assert.equal(ctl.observe(OK, 60_000), null);
    assert.equal(ctl.observe(OK, 170_000), null);
    // 0.93x is neither overloaded nor healthy: it restarts the window.
    assert.equal(ctl.observe({ ...OK, speed: 0.93 }, 175_000), null);
    assert.equal(ctl.observe(OK, 180_000), null);
    assert.equal(ctl.observe(OK, 290_000), null);
    // A stale sample (ffmpeg stopped reporting) restarts it too.
    assert.equal(ctl.observe({ ...OK, sampleAgeSecs: 30 }, 295_000), null);
    assert.equal(ctl.observe(OK, 300_000), null);
    assert.equal(ctl.observe(OK, 410_000), null);
    ctl.noteRestart(); // a volume change restarted ffmpeg
    assert.equal(ctl.observe(OK, 420_000), null);
    assert.equal(ctl.observe(OK, 530_000), null);
    assert.equal(ctl.observe(OK, 540_000)?.to, '720p');
  });

  it('never changes when the encoder keeps up', () => {
    const ctl = new AdaptiveQualityController('1080p');
    assert.deepEqual(simulate(ctl, () => '1080p', 3_600_000), []);
    assert.equal(ctl.snapshot().lastChange, null);
  });

  it('backs off after each failed step up, so a weak host is not restarted in a loop', () => {
    const ctl = new AdaptiveQualityController('1080p');
    // The host can never hold 1080p.
    const changes = simulate(ctl, () => '720p', 6 * 3_600_000);
    assert.deepEqual(
      changes.map((c) => c.direction),
      changes.map((_, i) => (i % 2 === 0 ? 'down' : 'up')),
      'only ever moves between 1080p and 720p',
    );
    const ups = changes.filter((c) => c.direction === 'up');
    const downs = changes.filter((c) => c.direction === 'down');
    // Each retry waits twice as long at the reduced preset, up to the maximum.
    const { recoveryMs, maxRecoveryMs, cooldownMs } = ADAPTIVE_QUALITY_TUNING;
    ups.forEach((up, i) => {
      const wait = up.at - downs[i].at;
      const window = Math.min(recoveryMs * 2 ** i, maxRecoveryMs);
      assert.ok(wait >= window && wait <= window + 2 * POLL_MS, `retry ${i} waited ${wait} ms`);
    });
    assert.ok(ups.length >= 6 && ups.length <= 14, `${ups.length} retries in six hours`);
    for (let i = 1; i < changes.length; i++) {
      assert.ok(changes[i].at - changes[i - 1].at >= cooldownMs - POLL_MS, 'changes are spaced out');
    }
    assert.match(downs[1].reason, /at 1080p; trying 1080p again after 4 minutes of steady encoding$/);
    assert.doesNotMatch(downs[0].reason, /trying/);
  });

  it('follows a host that is busy for a while and then recovers', () => {
    const ctl = new AdaptiveQualityController('1440p');
    // Only 720p fits for the first 20 minutes, then everything does.
    const changes = simulate(ctl, (now) => (now < 1_200_000 ? '720p' : '2160p'), 2 * 3_600_000);
    assert.equal(ctl.current, '1440p', 'returns to the starting preset');
    assert.equal(Math.min(...changes.map((c) => rank(c.to))), rank('720p'));
    const after = changes.filter((c) => c.at >= 1_200_000 + 10 * 60_000);
    assert.ok(after.every((c) => c.direction === 'up'), 'only recovers once the host is free');
    assert.equal(changes[changes.length - 1].to, '1440p');
  });

  it('forgets earlier failures once a step up has held', () => {
    const ctl = new AdaptiveQualityController('1080p');
    // 1080p fails once, then the host frees up and 1080p holds for an hour.
    simulate(ctl, (now) => (now < 400_000 ? '720p' : '1080p'), 3_600_000);
    assert.equal(ctl.current, '1080p');
    // A new slowdown is treated like the first: down, then up after the base window.
    const from = 3_600_000;
    const changes = simulate(ctl, (now) => (now < from + 60_000 ? '720p' : '1080p'), 900_000, from);
    assert.deepEqual(changes.map((c) => c.direction), ['down', 'up']);
    assert.ok(changes[1].at - changes[0].at <= ADAPTIVE_QUALITY_TUNING.recoveryMs + 2 * POLL_MS);
  });

  it('waits out a cooldown after a change that could not be applied', () => {
    const ctl = new AdaptiveQualityController('1080p');
    assert.ok(ctl.observe(slow(30), 100_000));
    ctl.reject(100_000);
    assert.equal(ctl.current, '1080p');
    assert.equal(ctl.observe(slow(60), 130_000), null);
    assert.equal(ctl.observe(slow(90), 160_000)?.to, '720p');
  });

  it('has nowhere to go when Auto started at the lowest preset', () => {
    const ctl = new AdaptiveQualityController('480p');
    assert.deepEqual(simulate(ctl, () => '480p', 600_000), []);
    assert.equal(ctl.observe(slow(120), 700_000), null);
  });
});
