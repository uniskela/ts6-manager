import {
  MEDIA_COMMAND_GROUPS,
  mediaCommandGroup,
  type MediaCommandGroup,
  type MediaCommandPermissions,
} from '@ts6/common';
import type { PrismaClient } from '../../generated/prisma/index.js';

export interface MediaCommandIdentity {
  uid?: string | null;
  /** Resolve from TeamSpeak for this server; never accept client-supplied membership. */
  serverGroupIds?: readonly number[] | null;
}

export function defaultMediaCommandPermissions(): MediaCommandPermissions {
  return { playback: { mode: 'everyone' }, queue: { mode: 'everyone' }, video: { mode: 'everyone' } };
}

export function mediaCommandPermissionsKey(serverConfigId: number, virtualServerId: number): string {
  return `media_command_permissions:${serverConfigId}:${virtualServerId}`;
}

/** Full policy validation applies equally to admin updates and stored JSON. */
export function parseMediaCommandPermissions(raw: unknown): MediaCommandPermissions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const policy = defaultMediaCommandPermissions();
  if (Object.keys(obj).some((key) => !MEDIA_COMMAND_GROUPS.includes(key as MediaCommandGroup))) return null;
  for (const group of MEDIA_COMMAND_GROUPS) {
    const value = obj[group];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const access = value as Record<string, unknown>;
    if (access.mode === 'everyone' && Object.keys(access).length === 1) continue;
    if (access.mode !== 'server_groups' || Object.keys(access).some((key) => key !== 'mode' && key !== 'serverGroupIds')) return null;
    if (!Array.isArray(access.serverGroupIds) || access.serverGroupIds.length > 256
      || access.serverGroupIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) return null;
    policy[group] = { mode: 'server_groups', serverGroupIds: [...new Set(access.serverGroupIds as number[])] };
  }
  return policy;
}

export async function loadMediaCommandPermissions(
  prisma: PrismaClient, serverConfigId: number, virtualServerId: number,
): Promise<MediaCommandPermissions> {
  const row = await prisma.appSetting.findUnique({
    where: { key: mediaCommandPermissionsKey(serverConfigId, virtualServerId) },
  });
  // An absent policy preserves existing installations. An invalid saved restriction fails closed.
  if (!row) return defaultMediaCommandPermissions();
  try {
    const policy = parseMediaCommandPermissions(JSON.parse(row.value));
    if (policy) return policy;
  } catch { /* Malformed stored policy must not reopen restricted commands. */ }
  return {
    playback: { mode: 'server_groups', serverGroupIds: [] },
    queue: { mode: 'server_groups', serverGroupIds: [] },
    video: { mode: 'server_groups', serverGroupIds: [] },
  };
}

export async function saveMediaCommandPermissions(
  prisma: PrismaClient, serverConfigId: number, virtualServerId: number, raw: unknown,
): Promise<MediaCommandPermissions> {
  const policy = parseMediaCommandPermissions(raw);
  if (!policy) throw new Error('Invalid media command permissions');
  const key = mediaCommandPermissionsKey(serverConfigId, virtualServerId);
  const value = JSON.stringify(policy);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return policy;
}

/** Shared authorization boundary for chat and future listener actions. */
export function authorizeMediaCommandGroup(
  policy: MediaCommandPermissions, group: MediaCommandGroup, identity: MediaCommandIdentity,
): boolean {
  const access = policy[group];
  if (access.mode === 'everyone') return true;
  if (!identity.uid?.trim() || !identity.serverGroupIds) return false;
  return identity.serverGroupIds.some((id) => access.serverGroupIds.includes(id));
}

export function authorizeMediaCommand(
  policy: MediaCommandPermissions, command: string, identity: MediaCommandIdentity, args = '',
): boolean {
  const group = mediaCommandGroup(command, args);
  if (!group) return false;
  // Votes have their own current-listener eligibility check.
  return group === 'info' || group === 'listener' || authorizeMediaCommandGroup(policy, group, identity);
}
