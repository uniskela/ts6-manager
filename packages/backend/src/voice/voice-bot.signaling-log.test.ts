import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VoiceBot } from './voice-bot.js';

function makeBot(): VoiceBot {
  return new VoiceBot({
    id: 7, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
  });
}

async function captureError(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = orig;
  }
  return lines;
}

describe('viewer signaling errors stay one log record', () => {
  const marker = 'ZZLOGSPLIT';
  const nasty = `bad\r\n${marker}\n\x1b`;

  it('quotes an ICE relay error', async () => {
    const bot = makeBot();
    (bot as any).sidecarHttp = {
      addIceCandidate: async () => { throw new Error(nasty); },
    };
    const lines = await captureError(() => (bot as any).handleSignalingMessage({
      type: 'ice_candidate', clid: 42, candidate: 'x', raw: '',
    }));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes('\n'), false);
    assert.equal(lines[0].includes('\r'), false);
    assert.equal(lines[0].includes('\x1b'), false);
    assert.match(lines[0], /clid=42/);
    assert.match(lines[0], /ZZLOGSPLIT/);
  });

  it('quotes an answer relay error and still accepts a later candidate', async () => {
    const bot = makeBot();
    let candidates = 0;
    (bot as any).sidecarHttp = {
      setAnswer: async () => { throw new Error(nasty); },
      addIceCandidate: async () => { candidates += 1; },
    };
    const answerLog = await captureError(() => (bot as any).handleSignalingMessage({
      type: 'answer', clid: 42, sdp: 'v=0', raw: '',
    }));
    assert.equal(answerLog.length, 1);
    assert.equal(answerLog[0].includes('\n'), false);
    assert.match(answerLog[0], /setAnswer error/);
    await (bot as any).handleSignalingMessage({
      type: 'ice_candidate', clid: 42, candidate: 'candidate:1 1 udp 1 192.0.2.10 9 typ host', raw: '',
    });
    assert.equal(candidates, 1);
  });
});
