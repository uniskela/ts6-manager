import type { CommandResult } from './adapter.js';
import { truncateDiscordContent } from './discord-delivery.js';

const EPHEMERAL = 1 << 6;

/** Discord interaction callback payload (no webhook delivery). */
export type DiscordInteractionCallback = {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    allowed_mentions?: { parse: [] };
  };
};

export function discordPong(): DiscordInteractionCallback {
  return { type: 1 };
}

export function discordDeferredAck(ephemeral = true): DiscordInteractionCallback {
  return { type: 5, data: { flags: ephemeral ? EPHEMERAL : 0 } };
}

export function discordMessageFromResult(result: CommandResult): DiscordInteractionCallback {
  const flags = result.ephemeral ? EPHEMERAL : 0;
  const content = truncateDiscordContent(result.content || (result.ok ? 'Done.' : 'Command failed.'));
  // Suppress @everyone, role and user mentions originating from media titles,
  // TeamSpeak names, playlists, or other externally controlled content.
  return { type: 4, data: { content, flags, allowed_mentions: { parse: [] } } };
}

export function safeCommandFailure(content = 'Command failed.'): CommandResult {
  return { ok: false, code: 'unavailable', ephemeral: true, content, ack: 'immediate' };
}
