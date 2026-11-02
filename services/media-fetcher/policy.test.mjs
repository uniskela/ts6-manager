import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mediaEgressRefusal, pinMediaAddresses, RADIO_EGRESS_PORTS } from './policy.mjs';
import { matchPeerInode } from './peer-pid.mjs';

describe('media fetcher policy', () => {
  it('refuses loopback, private, and metadata', () => {
    assert.equal(mediaEgressRefusal('127.0.0.1'), 'reserved');
    assert.equal(mediaEgressRefusal('10.0.0.1'), 'private');
    assert.equal(mediaEgressRefusal('169.254.169.254'), 'reserved');
    assert.equal(mediaEgressRefusal('8.8.8.8'), null);
  });

  it('poisons mixed DNS answers', () => {
    const pinned = pinMediaAddresses(['8.8.8.8', '10.0.0.1']);
    assert.deepEqual(pinned.addresses, []);
    assert.match(pinned.reason, /private/);
  });

  it('keeps radio Icecast ports', () => {
    assert.ok(RADIO_EGRESS_PORTS.has(8000));
    assert.ok(RADIO_EGRESS_PORTS.has(443));
    assert.equal(RADIO_EGRESS_PORTS.has(22), false);
  });
});

describe('peer 4-tuple invert', () => {
  it('matches the client row, not the accepted server row', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 0 0 0 10 -1',
      '   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 22222 1 0000000000000000 0 0 0 10 -1',
    ].join('\n');
    // accepted socket: local=0x1F90 (8080), remote=0xC350 (50000)
    assert.equal(matchPeerInode(table, 0x1f90, 0xc350), '22222');
    assert.equal(matchPeerInode(table, 0xc350, 0x1f90), '11111');
  });
});
