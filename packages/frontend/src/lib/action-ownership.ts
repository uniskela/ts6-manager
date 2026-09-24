/**
 * Immutable mutation ownership for Slice 6 PR1.
 *
 * Capture target identity when an action starts; validate before applying
 * success side-effects so a context switch cannot redirect a pending action
 * or close another target's dialog / mark an edited draft as tested.
 */

export type FileActionTarget = {
  configId: number;
  sid: number;
  cid: number;
  fullPath: string;
  ownerGeneration: number;
  /** Display name for confirm dialogs (not used for dispatch). */
  entryName: string;
};

export type InstanceSaveTarget = {
  configId: number;
  ownerGeneration: number;
  data: Record<string, number>;
};

export type JournalTargetToggle = {
  configId: number;
  sid: number;
  enabled: boolean;
  ownerGeneration: number;
};

export type ConnectionTestOwner = {
  ownerGeneration: number;
  /** Stable fingerprint of credentials under test. */
  draftKey: string;
};

export function sameFileActionTarget(
  left: Pick<FileActionTarget, 'configId' | 'sid' | 'cid' | 'fullPath' | 'ownerGeneration'>,
  right: Pick<FileActionTarget, 'configId' | 'sid' | 'cid' | 'fullPath' | 'ownerGeneration'>,
): boolean {
  return left.configId === right.configId
    && left.sid === right.sid
    && left.cid === right.cid
    && left.fullPath === right.fullPath
    && left.ownerGeneration === right.ownerGeneration;
}

export function buildFilePath(currentPath: string, entryName: string): string {
  if (currentPath === '/') return `/${entryName}`;
  return `${currentPath}/${entryName}`;
}

/**
 * Confirm may dispatch only while the live browser still sits on the dialog's
 * owner connection/SID/channel. Switching context cancels confirmation so the
 * request cannot be aimed at the new selection (scenario 1).
 */
export function canConfirmFileAction(
  dialogTarget: FileActionTarget | null,
  live: { configId: number | null; sid: number | null; cid: number | null },
): dialogTarget is FileActionTarget {
  if (!dialogTarget || live.configId == null || live.sid == null || live.cid == null) {
    return false;
  }
  return dialogTarget.configId === live.configId
    && dialogTarget.sid === live.sid
    && dialogTarget.cid === live.cid;
}

/**
 * After a mutation completes, only close/reset UI that still belongs to the
 * submitted target. A newly opened dialog for another target must stay open.
 */
export function shouldCloseFileDialog(
  dialogTarget: FileActionTarget | null,
  submitted: Pick<FileActionTarget, 'configId' | 'sid' | 'cid' | 'fullPath' | 'ownerGeneration'>,
): boolean {
  if (!dialogTarget) return false;
  return sameFileActionTarget(dialogTarget, submitted);
}

export function shouldClearInstanceDraft(
  draftConfigId: number | null,
  submittedConfigId: number,
  draftGeneration: number,
  submittedGeneration: number,
): boolean {
  return draftConfigId === submittedConfigId && draftGeneration === submittedGeneration;
}

/** Drop only the keys that were part of the submitted save; keep newer edits. */
export function mergeClearedInstanceFields(
  current: Record<string, string>,
  submittedKeys: string[],
): Record<string, string> {
  if (submittedKeys.length === 0) return current;
  const next = { ...current };
  for (const key of submittedKeys) delete next[key];
  return next;
}

export function shouldApplyJournalToggleResult(
  live: { configId: number | null; sid: number | null; ownerGeneration: number },
  submitted: Pick<JournalTargetToggle, 'configId' | 'sid' | 'ownerGeneration'>,
): boolean {
  return live.configId === submitted.configId
    && live.sid === submitted.sid
    && live.ownerGeneration === submitted.ownerGeneration;
}

export function connectionDraftKey(parts: {
  host: string;
  webqueryPort: string;
  apiKey: string;
  useHttps: boolean;
  sshPort: string;
  sshUsername: string;
  sshPassword: string;
}): string {
  return [
    parts.host.trim(),
    parts.webqueryPort.trim(),
    parts.apiKey,
    parts.useHttps ? '1' : '0',
    parts.sshPort.trim(),
    parts.sshUsername,
    parts.sshPassword,
  ].join('\0');
}

/**
 * A successful connection-test response applies only when the draft generation
 * (and credential fingerprint) still match what was submitted. Editing the
 * form bumps generation so an obsolete success leaves the draft untested.
 */
export function shouldApplyConnectionTestResult(
  live: ConnectionTestOwner,
  submitted: ConnectionTestOwner,
): boolean {
  return live.ownerGeneration === submitted.ownerGeneration
    && live.draftKey === submitted.draftKey;
}

export function sameJournalTarget(
  live: { configId: number | null; sid: number | null },
  submitted: Pick<JournalTargetToggle, 'configId' | 'sid'> | undefined,
): boolean {
  if (!submitted || live.configId == null || live.sid == null) return false;
  return live.configId === submitted.configId && live.sid === submitted.sid;
}
