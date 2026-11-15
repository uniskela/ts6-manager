/**
 * Path A seam checks: Commands & Radio ship without the D1 discord-bridge package.
 * Bridge health stays optional/honest-unavailable; no @ts6/discord-bridge import.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { shouldEnableIsolatedLiveAdministratorGrant } from '../startup-isolation.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('Path A tree has Commands adapter and no discord-bridge package', () => {
  const workspace = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  assert.doesNotMatch(workspace, /!packages\/discord-bridge/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages/discord-bridge/package.json')), false);
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages/backend/src/discord-command/adapter.ts')));
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages/backend/src/discord-command/bridge-health-port.ts')));
});

test('production-default env never enables isolated-live Administrator grant', () => {
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({}), false);
  assert.equal(shouldEnableIsolatedLiveAdministratorGrant({
    NODE_ENV: 'production',
    DISCORD_INTERACTIONS_ENABLED: 'true',
  }), false);
});
