import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldReconnectAfterSshClose } from './ssh-query-client.js';

describe('shouldReconnectAfterSshClose', () => {
  it('retries a non-fatal close before the SSH handshake completes', () => {
    assert.equal(shouldReconnectAfterSshClose(false, false), true);
  });

  it('does not retry after an explicit destroy', () => {
    assert.equal(shouldReconnectAfterSshClose(true, false), false);
  });

  it('does not retry fatal authentication or host-key failures', () => {
    assert.equal(shouldReconnectAfterSshClose(false, true), false);
  });
});
