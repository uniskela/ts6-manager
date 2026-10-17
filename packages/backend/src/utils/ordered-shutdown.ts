/**
 * Run shutdown steps one after another under one deadline. Resolves true when
 * every step finished in time, false when the deadline passed first. A step
 * never starts before the previous one finished, even after the deadline
 * (the caller exits then), so a later step never runs alongside an earlier one.
 */
export async function runInOrderWithin(steps: ReadonlyArray<() => Promise<unknown>>, deadlineMs: number): Promise<boolean> {
  const all = (async () => {
    for (const step of steps) await step();
    return true;
  })();
  const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), deadlineMs).unref());
  return Promise.race([all, timer]);
}
