import { redactDiagnosticText } from '@ts6/common';
import type { CommandResult } from './adapter.js';
import type { DiscordDeferredFollowUpJob, DiscordInteractionFollowUp } from './follow-up.js';

/** Discord message content hard limit. */
export const DISCORD_MESSAGE_CONTENT_MAX = 2000;

/** Interaction tokens are valid for 15 minutes after the interaction is received. */
export const DISCORD_INTERACTION_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Max time we are willing to sleep for a single 429 before giving up.
 * Never truncate Discord's required delay and then retry early — if the
 * required wait exceeds this budget, fail closed instead.
 */
export const DISCORD_429_WAIT_BUDGET_MS = 5_000;

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_5XX_ATTEMPTS = 3; // initial + 2 retries
const MAX_429_ATTEMPTS = 2; // initial + 1 retry after full Retry-After
const DEFAULT_429_WAIT_MS = 1_000;

/** Codes that mean the TCP/TLS request never reached Discord (safe to retry once). */
const UNSENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_CONNECTION_REFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export type DiscordHttpTransport = {
  fetch(url: string, init: RequestInit): Promise<Response>;
};

export type DiscordWebhookFollowUpOpts = {
  /** Trusted application snowflake from configuration (never from the client alone). */
  applicationId: string;
  /**
   * API root for Edit Original Interaction Response.
   * Production: https://discord.com/api/v10. Tests inject http://127.0.0.1:…
   */
  apiBaseUrl?: string;
  transport?: DiscordHttpTransport;
  nowMs?: () => number;
  requestTimeoutMs?: number;
  tokenTtlMs?: number;
  /** Ceiling for accepting a 429 wait; longer required delays fail closed. */
  rateLimitWaitBudgetMs?: number;
  /** Abort in-flight deliveries on backend shutdown. */
  signal?: AbortSignal;
  /** Diagnostics only — never log tokens or full webhook URLs. */
  onDiagnostic?: (message: string) => void;
};

export type DiscordWebhookFollowUp = DiscordInteractionFollowUp & {
  dispose(): void;
};

export function isDiscordApplicationId(value: string): boolean {
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

/** Fail-closed HTTPS in production; http:// allowed only for injected test bases. */
export function assertSafeDiscordApiBase(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid Discord API base URL.');
  }
  if (url.protocol === 'https:') return trimmed;
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return trimmed;
  }
  throw new Error('Discord API base must be HTTPS (or localhost HTTP for tests).');
}

export function truncateDiscordContent(content: string): string {
  if (content.length <= DISCORD_MESSAGE_CONTENT_MAX) return content;
  return `${content.slice(0, DISCORD_MESSAGE_CONTENT_MAX - 1)}…`;
}

/**
 * Edit-original payload. Visibility was set by the type-5 ack (flags=64 or not).
 * Never include `flags` here — Discord does not allow flipping ephemeral on edit.
 */
export function discordEditOriginalBody(result: CommandResult): {
  content: string;
  allowed_mentions: { parse: [] };
} {
  return {
    content: truncateDiscordContent(
      result.content || (result.ok ? 'Done.' : 'Command failed.'),
    ),
    allowed_mentions: { parse: [] },
  };
}

function collectErrorCodes(err: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (!err || depth > 4) return into;
  if (typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) into.add(code);
    const cause = (err as { cause?: unknown }).cause;
    if (cause) collectErrorCodes(cause, into, depth + 1);
    const errors = (err as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      for (const nested of errors) collectErrorCodes(nested, into, depth + 1);
    }
  }
  return into;
}

/**
 * Classify fetch failures for retry safety.
 * - unsent: request never left / never connected → one retry allowed
 * - unknown: may have reached Discord → do not retry
 * - aborted: caller/shutdown cancelled
 */
export function classifyFetchNetworkError(err: unknown): 'unsent' | 'unknown' | 'aborted' {
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError') return 'aborted';
  // Request may already be in flight when the local timer fires.
  if (name === 'TimeoutError') return 'unknown';

  const codes = collectErrorCodes(err);
  for (const code of codes) {
    if (UNSENT_NETWORK_CODES.has(code)) return 'unsent';
  }

  // Transport may mark definite unsent failures (tests / custom agents).
  if (err && typeof err === 'object' && (err as { discordUnsent?: unknown }).discordUnsent === true) {
    return 'unsent';
  }

  return 'unknown';
}

/**
 * Parse Discord 429 delay in milliseconds (never round down below the required wait).
 * Prefers Retry-After header, then JSON retry_after (both in seconds, may be fractional).
 */
