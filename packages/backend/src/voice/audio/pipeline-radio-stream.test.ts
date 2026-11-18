import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertRadioStreamUrl, AudioPipeline } from './pipeline.js';

// These check the URL decision only, so no test opens ffmpeg.
describe('radio stream URL policy', () => {
  it('refuses a LAN station that the administrator did not allow', async () => {
    await assert.rejects(
      assertRadioStreamUrl('http://192.168.1.20:8000/live'),
      /Stream URL blocked: Private\/reserved IP addresses are blocked/,
    );
  });

  it('refuses loopback and cloud metadata addresses even with an allowlist', async () => {
    await assert.rejects(assertRadioStreamUrl('http://127.0.0.1:8000/live', ['127.0.0.1']), /Stream URL blocked/);
    await assert.rejects(
      assertRadioStreamUrl('http://169.254.169.254/latest/meta-data', ['169.254.169.254']),
      /Stream URL blocked/,
    );
  });

  it('lets an allowed LAN station through', async () => {
    await assert.doesNotReject(assertRadioStreamUrl('http://192.168.1.20:8000/live', ['192.168.1.20']));
    await assert.doesNotReject(assertRadioStreamUrl('http://192.168.1.20:8000/live', ['192.168.1.0/24']));
  });

  it('still refuses a LAN station outside the allowlist', async () => {
    await assert.rejects(
      assertRadioStreamUrl('http://192.168.1.99:8000/live', ['192.168.1.20']),
      /Stream URL blocked: Private\/reserved IP addresses are blocked/,
    );
  });

  it('applies a pending allowlist load before opening the stream', async () => {
    await assert.rejects(
      new AudioPipeline().toPcmStream('http://192.168.1.99:8000/live', Promise.resolve(['192.168.1.20'])),
      /Stream URL blocked: Private\/reserved IP addresses are blocked/,
    );
  });
});
