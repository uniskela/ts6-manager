/**
 * Administrative audit writer (#91 Slice 4).
 *
 * Secret-free typed constructors only — never serialize request bodies,
 * raw URLs, headers, responses, flow JSON, credentials, or exception text.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_OUTCOMES,
  ADMIN_AUDIT_RESULT_CODES,
  ADMIN_AUDIT_TARGET_TYPES,
  type AdminAuditAction,
  type AdminAuditOutcome,
  type AdminAuditResultCode,
  type AdminAuditTargetType,
} from '@ts6/common';
import { AppError } from '../middleware/error-handler.js';

export const AUDIT_RETENTION_MAX_AGE_DAYS = 30;
export const AUDIT_RETENTION_MAX_ROWS = 100_000;
export const AUDIT_RETENTION_DELETE_CHUNK = 500;

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export interface AuditActor {
  id: number;
  username: string;
}

export interface AuditTarget {
  type: AdminAuditTargetType;
  id?: string | number | null;
}

interface BaseEventInput {
  actor: AuditActor;
  action: AdminAuditAction;
  connectionId?: number | null;
  virtualServerId?: number | null;
  target?: AuditTarget | null;
}

function assertAction(action: string): AdminAuditAction {
  if (!(ADMIN_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new AppError(500, 'Invalid audit action');
  }
  return action as AdminAuditAction;
}

function assertOutcome(outcome: string): AdminAuditOutcome {
  if (!(ADMIN_AUDIT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new AppError(500, 'Invalid audit outcome');
  }
  return outcome as AdminAuditOutcome;
}

function assertResultCode(code: string | null | undefined): AdminAuditResultCode | null {
  if (code == null) return null;
  if (!(ADMIN_AUDIT_RESULT_CODES as readonly string[]).includes(code)) {
    return 'unknown';
  }
  return code as AdminAuditResultCode;
}

function assertTargetType(type: string | null | undefined): AdminAuditTargetType | null {
  if (type == null) return null;
  if (!(ADMIN_AUDIT_TARGET_TYPES as readonly string[]).includes(type)) {
    throw new AppError(500, 'Invalid audit target type');
  }
  return type as AdminAuditTargetType;
}

function normalizeTargetId(id: string | number | null | undefined): string | null {
  if (id == null || id === '') return null;
  const s = String(id);
  // Hard cap — never store long secret-looking values
  if (s.length > 64) return s.slice(0, 64);
  return s;
}

function buildRow(input: BaseEventInput & {
  operationId: string;
  outcome: AdminAuditOutcome;
  resultCode?: AdminAuditResultCode | null;
  completedAt?: Date | null;
}) {
  const action = assertAction(input.action);
  const outcome = assertOutcome(input.outcome);
  const targetType = assertTargetType(input.target?.type ?? null);
  return {
    operationId: input.operationId,
    actorUserId: input.actor.id,
    actorUsername: input.actor.username.slice(0, 128),
    action,
    connectionId: input.connectionId ?? null,
    virtualServerId: input.virtualServerId ?? null,
    targetType,
    targetId: normalizeTargetId(input.target?.id),
    outcome,
    resultCode: assertResultCode(input.resultCode),
    completedAt: input.completedAt ?? null,
  };
}

export interface AuditAttemptHandle {
  operationId: string;
  eventId: string;
}

/**
 * Persist a pending attempt before a TeamSpeak (or other remote) dispatch.
 * Fail-closed: if this throws, the caller must not dispatch.
 */
export async function beginRemoteAttempt(
  prisma: PrismaLike,
  input: BaseEventInput,
): Promise<AuditAttemptHandle> {
  const operationId = randomUUID();
  const row = buildRow({
    ...input,
    operationId,
    outcome: 'pending',
    resultCode: null,
    completedAt: null,
  });
  const created = await prisma.adminAuditEvent.create({ data: row });
  return { operationId, eventId: created.id };
}

/**
 * Complete a remote attempt with a terminal outcome.
 * Never retries the original mutation.
 */
export async function completeRemoteAttempt(
  prisma: PrismaLike,
  operationId: string,
  completion: {
    outcome: Exclude<AdminAuditOutcome, 'pending'>;
    resultCode: AdminAuditResultCode;
    targetId?: string | number | null;
  },
): Promise<void> {
  const outcome = assertOutcome(completion.outcome);
  if (outcome === 'pending') {
    throw new AppError(500, 'Cannot complete audit as pending');
  }
  const data: Prisma.AdminAuditEventUpdateInput = {
    outcome,
    resultCode: assertResultCode(completion.resultCode),
    completedAt: new Date(),
  };
  if (completion.targetId !== undefined) {
    data.targetId = normalizeTargetId(completion.targetId);
  }
  await prisma.adminAuditEvent.updateMany({
    where: { operationId, outcome: 'pending' },
    data,
  });
}