export function parseDiscordRetryAfterMs(res: Response, bodyText?: string): number | null {
  const fromSeconds = (seconds: number): number | null => {
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    // ceil so we never retry earlier than Discord permits
    return Math.max(0, Math.ceil(seconds * 1000));
  };

  const header = res.headers.get('retry-after');
  if (header != null && header.trim() !== '') {
    const parsed = fromSeconds(Number(header));
    if (parsed != null) return parsed;
  }

  const resetAfter = res.headers.get('x-ratelimit-reset-after');
  if (resetAfter != null && resetAfter.trim() !== '') {
    const parsed = fromSeconds(Number(resetAfter));
    if (parsed != null) return parsed;
  }

  if (bodyText) {
    try {
      const json = JSON.parse(bodyText) as { retry_after?: unknown };
      if (typeof json.retry_after === 'number') {
        const parsed = fromSeconds(json.retry_after);
        if (parsed != null) return parsed;
      }
    } catch {
      /* ignore malformed body */
    }
  }
  return null;
}

function redactDeliveryText(text: string, token?: string): string {
  let out = redactDiagnosticText(text);
  if (token && token.length > 0) {
    out = out.split(token).join('[redacted-interaction-token]');
  }
  out = out.replace(/\/webhooks\/\d+\/[^/\s]+\/messages/gi, '/webhooks/[id]/[token]/messages');
  return out;
}

