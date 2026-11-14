/**
 * Durable audit helpers for production guild-bind writes.
 * Preflight proves the audit path is appendable before DB mutation.
 * A post-mutation append failure is fatal to the CLI (exit non-zero) even though
 * the DB write already committed — operator must reconcile using the printed audit.
 */
import fs from 'node:fs';
import path from 'node:path';

export function preflightProdGuildBindAuditLog(auditLogPath: string): string {
  const trimmed = auditLogPath.trim();
  if (!trimmed) throw new Error('audit log path is required for confirm-write');
  const resolved = path.resolve(trimmed);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Prove append works before mutating the database.
  fs.appendFileSync(resolved, '', { mode: 0o600 });
  fs.accessSync(resolved, fs.constants.W_OK);
  return resolved;
}

export function appendProdGuildBindAudit(
  auditLogPath: string,
  audit: Record<string, unknown>,
): void {
  const resolved = path.resolve(auditLogPath.trim());
  fs.appendFileSync(resolved, `${JSON.stringify(audit)}\n`, { mode: 0o600 });
}
