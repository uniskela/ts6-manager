import { TeamSpeakFloodError, TSApiError } from '../middleware/error-handler.js';
import { validateTsQueryServerId } from '../utils/validate-ts-host.js';

/** Staged WebQuery connection diagnostic stages (#91 Slice 2). */
export const DIAGNOSTIC_STAGE_IDS = [
  'reachability',
  'authentication',
  'permissions',
  'virtual_server',
] as const;

export type DiagnosticStageId = (typeof DIAGNOSTIC_STAGE_IDS)[number];
export type DiagnosticStageStatus = 'ok' | 'fail' | 'skipped';
export type DiagnosticOverall = 'ok' | 'partial' | 'fail';

export interface DiagnosticStageResult {
  id: DiagnosticStageId;
  status: DiagnosticStageStatus;
  /** Operator-safe message — never includes secrets or raw TeamSpeak bodies. */
  message: string;
  /** Stable machine code for UI / logs. */
  code?: string;
}

export interface ConnectionDiagnosticReport {
  /** True only when every required stage is ok (complete admin success). */
  success: boolean;
  /** Some stages ok, but not a complete admin success. */
  partial: boolean;
  overall: DiagnosticOverall;
  stages: DiagnosticStageResult[];
  /** Sanitized version string when known. */
  version?: string;
}

export interface DiagnoseConnectionOptions {
  /** Virtual server id for the final stage (default 1). */
  sid?: number;
  /** Hard deadline for the whole diagnose run (default 20s). */
  overallTimeoutMs?: number;
}

/** Minimal client surface used by diagnostics (real + demo + mocks). */
export interface DiagnosticWebQueryClient {
  execute(
    sid: number,
    command: string,
    params?: Record<string, unknown>,
    options?: { priority?: 'high' | 'normal' | 'low' },
  ): Promise<unknown>;
}

/** Overall budget across all diagnostic stages. Frontend `test` /
 * `testWebqueryDraft` use CONNECTION_DIAGNOSTICS_TIMEOUT_MS (30s) so the
 * axios client does not abort before this deadline returns a staged report. */
const DEFAULT_OVERALL_TIMEOUT_MS = 20_000;
const STAGE_LABEL: Record<DiagnosticStageId, string> = {
  reachability: 'Endpoint reachability',
  authentication: 'Authentication',
  permissions: 'Management permissions',
  virtual_server: 'Virtual server access',
};

const SENSITIVE_SUBSTRINGS = [
  'apikey',
  'api-key',
  'api_key',
  'x-api-key',
  'password',
  'passwd',
  'authorization',
  'bearer ',
];

type ClassifiedKind =
  | 'network'
  | 'timeout'
  | 'flood'
  | 'auth'
  | 'permission'
  | 'unknown';

interface ClassifiedError {
  kind: ClassifiedKind;
  code: string;
  message: string;
}

function isFloodLikeError(error: unknown): boolean {
  if (error instanceof TeamSpeakFloodError) return true;
  const code = tsCode(error);
  if (code === 524 || code === 3329 || code === 3331) return true;
  const msg = tsMessage(error).toLowerCase();
  return msg.includes('flood');
}

function isTimeoutError(error: unknown): boolean {
  const err = error as { code?: string; name?: string; message?: string; cause?: { code?: string } };
  const code = err?.code || err?.cause?.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function isNetworkError(error: unknown): boolean {
  if (isTimeoutError(error)) return false;
  const err = error as { code?: string; message?: string; cause?: { code?: string } };
  const code = err?.code || err?.cause?.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'ENETUNREACH' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('network socket disconnected') ||
    msg.includes('connection failed')
  );
}

