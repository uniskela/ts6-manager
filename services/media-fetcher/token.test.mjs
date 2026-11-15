import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPrivateTokenMode, tokensEqual } from './token.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('fetcher token mode', () => {
  it('accepts owner-only and group-readable files, refuses world access', () => {
    assert.doesNotThrow(() => assertPrivateTokenMode(0o100600));
    assert.doesNotThrow(() => assertPrivateTokenMode(0o100640));
    assert.throws(() => assertPrivateTokenMode(0o100644), /world/);
    assert.throws(() => assertPrivateTokenMode(0o100666), /world/);
  });

  it('compares tokens in constant time', () => {
    assert.equal(tokensEqual('ts6-evil-token-x', 'ts6-evil-token-x'), true);
    assert.equal(tokensEqual('ts6-evil-token-x', 'ts6-evil-token-y'), false);
    assert.equal(tokensEqual('short', 'ts6-evil-token-x'), false);
    assert.equal(tokensEqual('', ''), true);
  });

  it('installs a 600 copy, optional ctl secret, and refuses a world-readable source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts6-token-'));
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    const ctlDest = join(dir, 'ctl');
    writeFileSync(src, 'ts6-fetcher-test-token-xxxxxxxx', { mode: 0o600 });
    const ok = spawnSync(process.execPath, [join(here, 'install-token.mjs')], {
      env: { ...process.env, TOKEN_SRC: src, TOKEN_DEST: dest, CTL_TOKEN_DEST: ctlDest },
      encoding: 'utf8',
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(statSync(dest).mode & 0o777, 0o600);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(src, 'utf8'));
    assert.equal(statSync(ctlDest).mode & 0o777, 0o600);
    assert.ok(readFileSync(ctlDest, 'utf8').replace(/\s+/g, '').length >= 16);

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
