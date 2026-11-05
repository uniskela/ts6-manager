/**
 * Production Discord command audit. Writes AdminAuditEvent rows with
 * allow-listed fields only — never option values, tokens, URLs, or raw errors.
 * Failures are swallowed so audit outages cannot deny slash commands.
 */

import { randomUUID } from 'node:crypto';
import type { AdminAuditOutcome, AdminAuditResultCode } from '@ts6/common';
import { buildRow } from '../audit/writer.js';

export type DiscordCommandAuditEvent = {
  guildId: string;
  userId: string;
  command: string;
  result: string;
};

type AuditPrisma = {
  adminAuditEvent: {
    create(args: { data: ReturnType<typeof buildRow> }): Promise<unknown>;
  };
};

/** Map adapter result codes onto the allow-listed AdminAuditResultCode set. */
const RESULT_MAP: Record<string, AdminAuditResultCode> = {
  ok: 'ok',
  rate_limited: 'rate_limited',
  unpaired: 'invalid_access',
  unauthorized: 'permission_denied',
  unavailable: 'unavailable',
  not_found: 'not_found',
  permission_denied: 'permission_denied',
  invalid_request: 'invalid_request',
  cancelled: 'cancelled',
  timeout: 'timeout',
};

function snowflake(id: string): string {
  const digits = id.replace(/\D/g, '').slice(0, 20);
  return digits || '0';
}

function commandToken(command: string): string {
  return command.replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'unknown';
}

function mapResult(result: string): { outcome: AdminAuditOutcome; resultCode: AdminAuditResultCode } {
  if (result === 'ok') return { outcome: 'success', resultCode: 'ok' };
  const code = RESULT_MAP[result];
  if (code) return { outcome: 'failure', resultCode: code };
  return { outcome: 'failure', resultCode: 'unknown' };
}

/** Build a sync audit callback for createDiscordCommandAdapter. */
export function createDiscordCommandAudit(prisma: AuditPrisma): (event: DiscordCommandAuditEvent) => void {
  return (event) => {
    void writeDiscordCommandAudit(prisma, event).catch((err) => {
      console.warn(
        `[discord-cmd] audit write failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    });
  };
}

export async function writeDiscordCommandAudit(
  prisma: AuditPrisma,
  event: DiscordCommandAuditEvent,
): Promise<void> {
  const { outcome, resultCode } = mapResult(event.result);
  const guild = snowflake(event.guildId);
  const user = snowflake(event.userId);
  const command = commandToken(event.command);
  // targetId holds command + guild only (no options). Cap is enforced in buildRow.
  const targetId = `${command}@${guild}`;
  await prisma.adminAuditEvent.create({
    data: buildRow({
      actor: { id: 0, username: `discord:${user}` },
      action: 'discord.command',
      connectionId: null,
      virtualServerId: null,
      target: { type: 'discord_guild', id: targetId },
      operationId: randomUUID(),
      outcome,
      resultCode,
      completedAt: new Date(),
    }),
  });
}