function tsCode(error: unknown): number | undefined {
  if (error instanceof TSApiError) return error.code;
  const nested = (error as { response?: { data?: { status?: { code?: number } } } })?.response?.data?.status?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function tsMessage(error: unknown): string {
  if (error instanceof TSApiError) return error.message;
  const nested = (error as { response?: { data?: { status?: { message?: string } } } })?.response?.data?.status?.message;
  if (nested) return String(nested);
  return String((error as { message?: string })?.message || '');
}

function isAuthError(error: unknown): boolean {
  const msg = tsMessage(error).toLowerCase();
  if (
    msg.includes('invalid apikey') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid api-key') ||
    msg.includes('apikey invalid') ||
    msg.includes('unauthorized') ||
    msg.includes('not authenticated')
  ) {
    return true;
  }
  const code = tsCode(error);
  // Common Query auth / identity failures.
  return code === 512 || code === 520 || code === 1282;
}

function isPermissionError(error: unknown): boolean {
  const code = tsCode(error);
  if (code === 2568 || code === 2567 || code === 1796) return true;
  const msg = tsMessage(error).toLowerCase();
  return msg.includes('insufficient') || msg.includes('permission');
}

/** Map thrown errors to stable operator-safe codes (no secrets / raw bodies). */
export function classifyDiagnosticError(error: unknown): ClassifiedError {
  if (isFloodLikeError(error)) {
    const retry =
      error instanceof TeamSpeakFloodError
        ? error.retryAfterSeconds
        : undefined;
    return {
      kind: 'flood',
      code: 'flood',
      message: retry
        ? `TeamSpeak flood protection is active. Retry in about ${retry}s.`
        : 'TeamSpeak flood protection is active. Wait before retrying.',
    };
  }

  if (isTimeoutError(error)) {
    return {
      kind: 'timeout',
      code: 'timeout',
      message: 'The TeamSpeak endpoint did not respond in time.',
    };
  }

  if (isNetworkError(error)) {
    return {
      kind: 'network',
      code: 'unreachable',
      message: 'Could not reach the TeamSpeak WebQuery endpoint.',
    };
  }

  if (isAuthError(error)) {
    return {
      kind: 'auth',
      code: 'invalid_apikey',
      message: 'The WebQuery API key was rejected.',
    };
  }

  if (isPermissionError(error)) {
    return {
      kind: 'permission',
      code: 'permission_denied',
      message: 'The API key lacks the required management permissions.',
    };
  }

  return {
    kind: 'unknown',
    code: 'query_failed',
    message: 'The TeamSpeak Query command failed.',
  };
}

/** Strip anything that could echo credentials from a version string. */
export function sanitizeVersionString(raw: unknown): string | undefined {
  if (raw == null) return undefined;

  let text: string;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    text = String(raw);
  } else if (Array.isArray(raw)) {
    const first = raw[0] as { version?: unknown; platform?: unknown; build?: unknown } | undefined;
    if (first && typeof first === 'object') {
      const parts = [first.version, first.platform, first.build]
        .filter((part) => part != null && String(part).trim() !== '')
        .map((part) => String(part));
      text = parts.join(' ');
    } else {
      text = '';
    }
  } else if (typeof raw === 'object') {
    const obj = raw as { version?: unknown };
    text = obj.version != null ? String(obj.version) : '';
  } else {
    text = '';
  }

  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  if (!text) return undefined;

  const lower = text.toLowerCase();
  for (const needle of SENSITIVE_SUBSTRINGS) {
    if (lower.includes(needle)) return undefined;
  }
  return text;
}

/** Ensure a report JSON never contains provided secret values or password-like material. */
export function assertReportHasNoSecrets(
  report: ConnectionDiagnosticReport,
  forbidden: string[] = [],
): void {
  const serialized = JSON.stringify(report);
  const lower = serialized.toLowerCase();
  for (const raw of forbidden) {
    if (!raw || raw.length < 4) continue;
    if (serialized.includes(raw) || lower.includes(raw.toLowerCase())) {
      throw new Error('Diagnostic report leaked a forbidden secret value');
    }
  }
  // Heuristic: reject authorization-style header echoes / password fields.
  if (/"password"\s*:/.test(lower) || lower.includes('x-api-key:') || lower.includes('authorization:')) {
    throw new Error('Diagnostic report leaked credential field material');
  }
}

export function buildFloodDiagnosticReport(retryAfterSeconds?: number): ConnectionDiagnosticReport {
  const message = retryAfterSeconds
    ? `TeamSpeak flood protection is active. Retry in about ${retryAfterSeconds}s.`
    : 'TeamSpeak flood protection is active. Wait before retrying.';
  const stages: DiagnosticStageResult[] = DIAGNOSTIC_STAGE_IDS.map((id, index) =>
    index === 0
      ? { id, status: 'fail', message, code: 'flood' }
      : { id, status: 'skipped', message: 'Skipped after flood protection.', code: 'skipped' },
  );
  return finalizeReport(stages);
}

