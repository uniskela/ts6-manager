import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hostCandidateIpsFromSdp,
  isBrowserOnLoopback,
  isLoopbackIp,
  offerAdvertisesLoopbackOnly,
  previewIceErrorMessage,
} from '../../src/lib/preview-webrtc';

const LOOPBACK_OFFER = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 127.0.0.1',
  'a=candidate:1 1 UDP 2130706431 127.0.0.1 10000 typ host',
  'a=candidate:2 1 UDP 2130706430 127.0.0.1 10000 typ host',
  'a=end-of-candidates',
].join('\r\n');

const LAN_OFFER = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=candidate:1 1 UDP 2130706431 192.168.1.50 10000 typ host',
  'a=candidate:2 1 UDP 1694498815 203.0.113.10 3478 typ srflx raddr 192.168.1.50 rport 10000',
].join('\n');

describe('isBrowserOnLoopback', () => {
  it('accepts localhost and 127/8', () => {
    assert.equal(isBrowserOnLoopback('localhost'), true);
    assert.equal(isBrowserOnLoopback('127.0.0.1'), true);
    assert.equal(isBrowserOnLoopback('127.1.2.3'), true);
    assert.equal(isBrowserOnLoopback('::1'), true);
  });

  it('rejects public and LAN hostnames', () => {
    assert.equal(isBrowserOnLoopback('ts6.example.com'), false);
    assert.equal(isBrowserOnLoopback('192.168.1.10'), false);
    assert.equal(isBrowserOnLoopback('10.0.0.5'), false);
  });
});

describe('SDP host candidates', () => {
  it('extracts host IPs and ignores srflx', () => {
    assert.deepEqual(hostCandidateIpsFromSdp(LAN_OFFER), ['192.168.1.50']);
    assert.deepEqual(hostCandidateIpsFromSdp(LOOPBACK_OFFER), ['127.0.0.1', '127.0.0.1']);
  });

  it('detects loopback-only offers', () => {
    assert.equal(offerAdvertisesLoopbackOnly(LOOPBACK_OFFER), true);
    assert.equal(offerAdvertisesLoopbackOnly(LAN_OFFER), false);
    assert.equal(offerAdvertisesLoopbackOnly('v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\n'), false);
  });

  it('classifies loopback IPs', () => {
    assert.equal(isLoopbackIp('127.0.0.1'), true);
    assert.equal(isLoopbackIp('::1'), true);
    assert.equal(isLoopbackIp('192.168.0.1'), false);
  });
});

describe('previewIceErrorMessage', () => {
  it('mentions NAT1TO1 for loopback mismatch', () => {
    const msg = previewIceErrorMessage('loopback-mismatch');
    assert.match(msg, /127\.0\.0\.1/);
    assert.match(msg, /WEBRTC_NAT1TO1_IP/);
  });

  it('mentions timeout vs failed', () => {
    assert.match(previewIceErrorMessage('timeout'), /timed out/i);
    assert.match(previewIceErrorMessage('failed'), /failed/i);
  });
});
