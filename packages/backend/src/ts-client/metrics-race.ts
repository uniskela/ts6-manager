/**
 * Non-blocking dashboard composition helpers (Codex Job 2).
 *
 * Start WebQuery + metrics together. When WebQuery completes, use metrics only
 * if already settled; otherwise return WebQuery immediately and cancel the
 * outstanding scrape (do not Promise.all-wait on metrics).
 */

export type TrackedPromise<T> = {
  promise: Promise<T>;
  /** True once the underlying promise has fulfilled or rejected. */
  isSettled: () => boolean;
  /** Fulfillment value when settled successfully; undefined if pending or rejected. */
  value: () => T | undefined;
  /** True when settled with rejection. */
  isRejected: () => boolean;
};

/**
 * Wrap a promise so callers can poll settlement synchronously after an await
 * gap (e.g. after WebQuery finishes) without racing an already-resolved sentinel.
 */
export function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
  let settled = false;
  let rejected = false;
  let value: T | undefined;

  const tracked = promise.then(
    (v) => {
      settled = true;
      value = v;
      return v;
    },
    (err) => {
      settled = true;
      rejected = true;
      throw err;
    },
  );

  // Prevent unhandled rejection if the caller abandons after cancel.
  void tracked.catch(() => undefined);

  return {
    promise: tracked,
    isSettled: () => settled,
    value: () => value,
    isRejected: () => rejected,
  };
}

/**
 * After WebQuery is ready: take metrics if already settled, else cancel and
 * return `cancelledValue` without awaiting the outstanding metrics promise.
 */
export function takeTrackedIfReadyOrCancel<T>(
  tracked: TrackedPromise<T>,
  cancel: () => void,
  cancelledValue: T,
): T {
  if (tracked.isSettled() && !tracked.isRejected()) {
    return tracked.value() as T;
  }
  if (tracked.isSettled() && tracked.isRejected()) {
    // Already failed — no need to cancel; caller should have normalized errors.
    // Fall through to cancelledValue only if value missing; prefer re-reading
    // via a sync path is impossible on rejection, so return cancelledValue and
    // still cancel defensively.
    cancel();
    return cancelledValue;
  }

  cancel();
  return cancelledValue;
}
