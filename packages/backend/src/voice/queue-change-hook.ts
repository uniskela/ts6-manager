import type { QueueItem } from './playlist/queue.js';

/** Everything the queue-change hook reads, as accessors so it always sees live bot state. */
export interface QueueChangeHookDeps {
  automation(): { configuration: { enabled: boolean }; requestQueued(): void; reconcile(): Promise<unknown> | unknown } | undefined;
  isConnected(): boolean;
  nowPlaying(): QueueItem | null;
  hasVideoSession(): boolean;
  next(): QueueItem | null;
  play(item: QueueItem): Promise<unknown>;
  emitError(err: unknown): void;
}

/** Queue callback: with Auto-DJ on, a plain insertion into an idle bot starts the next item. */
export function createQueueChangeHook(deps: QueueChangeHookDeps): (added: boolean) => void {
  return (added) => {
    const preempted = added && deps.automation()?.configuration.enabled;
    if (added) deps.automation()?.requestQueued();
    // Let the caller select/start its item before advancing a plain queue insertion.
    queueMicrotask(() => {
      if (preempted && deps.isConnected() && !deps.nowPlaying() && !deps.hasVideoSession()) {
        const next = deps.next();
        if (next) deps.play(next).catch(err => deps.emitError(err));
      }
      void deps.automation()?.reconcile();
    });
  };
}
