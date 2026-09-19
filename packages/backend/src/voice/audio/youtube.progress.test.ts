import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadYouTube } from './youtube.js';

test('download pipeline emits structured subprocess progress and ignores abandoned partial cache', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts6-progress-'));
  const previousPath = process.env.PATH;
  const updates: any[] = [];
  try {
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.at(-2) !== '--') process.exit(9);
if (args.includes('--dump-json')) {
  console.log(JSON.stringify({ id: 'abcdefghijk', title: 'Fixture', duration: 1 }));
} else {
  if (!args.includes('--newline') || !args.includes('download:ts6-progress:%(progress)j')) process.exit(8);
  const output = args[args.indexOf('-o') + 1].replace('%(id)s', 'abcdefghijk').replace('%(ext)s', 'opus');
  process.stdout.write('ts6-progress:{"downloaded_bytes":5,');
  setTimeout(() => {
    process.stdout.write('"total_bytes":10,"speed":2,"eta":3}\\n');
    console.error('ts6-processing');
    fs.writeFileSync(output, 'fixture');
  }, 10);
}
`);
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
    await writeFile(path.join(dir, 'abcdefghijk.webm.part'), 'unfinished');
    const result = await downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, p => updates.push(p));
    assert.equal(path.extname(result.filePath), '.opus');
    assert.ok(updates.some(p => p.percentage === 50 && p.speed === 2 && p.eta === 3));
    assert.equal(updates.at(-1).status, 'processing');
    const cached = await downloadYouTube('https://www.youtube.com/watch?v=abcdefghijk', dir, () => assert.fail('cached file should not download'));
    assert.equal(cached.filePath, result.filePath);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
