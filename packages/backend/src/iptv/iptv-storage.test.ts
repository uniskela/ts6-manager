import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  decodePlaylistUpload,
  deleteIptvSourceFile,
  ensureIptvStorageDir,
  IPTV_STORAGE_DIR,
  resolveIptvSourcePath,
  sanitizeOriginalFilename,
  writeIptvSourceFile,
  readIptvSourceFile,
} from './iptv-storage.js';
import { parseM3U } from './m3u-parser.js';
import { toPlaylistSummary } from './iptv-service.js';

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="ch1" group-title="News",Channel One
http://example.test/live/1.ts
#EXTINF:-1,Channel Two
http://example.test/live/2.ts
`;

describe('iptv-storage', () => {
  let cwd: string;
  let tmp: string;

  before(() => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-storage-'));
    process.chdir(tmp);
  });

  after(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates data/iptv and writes atomically with a generated basename', () => {
    ensureIptvStorageDir();
    assert.equal(fs.existsSync(IPTV_STORAGE_DIR), true);
    const relative = writeIptvSourceFile(SAMPLE_M3U, 'My List.m3u');
    assert.match(relative, /^[0-9a-f-]{36}\.m3u$/i);
    assert.equal(path.basename(relative), relative);
    assert.equal(readIptvSourceFile(relative), SAMPLE_M3U);
    assert.equal(fs.existsSync(resolveIptvSourcePath(relative)), true);
  });

  it('rejects path traversal and unsafe basenames', () => {
    assert.throws(() => resolveIptvSourcePath('../etc/passwd'), /Invalid IPTV source path/);
    assert.throws(() => resolveIptvSourcePath('subdir/file.m3u'), /Invalid IPTV source path/);
    assert.throws(() => resolveIptvSourcePath(''), /Invalid IPTV source path/);
  });

  it('deletes stored files by relative basename', () => {
    const relative = writeIptvSourceFile(SAMPLE_M3U, 'gone.m3u8');
    const absolute = resolveIptvSourcePath(relative);
    assert.equal(fs.existsSync(absolute), true);
    deleteIptvSourceFile(relative);
    assert.equal(fs.existsSync(absolute), false);
  });

  it('decodes UTF-8 text and rejects empty or binary uploads', () => {
    assert.equal(decodePlaylistUpload(Buffer.from(SAMPLE_M3U, 'utf-8')), SAMPLE_M3U);
    assert.throws(() => decodePlaylistUpload(Buffer.alloc(0)), /empty/);
    assert.throws(() => decodePlaylistUpload(Buffer.from([0x00, 0x01, 0x02])), /text playlist/);
  });

  it('sanitizes original filenames to basenames only', () => {
    assert.equal(sanitizeOriginalFilename('../../foxtel.m3u'), 'foxtel.m3u');
    assert.equal(sanitizeOriginalFilename(''), null);
    assert.equal(sanitizeOriginalFilename(null), null);
  });
});

describe('parseM3U + upload validation path', () => {
  it('parses sample M3U used by upload import', () => {
    const channels = parseM3U(SAMPLE_M3U);
    assert.equal(channels.length, 2);
    assert.equal(channels[0].name, 'Channel One');
    assert.equal(channels[0].groupTitle, 'News');
  });

  it('rejects content with no channels (upload gate)', () => {
    assert.equal(parseM3U('#EXTM3U\n# comment only\n').length, 0);
  });
});

describe('toPlaylistSummary', () => {
  it('never exposes sourcePath and nulls URL for uploads', () => {
    const summary = toPlaylistSummary({
      id: 1,
      name: 'Uploaded',
      sourceType: 'upload',
      url: null,
      originalFilename: 'foxtel.m3u',
      serverConfigId: 1,
      autoRefreshMinutes: 0,
      lastRefreshedAt: null,
      lastError: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      channelCount: 12,
    });
    assert.equal(summary.sourceType, 'upload');
    assert.equal(summary.url, null);
    assert.equal(summary.originalFilename, 'foxtel.m3u');
    assert.equal('sourcePath' in summary, false);
  });

  it('keeps URL for remote sources', () => {
    const summary = toPlaylistSummary({
      id: 2,
      name: 'Remote',
      sourceType: 'url',
      url: 'https://example.test/list.m3u',
      originalFilename: null,
      serverConfigId: 1,
      autoRefreshMinutes: 60,
      lastRefreshedAt: null,
      lastError: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      _count: { channels: 3 },
    });
    assert.equal(summary.sourceType, 'url');
    assert.equal(summary.url, 'https://example.test/list.m3u');
    assert.equal(summary.originalFilename, null);
    assert.equal(summary.channelCount, 3);
  });
});
