import type { CommandResult, DiscordCommandIntent } from './adapter.js';
import { verifyDiscordSignature } from './security.js';

type InteractionAdapter = { handle(intent: DiscordCommandIntent): Promise<CommandResult> };

export function planAcknowledgement(command: string): CommandResult['ack'] {
  return command === 'play' || command === 'playlist' || command === 'radio' ? 'deferred' : 'immediate';
}

type InteractionOption = { name?: string; value?: unknown; options?: InteractionOption[] };

function commandFromData(data: { name?: string; options?: InteractionOption[] } | undefined): string {
  if (!data?.name) return '';
  const sub = data.options?.[0]?.name;
  if (data.name === 'ts' && sub) return `ts.${sub}`;
  return data.name;
}

function collectArgs(options: InteractionOption[] | undefined, args: Record<string, string> = {}): Record<string, string> {
  for (const option of options ?? []) {
    if (!option || typeof option.name !== 'string') continue;
    if (typeof option.value === 'string') args[option.name] = option.value;
    else if (option.options) {
      if (!args.subcommand) args.subcommand = option.name;
      collectArgs(option.options, args);
    }
  }
  return args;
}

/** Signed interaction envelope: intent stays free of delivery secrets for adapters/audit. */
export type ParsedInteractionEnvelope =
  | { ping: true }
  | {
    intent: DiscordCommandIntent;
    /** Present on real Discord payloads; required before type-5 ack. */
    applicationId: string | null;
    interactionToken: string | null;
  };

/**
 * Parse a Discord interaction body into intent + optional delivery fields.
 * Token/application_id are extracted when present; deferred HTTP requires both.
 */
export function parseInteractionEnvelope(body: string): ParsedInteractionEnvelope | null {
  try {
    const parsed = JSON.parse(body) as {
      type?: number;
      id?: unknown;
      application_id?: unknown;
      token?: unknown;
      guild_id?: string;
      member?: { user?: { id?: string }; roles?: string[]; permissions?: string };
      data?: { name?: string; options?: InteractionOption[] };
    };
    if (parsed.type === 1) return { ping: true };
    if (parsed.type !== 2) return null;
    const command = commandFromData(parsed.data);
    if (!command || !parsed.guild_id || !parsed.member?.user?.id) return null;
    const applicationId = typeof parsed.application_id === 'string' && parsed.application_id.trim()
      ? parsed.application_id.trim()
      : null;
    const interactionToken = typeof parsed.token === 'string' && parsed.token.length > 0
      ? parsed.token
      : null;
    const args = collectArgs(parsed.data?.options);
    return {
      intent: {
        guildId: parsed.guild_id,
        userId: parsed.member.user.id,
        roleIds: parsed.member.roles ?? [],
        memberPermissions: parsed.member.permissions ?? '0',
        command,
        args,
        idempotencyKey: typeof parsed.id === 'string' ? parsed.id : undefined,
      },
      applicationId,
      interactionToken,
    };
  } catch {
    return null;
  }
}

export function parseInteractionBody(body: string): DiscordCommandIntent | { ping: true } | null {
  const envelope = parseInteractionEnvelope(body);
  if (!envelope) return null;
  if ('ping' in envelope) return envelope;
  return envelope.intent;
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
