import type { CommandResult } from './adapter.js';

const EPHEMERAL = 1 << 6;

/** Discord interaction callback payload (no webhook delivery). */
export type DiscordInteractionCallback = {
  type: number;
  data?: { content?: string; flags?: number };
};

export function discordPong(): DiscordInteractionCallback {
  return { type: 1 };
}

export function discordDeferredAck(ephemeral = true): DiscordInteractionCallback {
  return { type: 5, data: { flags: ephemeral ? EPHEMERAL : 0 } };
}

export function discordMessageFromResult(result: CommandResult): DiscordInteractionCallback {
  const flags = result.ephemeral ? EPHEMERAL : 0;
  const content = result.content || (result.ok ? 'Done.' : 'Command failed.');
  return { type: 4, data: { content, flags } };
}

export function safeCommandFailure(content = 'Command failed.'): CommandResult {
  return { ok: false, code: 'unavailable', ephemeral: true, content, ack: 'immediate' };
}