/**
 * Record a local DB mutation and its success audit row in one transaction.
 * On success outcome only — callers that need partial should use markPartial after.
 */
export async function recordLocalSuccess<T>(
  prisma: PrismaClient,
  input: BaseEventInput,
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: {
    /** Resolve non-secret target id after mutate (e.g. newly created row id). */
    resolveTargetId?: (result: T) => string | number | null | undefined;
  },
): Promise<{ result: T; operationId: string }> {
  const operationId = randomUUID();
  const result = await prisma.$transaction(async (tx) => {
    const value = await mutate(tx);
    const resolvedTargetId = options?.resolveTargetId
      ? normalizeTargetId(options.resolveTargetId(value))
      : undefined;
    const target =
      resolvedTargetId !== undefined
        ? {
            type: (input.target?.type ?? 'user') as AdminAuditTargetType,
            id: resolvedTargetId,
          }
        : input.target;
    await tx.adminAuditEvent.create({
      data: buildRow({
        ...input,
        target,
        operationId,
        outcome: 'success',
        resultCode: 'ok',
        completedAt: new Date(),
      }),
    });
    return value;
  });
  return { result, operationId };
}

/**
 * Mark a previously successful local write as partial (e.g. engine reload failed).
 */
export async function markPartial(
  prisma: PrismaLike,
  operationId: string,
  resultCode: AdminAuditResultCode,
): Promise<void> {
  await prisma.adminAuditEvent.updateMany({
    where: { operationId, outcome: { in: ['success', 'pending'] } },
    data: {
      outcome: 'partial',
      resultCode: assertResultCode(resultCode),
      completedAt: new Date(),
    },
  });
}

/** Map unknown errors to allow-listed result codes (no message leakage). */
export function classifyRemoteError(err: unknown): {
  outcome: 'failure' | 'unknown';
  resultCode: AdminAuditResultCode;
} {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  const message = err instanceof Error ? err.message.toLowerCase() : '';

  if (
    name === 'TimeoutError'
    || name === 'AbortError'
    || code === 'ETIMEDOUT'
    || code === 'ABORT_ERR'
    || message.includes('timeout')
    || message.includes('aborted')
  ) {
    // Dispatch may have reached TeamSpeak — do not assume failure.
    return { outcome: 'unknown', resultCode: 'timeout' };
  }

  if (
    code === 'ECONNREFUSED'
    || code === 'ENOTFOUND'
    || code === 'ECONNRESET'
    || message.includes('network')
  ) {
    return { outcome: 'failure', resultCode: 'network_error' };
  }

  if (err instanceof AppError && err.statusCode === 404) {
    return { outcome: 'failure', resultCode: 'not_found' };
  }

  if (err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500) {
    return { outcome: 'failure', resultCode: 'validation_failed' };
  }

  // TeamSpeak API errors typically have a numeric `code` property from TSApiError
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
    return { outcome: 'failure', resultCode: 'ts_error' };
  }

  return { outcome: 'failure', resultCode: 'unknown' };
}

export function actorFromRequest(user: { id: number; username: string } | undefined): AuditActor {
  if (!user?.id) throw new AppError(401, 'Authentication required');
  return { id: user.id, username: user.username || `user:${user.id}` };
}

/**
 * Attempt-before-dispatch wrapper for TeamSpeak (and similar) remote writes.
 * - Fail-closed if the pending audit insert fails (does not call `dispatch`).
 * - Success path: best-effort completion; never fails the HTTP response if
 *   TeamSpeak already succeeded but audit completion storage failed.
 * - Failure path: best-effort completion with classified outcome; rethrows dispatch error.
 */
export async function runRemoteAudited<T>(
  prisma: PrismaClient,
  input: BaseEventInput,
  dispatch: () => Promise<T>,
  options?: {
    resolveTargetId?: (result: T) => string | number | null | undefined;
  },
): Promise<T> {
  const attempt = await beginRemoteAttempt(prisma, input);
  try {
    const result = await dispatch();
    try {
      await completeRemoteAttempt(prisma, attempt.operationId, {
        outcome: 'success',
        resultCode: 'ok',
        targetId: options?.resolveTargetId ? options.resolveTargetId(result) : undefined,
      });
    } catch {
      // Dispatch already succeeded — leave pending for stale resolution; do not fail the request.
    }
    return result;
  } catch (err) {
    try {
      await completeRemoteAttempt(prisma, attempt.operationId, classifyRemoteError(err));
    } catch {
      // Leave pending; retention will mark unknown.
    }
    throw err;
  }
}

