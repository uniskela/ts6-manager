import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ISOLATED_DB_BASENAME,
  assessIsolatedSqliteTarget,
} from './isolated-db-target.js';

describe('isolated SQLite target safety (Step 4B)', () => {
  it('requires exact basename and refuses production / smuggled markers', () => {
    const ok = assessIsolatedSqliteTarget('file:./data/discord-int-test.db');
    assert.equal(ok.ok, true);
    assert.equal(ok.basename, ISOLATED_DB_BASENAME);

    assert.equal(assessIsolatedSqliteTarget('file:./data/ts6webui.db').ok, false);
    assert.equal(assessIsolatedSqliteTarget('file:./data/evil-discord-int-test.db').ok, false);
    assert.equal(
      assessIsolatedSqliteTarget('file:./data/ts6webui.db?marker=discord-int-test').ok,
      false,
    );
    assert.equal(
      assessIsolatedSqliteTarget('file:./data/prod.db#discord-int-test').ok,
      false,
    );
  });

  it('refuses symlink aliases that resolve to a production basename', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ts6-4b-symlink-'));
    try {
      const prod = path.join(root, 'ts6webui.db');
      const alias = path.join(root, ISOLATED_DB_BASENAME);
      await writeFile(prod, '');
      await symlink(prod, alias);
      const assessment = assessIsolatedSqliteTarget(`file:${alias}`);
      assert.equal(assessment.ok, false);
      assert.ok(assessment.errors.some((e) => /forbidden|realpath/i.test(e)));
      assert.ok(fs.existsSync(alias));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allowAny still refuses forbidden production basenames', () => {
    const assessment = assessIsolatedSqliteTarget('file:./data/ts6webui.db', {
      allowAnyDatabase: true,
    });
    assert.equal(assessment.ok, false);
  });
});
