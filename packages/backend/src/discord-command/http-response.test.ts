import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  discordDeferredAck,
  discordMessageFromResult,
  discordPong,
  safeCommandFailure,
} from './http-response.js';

describe('Discord immediate interaction responses', () => {
  it('suppresses all mentions in externally controlled response content', () => {
    const content = 'Now playing: @everyone <@123456789012345678> <@&123456789012345678>';
    const response = discordMessageFromResult({
      ok: true,
      ephemeral: false,
      content,
      ack: 'immediate',
    });

    assert.equal(response.type, 4);
    assert.equal(response.data?.content, content);
    assert.equal(response.data?.flags, 0);
    assert.deepEqual(response.data?.allowed_mentions, { parse: [] });
  });

  it('enforces the Discord 2,000-character content limit', () => {
    const exactly = discordMessageFromResult({
      ok: true, ephemeral: true, content: 'x'.repeat(2000), ack: 'immediate',
    });
    assert.equal(exactly.data?.content?.length, 2000);
    assert.equal(exactly.data?.content, 'x'.repeat(2000));

    const long = discordMessageFromResult({
      ok: true, ephemeral: true, content: 'x'.repeat(2150), ack: 'immediate',
    });
    assert.equal(long.data?.content?.length, 2000);
    assert.ok(long.data?.content?.endsWith('…'));
    assert.deepEqual(long.data?.allowed_mentions, { parse: [] });
  });

  it('preserves ephemeral failures and safe fallback messages', () => {
    const error = discordMessageFromResult(safeCommandFailure('@everyone'));
    assert.equal(error.type, 4);
    assert.equal(error.data?.flags, 64);
    assert.equal(error.data?.content, '@everyone');
    assert.deepEqual(error.data?.allowed_mentions, { parse: [] });

    assert.equal(discordMessageFromResult({
      ok: true, ephemeral: false, content: '', ack: 'immediate',
    }).data?.content, 'Done.');
    assert.equal(discordMessageFromResult({
      ok: false, ephemeral: true, content: '', ack: 'immediate',
    }).data?.content, 'Command failed.');
  });

  it('does not alter PING or deferred acknowledgement payloads', () => {
    assert.deepEqual(discordPong(), { type: 1 });
    assert.deepEqual(discordDeferredAck(true), { type: 5, data: { flags: 64 } });
    assert.deepEqual(discordDeferredAck(false), { type: 5, data: { flags: 0 } });
  });
});
