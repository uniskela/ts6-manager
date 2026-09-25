import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAnimationFallbackToHoldInput,
  canArmBotsForPair,
  evaluateBotQueryReady,
} from './bot-query-ready.js';
import {
  ChannelEditPacer,
  MIN_GLOBAL_CHANNEL_EDIT_GAP_MS,
} from './channel-edit-pacer.js';

describe('evaluateBotQueryReady', () => {
  it('is ready when SSH is not expected (WebQuery-only)', () => {
    const r = evaluateBotQueryReady({
      isRegistered: false,
      isConnected: false,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: false,
    });
    assert.equal(r.ready, true);
    assert.equal(r.holdMs, 0);
  });

  it('holds while connected but events not yet registered (boot race)', () => {
    const r = evaluateBotQueryReady({
      isRegistered: false,
      isConnected: true,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    });
    assert.equal(r.ready, false);
    assert.ok(r.holdMs > 0);
  });

  it('is ready after EventBridge registration', () => {
    const r = evaluateBotQueryReady({
      isRegistered: true,
      isConnected: true,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    });
    assert.equal(r.ready, true);
    assert.equal(r.holdMs, 0);
  });

  it('holds for SSH flood/reconnect pause even when registered', () => {
    const r = evaluateBotQueryReady({
      isRegistered: true,
      isConnected: false,
      sshReconnectPauseMs: 45_000,
      expectsSshRegistration: true,
    });
    assert.equal(r.ready, false);
    assert.equal(r.holdMs, 45_000);
  });

  it('holds while reconnecting after disconnect', () => {
    const r = evaluateBotQueryReady({
      isRegistered: false,
      isConnected: false,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    });
    assert.equal(r.ready, false);
    assert.ok(r.holdMs >= 5_000);
  });
});

describe('applyAnimationFallbackToHoldInput', () => {
  it('preserves registration hold while SSH is connected and registerEvents pending', () => {
    const input = {
      isRegistered: false,
      isConnected: true,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    };
    const holdInput = applyAnimationFallbackToHoldInput(input, true);
    assert.equal(holdInput.expectsSshRegistration, true);
    const r = evaluateBotQueryReady(holdInput);
    assert.equal(r.ready, false);
    assert.ok(r.holdMs > 0);
  });

  it('relaxes expectation when SSH is down after animation fallback', () => {
    const input = {
      isRegistered: false,
      isConnected: false,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    };
    const holdInput = applyAnimationFallbackToHoldInput(input, true);
    assert.equal(holdInput.expectsSshRegistration, false);
    const r = evaluateBotQueryReady(holdInput);
    assert.equal(r.ready, true);
    assert.equal(r.holdMs, 0);
  });

  it('is a no-op when animation fallback is inactive', () => {
    const input = {
      isRegistered: false,
      isConnected: false,
      sshReconnectPauseMs: 0,
      expectsSshRegistration: true,
    };
    assert.equal(applyAnimationFallbackToHoldInput(input, false), input);
  });
});

describe('canArmBotsForPair', () => {
  it('arms immediately when SSH is not expected', () => {
    assert.equal(
      canArmBotsForPair({
        isRegistered: false,
        isConnected: false,
        sshReconnectPauseMs: 0,
        expectsSshRegistration: false,
      }),
      true,
    );
  });

  it('waits for registration when SSH is expected', () => {
    assert.equal(
      canArmBotsForPair({
        isRegistered: false,
        isConnected: true,
        sshReconnectPauseMs: 0,
        expectsSshRegistration: true,
      }),
      false,
    );
    assert.equal(
      canArmBotsForPair({
        isRegistered: true,
        isConnected: true,
        sshReconnectPauseMs: 0,
        expectsSshRegistration: true,
      }),
      true,
    );
  });
});

describe('ChannelEditPacer', () => {
  it('enforces a shared gap across Animation and FlowRunner callers', () => {
    const pacer = new ChannelEditPacer();
    pacer.mark(1_000);
    assert.equal(pacer.remainingMs(1_000), MIN_GLOBAL_CHANNEL_EDIT_GAP_MS);
    assert.equal(pacer.remainingMs(1_000 + 1_500), MIN_GLOBAL_CHANNEL_EDIT_GAP_MS - 1_500);
    assert.equal(pacer.remainingMs(1_000 + MIN_GLOBAL_CHANNEL_EDIT_GAP_MS), 0);

    // Second consumer sees the same global slot.
    pacer.mark(5_000);
    assert.equal(pacer.remainingMs(5_500), MIN_GLOBAL_CHANNEL_EDIT_GAP_MS - 500);
  });

  it('rechecks the reservation after sleep when a concurrent mark() moved it', async () => {
    const pacer = new ChannelEditPacer();
    pacer.mark(Date.now());

    const waiter = pacer.waitAndMark();
    // Mid-wait, AnimationManager-style direct mark() moves the shared slot.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    pacer.mark(Date.now());

    const started = Date.now();
    await waiter;
    const elapsed = Date.now() - started;
    // Must wait nearly a full gap after the mid-flight mark, not the original short rem.
    assert.ok(
      elapsed >= MIN_GLOBAL_CHANNEL_EDIT_GAP_MS - 100,
      `expected ~${MIN_GLOBAL_CHANNEL_EDIT_GAP_MS}ms after mid-flight mark, got ${elapsed}ms`,
    );
    // Fresh mark() at the end of waitAndMark — slot is reserved again.
    assert.ok(pacer.remainingMs() > MIN_GLOBAL_CHANNEL_EDIT_GAP_MS - 200);
  });
});
