import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPrivateTokenMode } from './token.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('fetcher token mode', () => {
  it('accepts owner-only and group-readable files, refuses world access', () => {
    assert.doesNotThrow(() => assertPrivateTokenMode(0o100600));
    assert.doesNotThrow(() => assertPrivateTokenMode(0o100640));
    assert.throws(() => assertPrivateTokenMode(0o100644), /world/);
    assert.throws(() => assertPrivateTokenMode(0o100666), /world/);
  });

  it('installs a 600 copy and refuses a world-readable source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts6-token-'));
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    writeFileSync(src, '0123456789abcdef0123456789abcdef', { mode: 0o600 });
    const ok = spawnSync(process.execPath, [join(here, 'install-token.mjs')], {
      env: { ...process.env, TOKEN_SRC: src, TOKEN_DEST: dest },
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(statSync(dest).mode & 0o777, 0o600);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(src, 'utf8'));

    chmodSync(src, 0o644);
    const bad = spawnSync(process.execPath, [join(here, 'install-token.mjs')], {
      env: { ...process.env, TOKEN_SRC: src, TOKEN_DEST: join(dir, 'bad') },
      encoding: 'utf8',
    });
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stderr}\n${bad.stdout}`, /world/);
    rmSync(dir, { recursive: true, force: true });
  });
});
