import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setMediaEgressProxyForTests } from '../egress/media-egress.js';
import { searchYouTube } from './youtube.js';
import { httpOnlyFormat, spawnYtDlp, withHttpOnlyFormats, YT_DLP_EGRESS_ARGS, ytDlpTarget } from './yt-dlp-process.js';

describe('yt-dlp format restriction', () => {
  it('adds the HTTP-only protocol filter to every alternative and merged part', () => {
    const filter = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments(_generator)?)$']";
    assert.equal(httpOnlyFormat('ba/b'), `ba${filter}/b${filter}`);
    assert.equal(httpOnlyFormat('bv*[height<=720]+ba/b'), `bv*[height<=720]${filter}+ba${filter}/b${filter}`);
    assert.throws(() => httpOnlyFormat('(bv,ba)'), /Unsupported/);
    assert.deepEqual(withHttpOnlyFormats(['-x', '-f', 'b', '--', 'u']), ['-x', '-f', `b${filter}`, '--', 'u']);
  });

  it('finds what a run fetches', () => {
    assert.equal(ytDlpTarget(['-J', '--', 'https://media.test/a']), 'https://media.test/a');
    assert.equal(ytDlpTarget(['ytsearch5:some song', '--dump-json']), 'ytsearch5:some song');
    assert.throws(() => ytDlpTarget(['--version']));
  });
});

describe('yt-dlp runs through the media egress proxy', { skip: process.platform === 'win32' }, () => {
  let dir: string;
  let record: string;
  const previous = { path: process.env.YT_DLP_PATH, off: process.env.MEDIA_EGRESS_PROXY, noProxy: process.env.NO_PROXY };

  beforeEach(async () => {
    setMediaEgressProxyForTests(undefined);
    delete process.env.MEDIA_EGRESS_PROXY;
    process.env.NO_PROXY = '*';
    dir = await mkdtemp(path.join(tmpdir(), 'ts6-ytdlp-egress-'));
    record = path.join(dir, 'record.json');
    // A yt-dlp that records its arguments, proxy environment and stdin, then exits.
    const executable = path.join(dir, 'yt-dlp');
    await writeFile(executable, `#!${process.execPath}
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /proxy$/i.test(k)));
  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env, input }));
});
`);
    await chmod(executable, 0o755);
    process.env.YT_DLP_PATH = executable;
  });

  afterEach(async () => {
    setMediaEgressProxyForTests(undefined);
    for (const [name, value] of [['YT_DLP_PATH', previous.path], ['MEDIA_EGRESS_PROXY', previous.off], ['NO_PROXY', previous.noProxy]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const recorded = async () => JSON.parse(await readFile(record, 'utf8')) as { argv: string[]; env: Record<string, string>; input: string };

  it('passes the job proxy on stdin and in the environment, never on the command line', async () => {
    const { proc } = await spawnYtDlp(['-f', 'ba/b', '--', 'https://media.test/a'], { target: 'https://media.test/a', timeoutMs: 10_000 });
    await new Promise((resolve) => proc.once('close', resolve));
    const { argv, env, input } = await recorded();
    assert.deepEqual(argv.slice(0, YT_DLP_EGRESS_ARGS.length), [...YT_DLP_EGRESS_ARGS]);
    assert.match(argv[argv.indexOf('-f') + 1], /^ba\[protocol~=/);
    const proxyUrl = /^--proxy (\S+)\n$/.exec(input)?.[1];
    assert.ok(proxyUrl, 'proxy given on stdin');
    assert.match(proxyUrl, /^http:\/\/job:[0-9a-f]{64}@127\.0\.0\.1:\d+$/);
    assert.ok(!argv.join(' ').includes(new URL(proxyUrl).password), 'token not in the process list');
    assert.deepEqual(env, { http_proxy: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
  });

  it('is used by the YouTube helpers', async () => {
    await searchYouTube('some song', 1);
    const { argv, input } = await recorded();
    assert.deepEqual(argv.slice(0, YT_DLP_EGRESS_ARGS.length), [...YT_DLP_EGRESS_ARGS]);
    assert.match(input, /^--proxy http:\/\/job:/);
  });

  it('refuses non-YouTube links without starting yt-dlp while protection is off', async () => {
    process.env.MEDIA_EGRESS_PROXY = 'off';
    await assert.rejects(spawnYtDlp(['--', 'https://media.test/a'], { target: 'https://media.test/a', timeoutMs: 10_000 }), /switched off/);
    await assert.rejects(readFile(record, 'utf8'), /ENOENT/);
  });
});

describe('every networked yt-dlp run uses spawnYtDlp', () => {
  it('has no other yt-dlp spawn in the backend source', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    // Where the path is defined and used by spawnYtDlp, and offline probes such as --version.
    const offlineProbes = new Set([
      'voice/audio/yt-dlp-path.ts', 'voice/audio/yt-dlp-process.ts',
      'voice/audio/runtime-media-diagnostics.ts', 'voice/audio/media-admin-diagnostics.ts', 'voice/audio/yt-dlp-diagnostics.ts',
    ]);
    const offenders: string[] = [];
    const walk = (folder: string) => {
      for (const name of readdirSync(folder)) {
        const full = path.join(folder, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const relative = path.relative(src, full).split(path.sep).join('/');
        if (offlineProbes.has(relative)) continue;
        if (/getYtDlpPath\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(relative);
      }
    };
    walk(src);
    assert.deepEqual(offenders, []);
  });
});
