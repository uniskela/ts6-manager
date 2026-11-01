import type { CommandResult, DiscordCommandIntent } from './adapter.js';
import { isMusicCommand } from './music.js';
import { verifyDiscordSignature } from './security.js';

type InteractionAdapter = { handle(intent: DiscordCommandIntent): Promise<CommandResult> };

export function planAcknowledgement(command: string): CommandResult['ack'] {
  return isMusicCommand(command) ? 'deferred' : 'immediate';
}

function commandFromData(data: { name?: string; options?: Array<{ name?: string }> } | undefined): string {
  if (!data?.name) return '';
  const sub = data.options?.[0]?.name;
  if (data.name === 'ts' && sub) return `ts.${sub}`;
  return data.name;
}

export function parseInteractionBody(body: string): DiscordCommandIntent | { ping: true } | null {
  try {
    const parsed = JSON.parse(body) as {
      type?: number;
      guild_id?: string;
      member?: { user?: { id?: string }; roles?: string[]; permissions?: string };
      data?: { name?: string; options?: Array<{ name?: string }> };
    };
    if (parsed.type === 1) return { ping: true };
    if (parsed.type !== 2) return null;
    const command = commandFromData(parsed.data);
    if (!command || !parsed.guild_id || !parsed.member?.user?.id) return null;
    return {
      guildId: parsed.guild_id,
      userId: parsed.member.user.id,
      roleIds: parsed.member.roles ?? [],
      memberPermissions: parsed.member.permissions ?? '0',
      command,
    };
  } catch {
    return null;
  }
}

export async function handleSignedInteraction(opts: {
  publicKeyHex: string;
  timestamp: string;
  body: string;
  signatureHex: string;
  adapter: InteractionAdapter;
  nowMs?: number;
}): Promise<CommandResult> {
  const verified = verifyDiscordSignature({
    publicKeyHex: opts.publicKeyHex,
    timestamp: opts.timestamp,
    body: opts.body,
    signatureHex: opts.signatureHex,
    nowMs: opts.nowMs,
  });
  if (!verified.ok) {
    return { ok: false, code: verified.code, ephemeral: true, content: 'Invalid signature.', ack: 'immediate' };
  }
  const parsed = parseInteractionBody(opts.body);
  if (parsed && 'ping' in parsed) {
    return { ok: true, ephemeral: false, content: '', ack: 'pong' };
  }
  if (!parsed) {
    return { ok: false, code: 'unauthorized', ephemeral: true, content: 'Unsupported interaction.', ack: 'immediate' };
  }
  return opts.adapter.handle(parsed);
}