export function buildFullSuccessReport(version = 'Demo mode'): ConnectionDiagnosticReport {
  const stages: DiagnosticStageResult[] = [
    { id: 'reachability', status: 'ok', message: `${STAGE_LABEL.reachability} confirmed.` },
    { id: 'authentication', status: 'ok', message: `${STAGE_LABEL.authentication} confirmed.` },
    { id: 'permissions', status: 'ok', message: `${STAGE_LABEL.permissions} confirmed.` },
    { id: 'virtual_server', status: 'ok', message: `${STAGE_LABEL.virtual_server} confirmed.` },
  ];
  return finalizeReport(stages, sanitizeVersionString(version) ?? version);
}

export function finalizeReport(
  stages: DiagnosticStageResult[],
  version?: string,
): ConnectionDiagnosticReport {
  const okCount = stages.filter((s) => s.status === 'ok').length;
  const failCount = stages.filter((s) => s.status === 'fail').length;
  const allOk = stages.length === DIAGNOSTIC_STAGE_IDS.length && okCount === stages.length;
  const partial = !allOk && okCount > 0;
  const overall: DiagnosticOverall = allOk ? 'ok' : partial ? 'partial' : 'fail';
  const report: ConnectionDiagnosticReport = {
    success: allOk,
    partial,
    overall,
    stages,
  };
  if (version) report.version = version;
  // failCount unused except for clarity in reviews — kept for future metrics.
  void failCount;
  return report;
}

