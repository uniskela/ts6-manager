import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { avatarDimensions, fitAvatarForTeamSpeak, TS_AVATAR_MAX_PX } from './bot-avatar-fit.js';
import { DEFAULT_AVATAR_FILE } from '../utils/bot-avatar-storage.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ffmpegImage(args: string[]): Buffer {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

test('reads PNG, GIF and JPEG dimensions from the header', { skip: !hasFfmpeg }, () => {
  assert.deepEqual(avatarDimensions(ffmpegImage(['-f', 'lavfi', '-i', 'color=c=red:s=640x480', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png'])), { width: 640, height: 480 });
  assert.deepEqual(avatarDimensions(ffmpegImage(['-f', 'lavfi', '-i', 'color=c=red:s=120x90', '-frames:v', '1', '-f', 'gif'])), { width: 120, height: 90 });
  assert.deepEqual(avatarDimensions(ffmpegImage(['-f', 'lavfi', '-i', 'color=c=red:s=400x200', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg'])), { width: 400, height: 200 });
  assert.equal(avatarDimensions(Buffer.from('not an image')), null);
});

test('the shipped 512x512 default avatar is shrunk to fit TeamSpeak', { skip: !hasFfmpeg }, async () => {
  const original = await readFile(DEFAULT_AVATAR_FILE);
  assert.deepEqual(avatarDimensions(original), { width: 512, height: 512 });
  const fitted = await fitAvatarForTeamSpeak(original);
  assert.deepEqual(avatarDimensions(fitted!), { width: TS_AVATAR_MAX_PX, height: TS_AVATAR_MAX_PX });
  assert.equal(await fitAvatarForTeamSpeak(original), fitted, 'cached by content');
});

test('wide JPEG keeps its aspect ratio and animated GIF stays a GIF', { skip: !hasFfmpeg }, async () => {
  const wide = await fitAvatarForTeamSpeak(ffmpegImage(['-f', 'lavfi', '-i', 'testsrc=s=900x300', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg']));
  assert.deepEqual(avatarDimensions(wide!), { width: 300, height: 100 });
  const gif = await fitAvatarForTeamSpeak(ffmpegImage(['-f', 'lavfi', '-i', 'testsrc=s=600x600:d=0.3:r=10', '-f', 'gif']));
  assert.equal(gif!.subarray(0, 3).toString('ascii'), 'GIF');
  assert.deepEqual(avatarDimensions(gif!), { width: 300, height: 300 });
});

test('small and unrecognised images are uploaded unchanged', async () => {
  const fake = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(await fitAvatarForTeamSpeak(fake), fake);
  assert.equal(await fitAvatarForTeamSpeak(null), null);
});
