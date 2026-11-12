import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assessProdGuildBindDatabaseUrl } from './prod-db-target.js';

describe('prod guild-bind database allowlist', () => {
  it('accepts existing ts6webui.db and refuses other names', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-'));
    try {
      const okPath = path.join(dir, 'ts6webui.db');
      writeFileSync(okPath, '');
      const real = realpathSync(okPath);
      const ok = assessProdGuildBindDatabaseUrl(`file:${okPath}`, {
        requireExisting: true,
        confirmRealpath: real,
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.realPath, real);

      const badPath = path.join(dir, 'discord-int-test.db');
      writeFileSync(badPath, '');
      const bad = assessProdGuildBindDatabaseUrl(`file:${badPath}`, { requireExisting: true });
      assert.equal(bad.ok, false);
      assert.match(bad.errors.join(' '), /basename must be/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has no allow-any bypass', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-'));
    try {
      const other = path.join(dir, 'scratch.db');
      writeFileSync(other, '');
      const assessed = assessProdGuildBindDatabaseUrl(`file:${other}`, { requireExisting: true });
      assert.equal(assessed.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses missing database when requireExisting', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-miss-'));
    try {
      const missing = path.join(dir, 'ts6webui.db');
      const assessed = assessProdGuildBindDatabaseUrl(`file:${missing}`, { requireExisting: true });
      assert.equal(assessed.ok, false);
      assert.match(assessed.errors.join(' '), /must already exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses same basename in a different directory without matching confirmRealpath', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-twin-'));
    try {
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      mkdirSync(a);
      mkdirSync(b);
      const dbA = path.join(a, 'ts6webui.db');
      const dbB = path.join(b, 'ts6webui.db');
      writeFileSync(dbA, 'a');
      writeFileSync(dbB, 'b');
      const realA = realpathSync(dbA);
      const realB = realpathSync(dbB);
      assert.notEqual(realA, realB);

      const wrong = assessProdGuildBindDatabaseUrl(`file:${dbA}`, {
        requireExisting: true,
        confirmRealpath: realB,
      });
      assert.equal(wrong.ok, false);
      assert.match(wrong.errors.join(' '), /confirmRealpath mismatch/);

      const right = assessProdGuildBindDatabaseUrl(`file:${dbA}`, {
        requireExisting: true,
        confirmRealpath: realA,
      });
      assert.equal(right.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses symlink whose realpath basename is not allowlisted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-link-'));
    try {
      const target = path.join(dir, 'other.db');
      const link = path.join(dir, 'ts6webui.db');
      writeFileSync(target, '');
      symlinkSync(target, link);
      const assessed = assessProdGuildBindDatabaseUrl(`file:${link}`, { requireExisting: true });
      assert.equal(assessed.ok, false);
      assert.match(assessed.errors.join(' '), /realpath basename not allowlisted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
