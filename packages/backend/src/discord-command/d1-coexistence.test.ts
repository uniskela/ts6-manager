/**
 * Narrow coexistence checks for the D1 + Commands & Radio integration branch.
 * Does not import @ts6/discord-bridge (separate Node/lockfile toolchain).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { shouldEnableIsolatedLiveAdministratorGrant } from '../startup-isolation.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('pnpm workspace keeps discord-bridge on its own lockfile/toolchain', () => {
  const workspace = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /!packages\/discord-bridge/);
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages/discord-bridge/package.json')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages/backend/src/discord-command/adapter.ts')));
});

test('production-default env never enables isolated-live Administrator grant', () => {
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({}), false);
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({
    NODE_ENV: 'production',
    DISCORD_INTERACTIONS_ENABLED: 'true',
  }), false);
});
