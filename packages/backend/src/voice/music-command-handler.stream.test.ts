import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MusicCommandHandler } from './music-command-handler.js';

function fixture() {
  const replies: string[] = [];
  const starts: Array<{ url: string; options: Record<string, unknown> }> = [];
  const manager = {
    startVideoStream: async (_bot: unknown, url: string, options: Record<string, unknown>) => {
      starts.push({ url, options });
    },
  };
  const handler = new MusicCommandHandler({} as any, manager as any) as any;
  handler.reply = (_bot: unknown, _id: number, message: string) => replies.push(message);
  const bot = {
    currentConfig: { id: 1, serverConfigId: 9 },
    videoStreaming: false,
    musicSessionInfo: () => null,
  };
  const stream = (args: string) => handler.handleStream(bot, 2, args);
  return { stream, replies, starts };
}

// Without a preset the start used to fall back to the bot's stored preset,
// which no UI can change from 720p: a 4K source came out at 720p although
// Streaming defaults allowed Auto up to 2160p.
test('!stream without a preset asks for Auto quality', async () => {
  const f = fixture();
  await f.stream('https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.preset, 'auto');
  assert.match(f.replies.at(-1)!, /Video stream started/);
});

test('!stream without a preset asks for Auto quality on Twitch too', async () => {
  const f = fixture();
  await f.stream('https://www.twitch.tv/somechannel');
  assert.equal(f.starts[0].options.preset, 'auto');
});

// Auto probes a direct URL before playback, a second connection that IPTV
// services limited to one connection refuse; !tv avoids it the same way.
test('!stream without a preset does not probe a direct URL', async () => {
  const f = fixture();
  await f.stream('http://iptv.example.com/live/42.ts');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.preset, undefined);
});

test('!stream keeps a preset that was typed', async () => {
  const f = fixture();
  await f.stream('https://example.com/clip.mp4 1080p');
  assert.equal(f.starts[0].options.preset, '1080p');
  await f.stream('https://example.com/clip.mp4 auto');
  assert.equal(f.starts[1].options.preset, 'auto');
});

test('!stream rejects an unknown preset and starts nothing', async () => {
  const f = fixture();
  await f.stream('https://example.com/clip.mp4 4k');
  assert.equal(f.starts.length, 0);
  assert.match(f.replies.at(-1)!, /preset must be auto, 480p/);
});
