import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatFatalSshFailureMessage,
  isAlreadyRegisteredNotifyError,
  isSshFatalConnectFailureMessage,
  isSshFloodError,
  shouldReconnectAfterSshClose,
  sshFloodCooldownMs,
} from './ssh-query-client.js';

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

describe('fatal SSH connect failure messages', () => {
  it('prefixes authentication and host-key details for Files mapping', () => {
    const auth = formatFatalSshFailureMessage('All configured authentication methods failed');
    assert.match(auth, /^SSH authentication failed:/);
    assert.equal(isSshFatalConnectFailureMessage(auth), true);

    const hostKey = formatFatalSshFailureMessage('SSH host key mismatch for example');
    assert.match(hostKey, /^SSH host key verification failed:/);
    assert.equal(isSshFatalConnectFailureMessage(hostKey), true);

    assert.equal(isSshFatalConnectFailureMessage('SSH not connected'), false);
  });
});

describe('SSH Query flood recovery', () => {
  it('recognizes TeamSpeak 524 flooding responses', () => {
    assert.equal(isSshFloodError(new Error('TS error 524: client is flooding')), true);
    assert.equal(isSshFloodError(new Error('Connection lost before handshake')), false);
  });

  it('backs off repeated flood strikes without exceeding five minutes', () => {
    assert.equal(sshFloodCooldownMs(1), 60_000);
    assert.equal(sshFloodCooldownMs(2), 120_000);
    assert.equal(sshFloodCooldownMs(3), 240_000);
    assert.equal(sshFloodCooldownMs(4), 300_000);
    assert.equal(sshFloodCooldownMs(10), 300_000);
  });

  it('treats Connection lost before handshake as non-flood (reconnect separately)', () => {
    assert.equal(isSshFloodError(new Error('Connection lost before handshake')), false);
    assert.equal(isSshFloodError(new Error('read ECONNRESET')), false);
  });

  it('ignores already-registered (516) notify errors and rejects other failures', () => {
    assert.equal(isAlreadyRegisteredNotifyError(new Error('TS error 516: already registered')), true);
    assert.equal(isAlreadyRegisteredNotifyError(new Error('TS error 524: client is flooding')), false);
    assert.equal(isAlreadyRegisteredNotifyError(new Error('TS error 2568: insufficient client permissions')), false);
    // Different ID whose message text contains "516" must not be treated as already-registered.
    assert.equal(
      isAlreadyRegisteredNotifyError(new Error('TS error 2568: channel 516 already taken')),
      false,
    );
  });
});
