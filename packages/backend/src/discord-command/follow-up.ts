import type { CommandResult } from './adapter.js';

/**
 * Final delivery after a deferred Discord interaction ack (type 5).
 * Step 1 records only — no Discord webhook calls.
 */
export type DiscordDeferredFollowUpJob = {
  interactionId?: string;
  guildId: string;
  userId: string;
  command: string;
  result: CommandResult;
};

export type DiscordInteractionFollowUp = {
  afterDeferred(job: DiscordDeferredFollowUpJob): Promise<void>;
};

/**
 * Deterministic **test / local stub** only. Never talks to Discord.
 * Must be injected explicitly — do not treat as production webhook delivery.
 */
export class MemoryDiscordFollowUp implements DiscordInteractionFollowUp {
  readonly jobs: DiscordDeferredFollowUpJob[] = [];

  async afterDeferred(job: DiscordDeferredFollowUpJob): Promise<void> {
    this.jobs.push(job);
  }
}
