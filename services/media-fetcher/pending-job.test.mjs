/**
 * Disconnect during async submit startup must abandon proxy/shim/ffmpeg
 * before a live job is published.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abandonPending,
  continueIfClientAlive,
  createPendingJob,
} from './pending-job.mjs';

function life(done) {
  return { get done() { return done; } };
}

describe('pending job startup abort', () => {
  it('abandons proxy grant registered before client disconnect', async () => {
    const revoked = [];
    const killed = [];
    const pending = createPendingJob();
    pending.jobId = 'proxy-race';
    pending.proxyRegistered = true;
    const closed = [];
    pending.shim = { close: async () => { closed.push('shim'); } };

    assert.equal(await continueIfClientAlive(life(true), pending, {
      killTree: (pid) => { killed.push(pid); },
      revokeJob: async (id) => { revoked.push(id); },
    }), false);

    assert.deepEqual(revoked, ['proxy-race']);
    assert.deepEqual(closed, ['shim']);
    assert.equal(pending.proxyRegistered, false);
    assert.equal(pending.jobId, null);
    assert.deepEqual(killed, []);
  });

  it('abandons shim after startShim when client already disconnected', async () => {
    const revoked = [];
    const pending = createPendingJob();
    pending.jobId = 'shim-race';
    pending.proxyRegistered = true;
    const closed = [];
    pending.shim = { close: async () => { closed.push('shim'); } };

    // Simulate: disconnect landed during await startShim
    assert.equal(await continueIfClientAlive(life(true), pending, {
      killTree: () => {},
      revokeJob: async (id) => { revoked.push(id); },
    }), false);
    assert.deepEqual(closed, ['shim']);
    assert.deepEqual(revoked, ['shim-race']);
  });

  it('kills ffmpeg spawned before the live-job handoff', async () => {
    const killed = [];
    const revoked = [];
    const pending = createPendingJob();
    pending.jobId = 'ff-race';
    pending.proxyRegistered = true;
    pending.shim = { close: async () => {} };
    pending.child = { pid: 4242 };

    await abandonPending(pending, {
      killTree: (pid) => { killed.push(pid); },
      revokeJob: async (id) => { revoked.push(id); },
    });
    assert.deepEqual(killed, [4242]);
    assert.deepEqual(revoked, ['ff-race']);
    assert.equal(pending.child, null);
  });

  it('continues when the client is still alive', async () => {
    const pending = createPendingJob();
    pending.jobId = 'live';
    pending.proxyRegistered = true;
    let revoked = 0;
    assert.equal(await continueIfClientAlive(life(false), pending, {
      killTree: () => {},
      revokeJob: async () => { revoked += 1; },
    }), true);
    assert.equal(revoked, 0);
    assert.equal(pending.proxyRegistered, true);
  });

  it('idempotent abandon across concurrent teardown and post-await check', async () => {
    const revoked = [];
    const pending = createPendingJob();
    pending.jobId = 'race';
    pending.proxyRegistered = true;
    pending.child = { pid: 7 };
    pending.shim = { close: async () => {} };
    const helpers = {
      killTree: () => {},
      revokeJob: async (id) => { revoked.push(id); },
    };
    await Promise.all([
      abandonPending(pending, helpers),
      abandonPending(pending, helpers),
      continueIfClientAlive(life(true), pending, helpers),
    ]);
    assert.deepEqual(revoked, ['race']);
  });

  it('does not create a live job after disconnect during proxy registration', async () => {
    const jobs = new Map();
    const pending = createPendingJob();
    pending.jobId = 'early';
    // Disconnect before proxyRegistered flips true — nothing to revoke.
    assert.equal(await continueIfClientAlive(life(true), pending, {
      killTree: () => {},
      revokeJob: async () => { throw new Error('should not revoke'); },
    }), false);
    assert.equal(jobs.size, 0);
  });
});
