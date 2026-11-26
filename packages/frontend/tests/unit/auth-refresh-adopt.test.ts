/**
 * Account-switch / session-lifecycle gates for refresh recovery.
 * Pure helpers — no network; JWT payloads are unverified identity compares.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  accessTokenUserId,
  canAdoptPersistedAuth,
  shouldApplyRefreshResponse,
} from '../../src/api/client.ts';
import {
  clearAuthRefreshCoordination,
  coordinateRefreshOwnership,
  getAuthRefreshCoordinationEpoch,
  isPersistedRefreshAdoptionAllowed,
  markLocalRefreshSuccess,
  resetAuthRefreshCoordForTests,
} from '../../src/api/auth-refresh-coord.ts';

function jwtWith(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

const aliceAccess = jwtWith({ id: 1, username: 'alice', exp: Math.floor(Date.now() / 1000) + 600 });
const aliceRotated = jwtWith({ id: 1, username: 'alice', exp: Math.floor(Date.now() / 1000) + 600 });
const aliceRelogin = jwtWith({ id: 1, username: 'alice', exp: Math.floor(Date.now() / 1000) + 600, session: 'new' });
const bobAccess = jwtWith({ id: 2, username: 'bob', exp: Math.floor(Date.now() / 1000) + 600 });

describe('refresh persist adoption identity gates', () => {
  beforeEach(() => {
    resetAuthRefreshCoordForTests();
  });

  it('parses JWT subject id', () => {
    assert.equal(accessTokenUserId(aliceAccess), 1);
    assert.equal(accessTokenUserId(bobAccess), 2);
    assert.equal(accessTokenUserId(null), null);
    assert.equal(accessTokenUserId('not-a-jwt'), null);
  });

  it('allows legitimate same-account peer rotation', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r0',
      persistedAccessToken: aliceRotated,
      persistedRefreshToken: 'r1',
      adoptionAllowed: () => true,
    }), true);
  });

  it('rejects Account B persist while Account A refresh gets 401 (no logout notify)', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-alice',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-bob',
      adoptionAllowed: () => true,
    }), false);
  });

  it('rejects after explicit logout (epoch bump / ignorePeerResults)', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 2,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-alice',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-bob',
      adoptionAllowed: () => true,
    }), false);
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-alice',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-bob',
      adoptionAllowed: () => false,
    }), false);
  });

  it('rejects account switch without explicit logout via subject mismatch', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 3,
      currentEpoch: 3,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-a',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-b',
      adoptionAllowed: () => true,
    }), false);
  });

  it('discards stale 401-recovery style adopt when persist is another account', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-stale-alice',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-bob-after-login',
      adoptionAllowed: () => true,
    }), false);
  });

  it('discards late successful refresh after logout (credentials stay cleared)', () => {
    // Pre-fix bug: currentAccessToken null + matching subject → apply restored session.
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      currentAccessToken: null,
      responseAccessToken: aliceRotated,
    }), 'discard');
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 1,
      currentEpoch: 2,
      expectedAccessToken: aliceAccess,
      currentAccessToken: null,
      responseAccessToken: aliceRotated,
    }), 'discard');
  });

  it('discards late successful refresh after same-user re-login (new session survives)', () => {
    // JWT id unchanged; epoch bump is the session generation signal.
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 1,
      currentEpoch: 2,
      expectedAccessToken: aliceAccess,
      currentAccessToken: aliceRelogin,
      responseAccessToken: aliceRotated,
    }), 'discard');
  });

  it('discards late success after switching to another user', () => {
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      currentAccessToken: bobAccess,
      responseAccessToken: aliceRotated,
    }), 'discard');
  });

  it('discards late success whose JWT subject is not the expected account', () => {
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 1,
      currentEpoch: 1,
      expectedAccessToken: aliceAccess,
      currentAccessToken: aliceAccess,
      responseAccessToken: bobAccess,
    }), 'discard');
  });

  it('applies late success for the same account still in the same session', () => {
    assert.equal(shouldApplyRefreshResponse({
      startEpoch: 4,
      currentEpoch: 4,
      expectedAccessToken: aliceAccess,
      currentAccessToken: aliceAccess,
      responseAccessToken: aliceRotated,
    }), 'apply');
  });

  it('late 401 must not adopt after epoch bump (newer session intact)', () => {
    assert.equal(canAdoptPersistedAuth({
      startEpoch: 1,
      currentEpoch: 2,
      expectedAccessToken: aliceAccess,
      presentedRefreshToken: 'r-old-alice',
      persistedAccessToken: bobAccess,
      persistedRefreshToken: 'r-bob',
      adoptionAllowed: () => true,
    }), false);
  });

  it('persist adoption is denied after session replace until local refresh', async () => {
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a0', refreshToken: 'r0' }));
    assert.equal(isPersistedRefreshAdoptionAllowed('r-other'), true);
    const epochBefore = getAuthRefreshCoordinationEpoch();
    clearAuthRefreshCoordination('r0');
    assert.ok(getAuthRefreshCoordinationEpoch() > epochBefore);
    assert.equal(isPersistedRefreshAdoptionAllowed('r-other'), false);
    assert.equal(isPersistedRefreshAdoptionAllowed('r0'), false);
    await coordinateRefreshOwnership(async () => ({ accessToken: 'a1', refreshToken: 'r1' }));
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), true);
  });

  it('markLocalRefreshSuccess restores peer adoption only for the current epoch', () => {
    clearAuthRefreshCoordination('r-prior');
    const epoch = getAuthRefreshCoordinationEpoch();
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), false);
    assert.equal(
      markLocalRefreshSuccess({ accessToken: aliceRotated, refreshToken: 'r-local' }, epoch - 1),
      false,
      'stale epoch must not clear guards',
    );
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), false);
    assert.equal(isPersistedRefreshAdoptionAllowed('r-prior'), false, 'blocked prior preserved');
    assert.equal(
      markLocalRefreshSuccess({ accessToken: aliceRotated, refreshToken: 'r-local' }, epoch),
      true,
    );
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), true);
    assert.equal(isPersistedRefreshAdoptionAllowed('r-prior'), false, 'blocked prior still preserved');
  });

  it('failed or empty pairs do not clear session-replacement guards', () => {
    clearAuthRefreshCoordination('r-old');
    const epoch = getAuthRefreshCoordinationEpoch();
    assert.equal(markLocalRefreshSuccess({ accessToken: '', refreshToken: 'r-x' }, epoch), false);
    assert.equal(markLocalRefreshSuccess({ accessToken: aliceAccess, refreshToken: '' }, epoch), false);
    assert.equal(isPersistedRefreshAdoptionAllowed('r-peer'), false);
  });
});
