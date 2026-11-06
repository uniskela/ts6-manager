import type { CommandResult } from './adapter.js';

/**
 * Final delivery after a deferred Discord interaction ack (type 5).
 * Production uses Edit Original Interaction Response (PATCH …/messages/@original).
 */
export type DiscordDeferredFollowUpJob = {
  interactionId?: string;
  guildId: string;
  userId: string;
  command: string;
  result: CommandResult;
  /**
   * Application snowflake verified against trusted config.
   * Required for webhook delivery; Memory stub may omit in older unit tests.
   */
  applicationId?: string;
  /**
   * Interaction token from the previously signature-verified body only.
   * Never log this value.
   */
  interactionToken?: string;
  /** Trusted server clock when the interaction was accepted (token TTL anchor). */
  receivedAtMs?: number;
};

export type DiscordInteractionFollowUp = {
  afterDeferred(job: DiscordDeferredFollowUpJob): Promise<void>;
  /** Optional: cancel in-flight deliveries on shutdown. */
  dispose?(): void;
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
