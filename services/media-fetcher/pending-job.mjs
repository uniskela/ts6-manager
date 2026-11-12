/**
 * Resources created during submit() before the job is published to `jobs`.
 * Client disconnect during await ctl/startShim must abandon these so we never
 * leave a proxy grant, shim, or ffmpeg attached to a dead socket.
 */

export function createPendingJob() {
  return {
    jobId: null,
    shim: null,
    child: null,
    proxyRegistered: false,
  };
}

/**
 * Tear down a partial submit. Safe to call repeatedly / after promotion to a
 * real job (caller clears fields when promoting).
 */
export async function abandonPending(pending, { killTree, revokeJob }) {
  if (!pending) return;
  const child = pending.child;
  const shim = pending.shim;
  const jobId = pending.jobId;
  const proxyRegistered = pending.proxyRegistered;
  pending.child = null;
  pending.shim = null;
  pending.proxyRegistered = false;
  pending.jobId = null;
  if (child?.pid) {
    try { killTree(child.pid); } catch { /* gone */ }
  }
  try { await shim?.close(); } catch { /* gone */ }
  if (proxyRegistered && jobId) {
    try { await revokeJob(jobId); } catch { /* proxy down */ }
  }
}

/**
 * After an await: if the client already tore down, abandon pending work and
 * return false so the caller stops creating a live job.
 */
export async function continueIfClientAlive(life, pending, helpers) {
  if (!life?.done) return true;
  await abandonPending(pending, helpers);
  return false;
}
