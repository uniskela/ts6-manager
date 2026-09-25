/**
 * Shared pacing for cosmetic WebQuery `channeledit` traffic (animations + cron
 * Server Stats / FlowRunner). TeamSpeak instance antiflood is shared across
 * WebQuery and SSH — clustered renames during boot or cron bursts trip 524.
 */

export const MIN_GLOBAL_CHANNEL_EDIT_GAP_MS = 3_000;

export class ChannelEditPacer {
  private lastAt = 0;

  /** Milliseconds until the next channel edit is allowed (0 = free to go). */
  remainingMs(now = Date.now()): number {
    if (this.lastAt <= 0) return 0;
    return Math.max(0, MIN_GLOBAL_CHANNEL_EDIT_GAP_MS - (now - this.lastAt));
  }

  /** Reserve the global slot immediately (call before awaiting the edit). */
  mark(now = Date.now()): void {
    this.lastAt = now;
  }

  /** Wait out any remaining gap, then mark. */
  async waitAndMark(): Promise<void> {
    // Recheck after each sleep: a concurrent direct mark() may have moved the reservation.
    for (;;) {
      const rem = this.remainingMs();
      if (rem <= 0) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, rem);
      });
    }
    this.mark();
  }

  /** Test helper — clear history between cases. */
  reset(): void {
    this.lastAt = 0;
  }
}

/** Process-wide pacer for WebQuery channel edits (AnimationManager + FlowRunner). */
export const webQueryChannelEditPacer = new ChannelEditPacer();
