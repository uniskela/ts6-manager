import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconnectAttemptBusy, type ReconnectAttemptState } from './reconnect-state.js';

function state(overrides: Partial<ReconnectAttemptState> = {}): ReconnectAttemptState {
  return {
    attempts: 0,
    timer: null,
    inFlight: false,
    ...overrides,
  };
}

describe('reconnectAttemptBusy', () => {
  it('is idle when there is no timer and no attempt in flight', () => {
    assert.equal(reconnectAttemptBusy(state()), false);
  });

  it('is busy while a retry timer is pending', () => {
    assert.equal(reconnectAttemptBusy(state({ timer: setTimeout(() => {}, 60_000) })), true);
  });

  it('is busy while a reconnect attempt is already in flight', () => {
    assert.equal(reconnectAttemptBusy(state({ inFlight: true })), true);
  });
});
