/**
 * Slice 6 PR4 — action-local compatibility / permission guidance.
 * Read success (browse, list, diagnostic permissions stage) never implies write authorization.
 */

import { apiErrorMessage } from './api-error';

export type FileActionKind = 'browse' | 'create' | 'delete';

export type ActionPrerequisiteKind =
  | 'ssh_required'
  | 'ssh_failed'
  | 'permission_denied'
  | 'generic';

/** Shown beside write actions when the user already listed the folder successfully. */
export const FILE_WRITE_READ_DOES_NOT_AUTHORIZE =
  'Browsing this folder does not confirm permission to create or delete files.';

/** Shown under a successful WebQuery permissions diagnostic stage. */
export const DIAGNOSTIC_READ_DOES_NOT_AUTHORIZE_WRITES =
  'Confirms management read access only — not write authorization for kicks, bans, file changes, or settings.';

function errorPayloadText(error: unknown): string {
  const err = error as { response?: { data?: Record<string, unknown> }; message?: string };
  const data = err?.response?.data ?? {};
  return `${data.error || ''} ${data.details || ''} ${data.reason || ''} ${err?.message || ''}`.toLowerCase();
}

export function classifyActionPrerequisite(error: unknown): ActionPrerequisiteKind {
  const err = error as { response?: { data?: Record<string, unknown> } };
  const data = err?.response?.data ?? {};
  const reason = String(data.reason || '');
  const code = Number(data.code);
  const text = errorPayloadText(error);

  if (reason === 'ts_permission_denied' || code === 2568 || text.includes('insufficient')) {
    return 'permission_denied';
  }
  if (
    text.includes('ssh credentials not configured')
    || text.includes('ssh not connected')
    || text.includes('webquery http does not support')
  ) {
    return 'ssh_required';
  }
  if (text.includes('ssh')) {
    return 'ssh_failed';
  }
  return 'generic';
}

/** Human-readable prerequisite / permission copy for file browser list failures. */
export function fileBrowseErrorMessage(error: unknown): string {
  switch (classifyActionPrerequisite(error)) {
    case 'ssh_required':
      return 'File browsing requires SSH access because the TeamSpeak WebQuery HTTP API does not support file transfer commands. Configure SSH credentials (username and password) in server settings.';
    case 'ssh_failed':
      return 'Could not connect to TeamSpeak via SSH. Check the SSH credentials and port in server settings.';
    case 'permission_denied':
      return 'The Query identity lacks permission to list files in this channel. WebQuery read success does not grant file-transfer access.';
    default:
      return apiErrorMessage(error, 'Failed to load files. Ensure SSH credentials are configured in server settings.');
  }
}

/** Human-readable errors for mkdir / delete — never treat browse success as write auth. */
export function fileWriteErrorMessage(error: unknown, action: 'create' | 'delete'): string {
  const verb = action === 'create' ? 'create directories' : 'delete files';
  switch (classifyActionPrerequisite(error)) {
    case 'ssh_required':
      return `Cannot ${verb}: SSH is required for file changes (WebQuery HTTP does not support ft* commands).`;
    case 'ssh_failed':
      return `Cannot ${verb}: SSH connection failed. Check SSH credentials and port in server settings.`;
    case 'permission_denied':
      return `Insufficient TeamSpeak permission to ${verb}. Listing this folder does not authorize writes — grant the Query identity the required file-transfer permissions.`;
    default:
      return apiErrorMessage(error, action === 'create' ? 'Failed to create directory' : 'Failed to delete file');
  }
}

export function fileDeleteConfirmDescription(entryName: string, fullPath: string): string {
  return `Are you sure you want to delete "${entryName}" (${fullPath})? This cannot be undone. ${FILE_WRITE_READ_DOES_NOT_AUTHORIZE}`;
}

/**
 * Success toast for staged WebQuery diagnostics.
 * Must not claim write / admin mutation authorization.
 */
export function diagnosticSuccessToastMessage(version?: string): string {
  return version
    ? `WebQuery read stages OK (${version}) — write actions still need their own permissions`
    : 'WebQuery read stages succeeded — write actions still need their own permissions';
}

export function claimsWriteAuthorization(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('write')) {
    // Explicit "not write" / "still need" disclaimers are allowed.
    if (
      lower.includes('not write')
      || lower.includes('does not')
      || lower.includes('still need')
      || lower.includes('only')
    ) {
      return false;
    }
    return true;
  }
  return (
    lower.includes('full admin')
    || lower.includes('authorized to modify')
    || lower.includes('write authorization granted')
  );
}
