import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  effectiveAnimationIntervalMs,
  MIN_ANIMATION_INTERVAL_MS,
  MIN_GLOBAL_CHANNEL_EDIT_GAP_MS,
  shouldBackoffAnimationError,
  shouldQuietSkipAnimationError,
} from './animation-manager.js';

describe('shouldBackoffAnimationError', () => {
  it('backs off invalid WebQuery API keys', () => {
    assert.equal(shouldBackoffAnimationError('invalid apikey'), true);
    assert.equal(shouldBackoffAnimationError('Invalid API key'), true);
  });

  it('keeps backing off transient connection failures and flood responses', () => {
    assert.equal(shouldBackoffAnimationError('socket hang up'), true);
    assert.equal(shouldBackoffAnimationError('ECONNRESET'), true);
    assert.equal(shouldBackoffAnimationError('TeamSpeak flood protection is active'), true);
    assert.equal(shouldBackoffAnimationError('TeamSpeak Query is still starting'), true);
    assert.equal(shouldBackoffAnimationError('Connection lost before handshake'), true);
    assert.equal(shouldBackoffAnimationError('The EventBridge SSH session is temporarily disconnected'), true);
  });

  it('does not back off unrelated action errors', () => {
    assert.equal(shouldBackoffAnimationError('channel name is invalid'), false);
  });
});

describe('shouldQuietSkipAnimationError', () => {
  it('quiets reconnect/flood storms that would otherwise spam logs', () => {
    assert.equal(shouldQuietSkipAnimationError('TeamSpeak Query is still starting'), true);
    assert.equal(shouldQuietSkipAnimationError('ECONNRESET'), true);
    assert.equal(shouldQuietSkipAnimationError('channel name is invalid'), false);
  });
});

describe('effectiveAnimationIntervalMs', () => {
  it('clamps cosmetic channel renames to a Query-safe floor', () => {
    assert.equal(effectiveAnimationIntervalMs(0.25), MIN_ANIMATION_INTERVAL_MS);
    assert.equal(effectiveAnimationIntervalMs(3), MIN_ANIMATION_INTERVAL_MS);
    assert.equal(effectiveAnimationIntervalMs(5), MIN_ANIMATION_INTERVAL_MS);
    assert.equal(MIN_ANIMATION_INTERVAL_MS, 10_000);
  });

  it('honours slower configured intervals', () => {
    assert.equal(effectiveAnimationIntervalMs(15), 15_000);
    assert.equal(effectiveAnimationIntervalMs(30), 30_000);
  });

  it('falls back to the floor for invalid intervals', () => {
    assert.equal(effectiveAnimationIntervalMs(Number.NaN), MIN_ANIMATION_INTERVAL_MS);
    assert.equal(effectiveAnimationIntervalMs(-1), MIN_ANIMATION_INTERVAL_MS);
  });

  it('keeps a shared gap between concurrent animation frames', () => {
    assert.ok(MIN_GLOBAL_CHANNEL_EDIT_GAP_MS >= 2_000);
    assert.ok(MIN_GLOBAL_CHANNEL_EDIT_GAP_MS < MIN_ANIMATION_INTERVAL_MS);
  });
});
