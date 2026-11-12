import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateJobId,
  allowTlsConnect,
  constrainRadioPorts,
  mediaEgressRefusal,
  parseConnectAuthority,
  parseJobId,
  pinMediaAddresses,
  RADIO_EGRESS_PORTS,
} from './policy.mjs';
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

  it('clamps requested ports to the radio policy', () => {
    assert.deepEqual(constrainRadioPorts(undefined).sort(), [...RADIO_EGRESS_PORTS].sort());
    assert.deepEqual(constrainRadioPorts([8000, 22, 443]), [8000, 443]);
    assert.equal(constrainRadioPorts([22, 9443]), null);
    assert.equal(constrainRadioPorts(['nope']), null);
  });

  it('rejects duplicate and malformed job ids without replacing the live job', () => {
    const jobs = new Map([['live-job', { id: 'live-job' }]]);
    assert.equal(allocateJobId(jobs, 'live-job').error, 'duplicate-job');
    assert.equal(jobs.get('live-job').id, 'live-job');
    assert.equal(allocateJobId(jobs, '../x').error, 'bad-job-id');
    assert.equal(allocateJobId(jobs, 'bad id').error, 'bad-job-id');
    assert.equal(allocateJobId(jobs, 'ok_job-1').jobId, 'ok_job-1');
    assert.match(allocateJobId(jobs, '').jobId, /^[a-f0-9]{16}$/);
    assert.equal(parseJobId('live-job'), 'live-job');
    assert.equal(parseJobId(''), null);
    assert.equal(parseJobId('../x'), null);
  });

  it('allows TLS CONNECT only for HTTPS-start jobs', () => {
    assert.equal(allowTlsConnect('https://203.0.113.10/live.m3u8'), true);
    assert.equal(allowTlsConnect('http://203.0.113.10/live'), false);
    assert.equal(allowTlsConnect('http://203.0.113.10/https-hop.m3u8'), false);
    assert.equal(allowTlsConnect(''), false);
    assert.equal(allowTlsConnect({ connect: true }), false);
  });

  it('parses CONNECT authorities strictly', () => {
    assert.deepEqual(parseConnectAuthority('origin.example:443'), { host: 'origin.example', port: 443 });
    assert.deepEqual(parseConnectAuthority('203.0.113.10:8443'), { host: '203.0.113.10', port: 8443 });
    assert.deepEqual(parseConnectAuthority('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 });
    assert.equal(parseConnectAuthority('2001:db8::1:443'), null);
    assert.equal(parseConnectAuthority('[2001:db8::1'), null);
    assert.equal(parseConnectAuthority('host'), null);
    assert.equal(parseConnectAuthority('host:99999'), null);
    assert.equal(parseConnectAuthority(''), null);
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
