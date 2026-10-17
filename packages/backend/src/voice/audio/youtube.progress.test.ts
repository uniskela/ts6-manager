import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadYouTube } from './youtube.js';
import { MediaCache, setMediaCacheForTests } from './media-cache.js';

test('download pipeline emits structured subprocess progress and ignores abandoned partial cache', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts6-progress-'));
  const previousYtDlpPath = process.env.YT_DLP_PATH;
  const updates: any[] = [];
  try {
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--dump-json')) {
  if (args.at(-2) !== '--') process.exit(9);
  // The first player client returns no formats (as under a bot check); the next one does.
  const first = args.includes('youtube:player_client=tv_embedded,web,default');
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), 'info-calls'), first ? 'first\\n' : 'next\\n');
  const formats = first ? [] : [{ format_id: '251', url: 'https://media.test/a', protocol: 'https' }];
  console.log(JSON.stringify({ id: 'abcdefghijk', extractor_key: 'Youtube', title: 'Fixture', duration: 1, formats }));
} else {
  // The download runs from the saved info document, into the job's staging folder.
  if (!args.includes('--load-info-json') || args.includes('--')) process.exit(9);
  if (!args.includes('--newline') || !args.includes('download:ts6-progress:%(progress)j')) process.exit(8);
  const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'opus');
  process.stdout.write('ts6-progress:{"downloaded_bytes":5,');
  setTimeout(() => {
    process.stdout.write('"total_bytes":10,"speed":2,"eta":3}\\n');
    console.error('ts6-processing');
    fs.writeFileSync(output, 'fixture');
    console.log(output);
  }, 10);
}
`);
    await chmod(executable, 0o755);
    process.env.YT_DLP_PATH = executable;
    setMediaCacheForTests(dir, new MediaCache(dir, { probe: async () => ({ hasAudio: true, durationSec: 1 }), log: () => {} }));
    // A partial file from an older, interrupted download is never used.
    await writeFile(path.join(dir, 'abcdefghijk.webm.part'), 'unfinished');
    const result = await downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, p => updates.push(p));
    assert.equal(path.extname(result.filePath), '.opus');
    assert.ok(updates.some(p => p.percentage === 50 && p.speed === 2 && p.eta === 3));
    assert.equal(updates.at(-1).status, 'processing');
    const cached = await downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, () => assert.fail('cached file should not download'));
    assert.equal(cached.filePath, result.filePath);
    const { readFile: read } = await import('node:fs/promises');
    assert.match(await read(path.join(dir, 'info-calls'), 'utf8'), /^first\nnext\n/, 'a client without formats is skipped');
  } finally {
    setMediaCacheForTests(dir, undefined);
    if (previousYtDlpPath === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = previousYtDlpPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a link whose metadata lists more than one item', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts6-multi-'));
  const previousYtDlpPath = process.env.YT_DLP_PATH;
  try {
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (!args.includes('--dump-json')) process.exit(7);
for (const id of ['one', 'two']) {
  console.log(JSON.stringify({ id, extractor_key: 'Generic', formats: [{ url: 'https://media.test/' + id, protocol: 'https' }] }));
}
`);
    await chmod(executable, 0o755);
    process.env.YT_DLP_PATH = executable;
    setMediaCacheForTests(dir, new MediaCache(dir, { probe: async () => ({ hasAudio: true, durationSec: 1 }), log: () => {} }));
    await assert.rejects(downloadYouTube('https://media.test/page', dir), /not a single track/);
  } finally {
    setMediaCacheForTests(dir, undefined);
    if (previousYtDlpPath === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = previousYtDlpPath;
    await rm(dir, { recursive: true, force: true });
  }
});