function safeDiag(opts: DiscordWebhookFollowUpOpts, message: string, token?: string): void {
  const line = redactDeliveryText(message, token).slice(0, 240);
  if (opts.onDiagnostic) opts.onDiagnostic(line);
  else console.warn(`[discord-delivery] ${line}`);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type AttemptOutcome =
  | { kind: 'ok' }
  | { kind: 'fatal'; status: number }
  | { kind: 'retry_5xx'; status: number }
  | { kind: 'retry_429'; waitMs: number }
  | { kind: 'network_unknown' }
  | { kind: 'network_unsent' }
  | { kind: 'aborted' };

/**
 * Production Discord Interaction follow-up: PATCH Edit Original Interaction Response.
 * Does not create additional follow-up messages.
 */
export function createDiscordWebhookFollowUp(
  opts: DiscordWebhookFollowUpOpts,
): DiscordWebhookFollowUp {
  if (!isDiscordApplicationId(opts.applicationId)) {
    throw new Error('Discord application ID is invalid.');
  }
  const apiBase = assertSafeDiscordApiBase(opts.apiBaseUrl ?? DEFAULT_API_BASE);
  const transport: DiscordHttpTransport = opts.transport ?? {
    fetch: (url, init) => globalThis.fetch(url, init),
  };
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const tokenTtlMs = opts.tokenTtlMs ?? DISCORD_INTERACTION_TOKEN_TTL_MS;
  const rateLimitWaitBudgetMs = opts.rateLimitWaitBudgetMs ?? DISCORD_429_WAIT_BUDGET_MS;
  const nowMs = () => opts.nowMs?.() ?? Date.now();

  const localAbort = new AbortController();
  const delivered = new Set<string>();
  let disposed = false;

  function combinedSignal(extra?: AbortSignal): AbortSignal {
    if (!extra && !opts.signal) return localAbort.signal;
    return AbortSignal.any(
      [localAbort.signal, opts.signal, extra].filter(Boolean) as AbortSignal[],
    );
  }

  function editUrl(applicationId: string, token: string): string {
    // Path segments only — never accept caller-supplied absolute destinations.
    return `${apiBase}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`;
  }

  async function oneAttempt(
    url: string,
    body: string,
    token: string,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const runSignal = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await transport.fetch(url, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'TS6-Manager-DiscordDelivery/1',
        },
        body,
        signal: runSignal,
        redirect: 'error',
      });
    } catch (err) {
      if (signal.aborted || localAbort.signal.aborted || opts.signal?.aborted) {
        return { kind: 'aborted' };
      }
      const classed = classifyFetchNetworkError(err);
      if (classed === 'aborted') return { kind: 'aborted' };
      if (classed === 'unsent') return { kind: 'network_unsent' };
      return { kind: 'network_unknown' };
    }

    if (res.status >= 200 && res.status < 300) {
      try {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) await res.json().catch(() => null);
        else await res.text().catch(() => '');
      } catch {
        /* ignore */
      }
      return { kind: 'ok' };
    }

    if (res.status === 429) {
      const bodyText = await res.text().catch(() => '');
      const waitMs = parseDiscordRetryAfterMs(res, bodyText) ?? DEFAULT_429_WAIT_MS;
      return { kind: 'retry_429', waitMs };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { kind: 'fatal', status: res.status };
    }
    if (res.status >= 400 && res.status < 500) {
      return { kind: 'fatal', status: res.status };
    }
    if (res.status >= 500) {
      return { kind: 'retry_5xx', status: res.status };
    }
    return { kind: 'fatal', status: res.status };
  }

  async function afterDeferred(job: DiscordDeferredFollowUpJob): Promise<void> {
    if (disposed || localAbort.signal.aborted) {
      throw new Error('Discord delivery is shutting down.');
    }

    const dedupeKey = job.interactionId?.trim() || '';
    if (dedupeKey) {
      if (delivered.has(dedupeKey)) return;
      delivered.add(dedupeKey);
    }

    const token = job.interactionToken?.trim() ?? '';
    const appId = job.applicationId?.trim() ?? '';
    if (!token || !isDiscordApplicationId(appId)) {
      throw new Error('Discord delivery job is missing interaction credentials.');
    }
    if (appId !== opts.applicationId) {
      throw new Error('Discord application ID mismatch.');
    }

    const receivedAt = Number(job.receivedAtMs);
    if (!Number.isFinite(receivedAt)) {
      throw new Error('Discord delivery job is missing receivedAtMs.');
    }
    if (nowMs() - receivedAt >= tokenTtlMs) {
      safeDiag(opts, `skip expired interaction command=${job.command} guild=${job.guildId}`, token);
      throw new Error('Discord interaction token expired.');
    }

    const payload = JSON.stringify(discordEditOriginalBody(job.result));
    const url = editUrl(appId, token);
    const signal = combinedSignal();

    let attempts5xx = 0;
    let attempts429 = 0;
    let unsentRetries = 0;

    for (;;) {
      if (nowMs() - receivedAt >= tokenTtlMs) {
        throw new Error('Discord interaction token expired.');
      }
      if (signal.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }

      const outcome = await oneAttempt(url, payload, token, signal);
      if (outcome.kind === 'ok') return;

      if (outcome.kind === 'aborted') {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }

      if (outcome.kind === 'fatal') {
        safeDiag(
          opts,
          `delivery failed status=${outcome.status} command=${job.command} guild=${job.guildId}`,
          token,
        );
        throw new Error(`Discord delivery failed (${outcome.status}).`);
      }

      if (outcome.kind === 'network_unknown') {
        safeDiag(opts, `delivery outcome unknown command=${job.command} guild=${job.guildId}`, token);
        throw new Error('Discord delivery outcome unknown.');
      }

      if (outcome.kind === 'network_unsent') {
        unsentRetries += 1;
        if (unsentRetries > 1) {
          safeDiag(opts, `delivery network failed command=${job.command} guild=${job.guildId}`, token);
          throw new Error('Discord delivery network failure.');
        }
        continue;
      }

      if (outcome.kind === 'retry_429') {
        attempts429 += 1;
        const remaining = tokenTtlMs - (nowMs() - receivedAt);
        // Never retry earlier than Discord requires. If we cannot honour the full
        // delay within budget/TTL, stop — do not sleep a truncated window and retry.
        if (
          outcome.waitMs > rateLimitWaitBudgetMs
          || outcome.waitMs > remaining
          || attempts429 >= MAX_429_ATTEMPTS
        ) {
          safeDiag(
            opts,
            `delivery rate limited waitMs=${outcome.waitMs} command=${job.command} guild=${job.guildId}`,
            token,
          );
          throw new Error('Discord delivery rate limited.');
        }
        await sleep(outcome.waitMs, signal);
        continue;
      }

      if (outcome.kind === 'retry_5xx') {
        attempts5xx += 1;
        if (attempts5xx >= MAX_5XX_ATTEMPTS) {
          safeDiag(
            opts,
            `delivery upstream failed status=${outcome.status} command=${job.command} guild=${job.guildId}`,
            token,
          );
          throw new Error(`Discord delivery failed (${outcome.status}).`);
        }
        await sleep(50 * attempts5xx, signal);
        continue;
      }
    }
  }

  return {
    afterDeferred,
    dispose() {
      disposed = true;
      if (!localAbort.signal.aborted) localAbort.abort();
      delivered.clear();
    },
  };
}

/**
 * Build a production follow-up when configuration is complete; otherwise null (fail closed).
 * Does not perform any HTTP I/O.
 */
export function createDiscordWebhookFollowUpFromConfig(opts: {
  applicationId: string;
  apiBaseUrl?: string;
  transport?: DiscordHttpTransport;
  nowMs?: () => number;
  signal?: AbortSignal;
}): DiscordWebhookFollowUp | null {
  const applicationId = opts.applicationId.trim();
  if (!isDiscordApplicationId(applicationId)) return null;
  try {
    return createDiscordWebhookFollowUp({
      applicationId,
      apiBaseUrl: opts.apiBaseUrl,
      transport: opts.transport,
      nowMs: opts.nowMs,
      signal: opts.signal,
    });
  } catch {
    return null;
  }
}
