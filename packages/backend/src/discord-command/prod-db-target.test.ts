import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assessProdGuildBindDatabaseUrl } from './prod-db-target.js';

describe('prod guild-bind database allowlist', () => {
  it('accepts basename ts6webui.db and refuses other names', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts6-prod-db-'));
    try {
      const okPath = path.join(dir, 'ts6webui.db');
      writeFileSync(okPath, '');
      const ok = assessProdGuildBindDatabaseUrl(`file:${okPath}`);
      assert.equal(ok.ok, true);

      const badPath = path.join(dir, 'discord-int-test.db');
      writeFileSync(badPath, '');
      const bad = assessProdGuildBindDatabaseUrl(`file:${badPath}`);
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
      const assessed = assessProdGuildBindDatabaseUrl(`file:${other}`);
      assert.equal(assessed.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
