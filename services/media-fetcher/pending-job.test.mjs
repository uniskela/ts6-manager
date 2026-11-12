/**
 * Disconnect during async submit startup must abandon proxy/shim/ffmpeg
 * before a live job is published — including when ctl registration resolves
 * after teardown.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abandonPending,
  clearUnregisteredJobId,
  continueIfClientAlive,
  createPendingJob,
  noteProxyRegistered,
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

  it('retains jobId when disconnect hits before registration completes', async () => {
    const pending = createPendingJob();
    pending.jobId = 'early';
    assert.equal(await continueIfClientAlive(life(true), pending, {
      killTree: () => {},
      revokeJob: async () => { throw new Error('should not revoke before 201'); },
    }), false);
    assert.equal(pending.abandoned, true);
    assert.equal(pending.jobId, 'early');
    assert.equal(pending.proxyRegistered, false);
  });
});

describe('deferred proxy registration after disconnect', () => {
  it('revokes exactly once when HTTP 201 arrives after teardown', async () => {
    const revoked = [];
    const jobs = new Map();
    const pending = createPendingJob();
    pending.jobId = 'late-grant';
    const helpers = {
      killTree: () => {},
      revokeJob: async (id) => { revoked.push(id); },
    };

    // 1) Begin registration but keep it unresolved.
    let resolveReg;
    const regPromise = new Promise((resolve) => { resolveReg = resolve; });

    // 2) Socket teardown while ctl is in flight.
    await abandonPending(pending, helpers);
    assert.equal(pending.abandoned, true);
    assert.equal(pending.jobId, 'late-grant');
    assert.deepEqual(revoked, []);

    // 3) No live job published.
    assert.equal(jobs.size, 0);

    // 4) Registration succeeds with HTTP 201 after disconnect.
    resolveReg({ status: 201 });
    const reg = await regPromise;
    assert.equal(reg.status, 201);
    assert.equal(await noteProxyRegistered(pending, helpers), false);

    // 5–6) Grant revoked once; pending released.
    assert.deepEqual(revoked, ['late-grant']);
    assert.equal(pending.jobId, null);
    assert.equal(pending.proxyRegistered, false);
    assert.equal(pending.shim, null);
    assert.equal(pending.child, null);

    // 7) A subsequent job can start (fresh pending).
    const next = createPendingJob();
    next.jobId = 'after-late';
    assert.equal(await noteProxyRegistered(next, helpers), true);
    assert.equal(next.proxyRegistered, true);
    assert.deepEqual(revoked, ['late-grant']);
    jobs.set(next.jobId, { id: next.jobId });
    assert.equal(jobs.size, 1);
  });

  it('does not revoke when registration is rejected after disconnect', async () => {
    const revoked = [];
    const pending = createPendingJob();
    pending.jobId = 'reject-late';
    const helpers = {
      killTree: () => {},
      revokeJob: async (id) => { revoked.push(id); },
    };
    await abandonPending(pending, helpers);
    assert.equal(pending.jobId, 'reject-late');
    clearUnregisteredJobId(pending);
    assert.equal(pending.jobId, null);
    assert.deepEqual(revoked, []);
  });

  it('concurrent noteProxyRegistered and abandonPending revoke once', async () => {
    const revoked = [];
    const pending = createPendingJob();
    pending.jobId = 'concurrent';
    const helpers = {
      killTree: () => {},
      revokeJob: async (id) => {
        revoked.push(id);
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    // Registration completes and teardown race.
    const a = noteProxyRegistered(pending, helpers);
    const b = abandonPending(pending, helpers);
    await Promise.all([a, b]);
    // Either noteProxyRegistered saw abandoned after setting flag, or abandon
    // saw proxyRegistered — grant cleaned exactly once.
    assert.deepEqual(revoked, ['concurrent']);
    assert.equal(pending.jobId, null);
    assert.equal(pending.proxyRegistered, false);
  });
});
