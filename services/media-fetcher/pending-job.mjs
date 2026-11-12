/**
 * Resources created during submit() before the job is published to `jobs`.
 * Client disconnect during await ctl/startShim must abandon these so we never
 * leave a proxy grant, shim, or ffmpeg attached to a dead socket.
 *
 * jobId is retained while proxy registration may still complete: abandon before
 * HTTP 201 must not drop responsibility for a grant that arrives afterward.
 */

export function createPendingJob() {
  return {
    jobId: null,
    shim: null,
    child: null,
    proxyRegistered: false,
    abandoned: false,
  };
}

/**
 * Tear down a partial submit. Safe to call repeatedly / after promotion to a
 * real job (caller clears fields when promoting).
 *
 * Does not clear jobId until a registered grant has been revoked — an in-flight
 * ctl POST may still return 201 after this returns.
 */
export async function abandonPending(pending, { killTree, revokeJob }) {
  if (!pending) return;
  pending.abandoned = true;
  const child = pending.child;
  const shim = pending.shim;
  pending.child = null;
  pending.shim = null;
  if (child?.pid) {
    try { killTree(child.pid); } catch { /* gone */ }
  }
  try { await shim?.close(); } catch { /* gone */ }
  if (pending.proxyRegistered && pending.jobId) {
    const id = pending.jobId;
    pending.jobId = null;
    pending.proxyRegistered = false;
    try { await revokeJob(id); } catch { /* proxy down */ }
  }
}

/**
 * Mark that proxy registration succeeded (HTTP 201).
 * If the client already abandoned, revoke immediately and return false.
 */
export async function noteProxyRegistered(pending, helpers) {
  if (!pending) return false;
  pending.proxyRegistered = true;
  if (pending.abandoned) {
    await abandonPending(pending, helpers);
    return false;
  }
  return true;
}

/** Drop jobId after a failed / non-creating registration (no grant exists). */
export function clearUnregisteredJobId(pending) {
  if (!pending || pending.proxyRegistered) return;
  pending.jobId = null;
}

/**
 * After an await: if the client already tore down, abandon pending work and
 * return false so the caller stops creating a live job.
 */
export async function continueIfClientAlive(life, pending, helpers) {
  if (!life?.done && !pending?.abandoned) return true;
  await abandonPending(pending, helpers);
  return false;
}
