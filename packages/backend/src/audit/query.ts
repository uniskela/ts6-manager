/**
 * Admin audit history query — cursor pagination + filters.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_OUTCOMES,
  type AdminAuditAction,
  type AdminAuditEventDto,
  type AdminAuditListResponse,
  type AdminAuditOutcome,
  type AdminAuditResultCode,
  type AdminAuditTargetType,
} from '@ts6/common';
import {
  AUDIT_RETENTION_MAX_AGE_DAYS,
  AUDIT_RETENTION_MAX_ROWS,
} from './writer.js';
import { AppError } from '../middleware/error-handler.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { t: Date; id: string } {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: string; id?: string };
    if (!raw?.t || !raw?.id) throw new Error('bad cursor');
    const t = new Date(raw.t);
    if (Number.isNaN(t.getTime())) throw new Error('bad cursor date');
    return { t, id: raw.id };
  } catch {
    throw new AppError(400, 'Invalid cursor');
  }
}

export interface ListAuditEventsParams {
  cursor?: string;
  limit?: number;
  action?: string;
  actorUserId?: number;
  connectionId?: number;
  virtualServerId?: number;
  outcome?: string;
  from?: string;
  to?: string;
}

function toDto(row: {
  id: string;
  operationId: string;
  actorUserId: number;
  actorUsername: string | null;
  action: string;
  connectionId: number | null;
  virtualServerId: number | null;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  resultCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): AdminAuditEventDto {
  return {
    id: row.id,
    operationId: row.operationId,
    actorUserId: row.actorUserId,
    actorUsername: row.actorUsername,
    action: row.action as AdminAuditAction,
    connectionId: row.connectionId,
    virtualServerId: row.virtualServerId,
    targetType: row.targetType as AdminAuditTargetType | null,
    targetId: row.targetId,
    outcome: row.outcome as AdminAuditOutcome,
    resultCode: row.resultCode as AdminAuditResultCode | null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function listAuditEvents(
  prisma: PrismaClient,
  params: ListAuditEventsParams,
): Promise<AdminAuditListResponse> {
  const parsedLimit = params.limit != null ? Number(params.limit) : DEFAULT_LIMIT;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const where: Prisma.AdminAuditEventWhereInput = {};

  if (params.action) {
    if (!(ADMIN_AUDIT_ACTIONS as readonly string[]).includes(params.action)) {
      throw new AppError(400, 'Invalid action filter');
    }
    where.action = params.action;
  }
  if (params.outcome) {
    if (!(ADMIN_AUDIT_OUTCOMES as readonly string[]).includes(params.outcome)) {
      throw new AppError(400, 'Invalid outcome filter');
    }
    where.outcome = params.outcome;
  }
  if (params.actorUserId != null && Number.isFinite(params.actorUserId)) {
    where.actorUserId = params.actorUserId;
  }
  if (params.connectionId != null && Number.isFinite(params.connectionId)) {
    where.connectionId = params.connectionId;
  }
  if (params.virtualServerId != null && Number.isFinite(params.virtualServerId)) {
    where.virtualServerId = params.virtualServerId;
  }
  if (params.from || params.to) {
    where.createdAt = {};
    if (params.from) {
      const from = new Date(params.from);
      if (Number.isNaN(from.getTime())) throw new AppError(400, 'Invalid from date');
      where.createdAt.gte = from;
    }
    if (params.to) {
      const to = new Date(params.to);
      if (Number.isNaN(to.getTime())) throw new AppError(400, 'Invalid to date');
      where.createdAt.lte = to;
    }
  }

  if (params.cursor) {
    const { t, id } = decodeCursor(params.cursor);
    where.AND = [
      {
        OR: [
          { createdAt: { lt: t } },
          { createdAt: t, id: { lt: id } },
        ],
      },
    ];
  }

  const rows = await prisma.adminAuditEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return {
    items: page.map(toDto),
    nextCursor,
    retention: {
      maxAgeDays: AUDIT_RETENTION_MAX_AGE_DAYS,
      maxRows: AUDIT_RETENTION_MAX_ROWS,
    },
  };
}
