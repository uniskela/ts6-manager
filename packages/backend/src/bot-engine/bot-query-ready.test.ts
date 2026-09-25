import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
});
