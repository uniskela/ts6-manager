/**
 * Document-lifetime safe-UI latch.
 *
 * Evaluated from `?safe-ui=1` before the first custom-CSS injection. Once true,
 * SPA navigations and query-string changes cannot re-activate custom CSS until
 * a full normal reload. The latch is never persisted and never erases CSS.
 */

let latched = false;
let evaluated = false;

export function isSafeUiQueryParam(search: string): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('safe-ui') === '1';
}

/**
 * Latch safe mode from the current location (or an explicit search string).
 * Safe to call repeatedly; only the first evaluation can set the latch when the
 * query is present. Subsequent calls never clear a latched true.
 */
export function evaluateSafeUiLatch(search?: string): boolean {
  if (!evaluated) {
    evaluated = true;
    const resolved =
      search ??
      (typeof window !== 'undefined' ? window.location.search : '');
    if (isSafeUiQueryParam(resolved)) {
      latched = true;
    }
  }
  return latched;
}

export function isSafeUiActive(): boolean {
  if (!evaluated) {
    return evaluateSafeUiLatch();
  }
  return latched;
}

/** Test-only: reset latch between Playwright/unit cases in the same document. */
export function resetSafeUiLatchForTests(): void {
  latched = false;
  evaluated = false;
}
