import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldBackoffAnimationError } from './animation-manager.js';

describe('shouldBackoffAnimationError', () => {
  it('backs off invalid WebQuery API keys', () => {
    assert.equal(shouldBackoffAnimationError('invalid apikey'), true);
    assert.equal(shouldBackoffAnimationError('Invalid API key'), true);
  });

  it('keeps backing off transient connection failures', () => {
    assert.equal(shouldBackoffAnimationError('socket hang up'), true);
    assert.equal(shouldBackoffAnimationError('ECONNRESET'), true);
  });

  it('does not back off unrelated action errors', () => {
    assert.equal(shouldBackoffAnimationError('channel name is invalid'), false);
  });
});