function skipRemaining(
  fromIndex: number,
  reason: string,
  code = 'skipped',
): DiagnosticStageResult[] {
  return DIAGNOSTIC_STAGE_IDS.slice(fromIndex).map((id) => ({
    id,
    status: 'skipped' as const,
    message: reason,
    code,
  }));
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = Math.max(0, deadlineMs - Date.now());
  if (remaining <= 0) {
    const err = new Error('Diagnostic overall timeout');
    err.name = 'TimeoutError';
    throw err;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Diagnostic overall timeout');
          err.name = 'TimeoutError';
          reject(err);
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run read-only staged WebQuery diagnostics.
 * Does not mutate TeamSpeak state. Does not retry on flood.
 */
export async function diagnoseConnection(
  client: DiagnosticWebQueryClient,
  options: DiagnoseConnectionOptions = {},
): Promise<ConnectionDiagnosticReport> {
  // Default virtual server 1. Callers (routes) must not pass request-body sid —
  // that re-taints the WebQuery path for CodeQL request-forgery.
  const virtualSid = options.sid === undefined
    ? 1
    : (() => {
        const parsed = validateTsQueryServerId(options.sid);
        return parsed > 0 ? parsed : 1;
      })();
  const deadline = Date.now() + (options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
  const stages: DiagnosticStageResult[] = [];
  let version: string | undefined;

  const pushFailAndSkip = (
    id: DiagnosticStageId,
    classified: ClassifiedError,
    skipReason: string,
  ): ConnectionDiagnosticReport => {
    const index = DIAGNOSTIC_STAGE_IDS.indexOf(id);
    stages.push({
      id,
      status: 'fail',
      message: classified.message,
      code: classified.code,
    });
    stages.push(...skipRemaining(index + 1, skipReason, 'skipped'));
    return finalizeReport(stages, version);
  };

  // --- Stage 1: reachability (version) ---
  try {
    const body = await withDeadline(
      client.execute(0, 'version', undefined, { priority: 'high' }),
      deadline,
    );
    version = sanitizeVersionString(body);
    stages.push({
      id: 'reachability',
      status: 'ok',
      message: version
        ? `Endpoint reachable (${version}).`
        : 'Endpoint reachable and responded to version.',
    });
  } catch (error) {
    const classified = classifyDiagnosticError(error);

    // Auth rejection still proves the HTTP endpoint is reachable.
    if (classified.kind === 'auth') {
      stages.push({
        id: 'reachability',
        status: 'ok',
        message: 'Endpoint reachable (TeamSpeak rejected the API key).',
      });
      return pushFailAndSkip(
        'authentication',
        classified,
        'Skipped after authentication failed.',
      );
    }

    if (classified.kind === 'flood') {
      return pushFailAndSkip(
        'reachability',
        classified,
        'Skipped after flood protection.',
      );
    }

    return pushFailAndSkip(
      'reachability',
      classified.kind === 'timeout'
        ? classified
        : classified.kind === 'network'
          ? classified
          : {
              kind: 'network',
              code: classified.code === 'query_failed' ? 'unreachable' : classified.code,
              message: classified.kind === 'unknown'
                ? 'Could not complete the reachability probe.'
                : classified.message,
            },
      'Skipped after reachability failed.',
    );
  }

  // --- Stage 2: authentication (whoami) ---
  try {
    await withDeadline(
      client.execute(0, 'whoami', undefined, { priority: 'high' }),
      deadline,
    );
    stages.push({
      id: 'authentication',
      status: 'ok',
      message: 'Authenticated Query identity confirmed.',
    });
  } catch (error) {
    const classified = classifyDiagnosticError(error);
    if (classified.kind === 'flood') {
      return pushFailAndSkip('authentication', classified, 'Skipped after flood protection.');
    }
    if (classified.kind === 'timeout' || classified.kind === 'network') {
      return pushFailAndSkip('authentication', classified, 'Skipped after authentication probe failed.');
    }
    return pushFailAndSkip(
      'authentication',
      classified.kind === 'auth'
        ? classified
        : {
            kind: 'auth',
            code: classified.kind === 'permission' ? 'permission_denied' : 'invalid_apikey',
            message: classified.kind === 'permission'
              ? classified.message
              : 'Could not confirm an authenticated Query identity.',
          },
      'Skipped after authentication failed.',
    );
  }

  // --- Stage 3: permissions (serverlist — guest/version alone must not pass) ---
  try {
    await withDeadline(
      client.execute(0, 'serverlist', undefined, { priority: 'high' }),
      deadline,
    );
    stages.push({
      id: 'permissions',
      status: 'ok',
      message: 'Instance-level management read permissions confirmed.',
    });
  } catch (error) {
    const classified = classifyDiagnosticError(error);
    if (classified.kind === 'flood') {
      return pushFailAndSkip('permissions', classified, 'Skipped after flood protection.');
    }
    if (classified.kind === 'auth') {
      return pushFailAndSkip('permissions', {
        kind: 'auth',
        code: 'invalid_apikey',
        message: classified.message,
      }, 'Skipped after authentication failed.');
    }
    if (classified.kind === 'timeout' || classified.kind === 'network') {
      return pushFailAndSkip('permissions', classified, 'Skipped after permissions probe failed.');
    }
    return pushFailAndSkip(
      'permissions',
      classified.kind === 'permission'
        ? classified
        : {
            kind: 'permission',
            code: 'permission_denied',
            message: 'The API key lacks required management read permissions.',
          },
      'Skipped after permissions failed.',
    );
  }

  // --- Stage 4: virtual server (serverinfo on selected sid) ---
  try {
    await withDeadline(
      client.execute(virtualSid, 'serverinfo', undefined, { priority: 'high' }),
      deadline,
    );
    stages.push({
      id: 'virtual_server',
      status: 'ok',
      message: `Virtual server ${virtualSid} is accessible.`,
    });
  } catch (error) {
    const classified = classifyDiagnosticError(error);
    if (classified.kind === 'flood') {
      return pushFailAndSkip('virtual_server', classified, 'Skipped after flood protection.');
    }
    stages.push({
      id: 'virtual_server',
      status: 'fail',
      message: classified.kind === 'permission' || classified.kind === 'unknown'
        ? `Virtual server ${virtualSid} is not accessible with this API key.`
        : classified.message,
      code: classified.kind === 'timeout'
        ? 'timeout'
        : classified.kind === 'network'
          ? 'unreachable'
          : classified.kind === 'auth'
            ? 'invalid_apikey'
            : 'virtual_server_inaccessible',
    });
  }

  return finalizeReport(stages, version);
}

/** Toast / UI helper shared with route tests. */
export function summarizeDiagnosticToast(report: ConnectionDiagnosticReport): string {
  if (report.success) {
    return report.version
      ? `All stages OK (${report.version})`
      : 'All connection stages succeeded';
  }
  const failed = report.stages.find((s) => s.status === 'fail');
  if (report.partial && failed) {
    return `Partial: ${failed.message}`;
  }
  if (failed) {
    return failed.message;
  }
  return 'Connection diagnostics failed';
}
