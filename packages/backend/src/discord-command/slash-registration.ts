import { redactDiagnosticText } from '@ts6/common';
import type { DiscordHttpTransport } from './discord-delivery.js';
import {
  classifyFetchNetworkError,
  parseDiscordRetryAfterMs,
  DISCORD_429_WAIT_BUDGET_MS,
  assertSafeDiscordApiBase,
  isDiscordApplicationId,
} from './discord-delivery.js';
import {
  getSupportedSlashCommands,
  toDiscordCommandBody,
  validateSlashCommandRegistry,
  type SlashCommandDefinition,
} from './slash-commands.js';

const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TIMEOUT_MS = 8_000;

/** Remote guild command as returned by Discord (fields we compare). */
export type RemoteGuildCommand = {
  id: string;
  name: string;
  type?: number;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string | null;
  dm_permission?: boolean | null;
};

export type SlashRegistrationPlan = {
  applicationId: string;
  guildId: string;
  dryRun: true;
  validationErrors: string[];
  create: SlashCommandDefinition[];
  /** Local def differs from remote with same name — apply would POST (upsert). */
  update: Array<{ local: SlashCommandDefinition; remote: RemoteGuildCommand }>;
  unchanged: Array<{ local: SlashCommandDefinition; remote: RemoteGuildCommand }>;
  /** Remote names that collide in unexpected ways (e.g. wrong type). */
  collisions: Array<{ remote: RemoteGuildCommand; reason: string }>;
  /** Remote commands not in our registry — never deleted by this client. */
  unrelated: RemoteGuildCommand[];
};

export type SlashRegistrationApplyResult = {
  applicationId: string;
  guildId: string;
  dryRun: false;
  applied: Array<{ name: string; action: 'create' | 'update'; id?: string }>;
  skipped: string[];
  errors: Array<{ name: string; message: string }>;
};

export type SlashRegistrationClientOpts = {
  applicationId: string;
  /** Bot token or bearer — never logged. Prefer "Bot …" form. */
  authorization: string;
  apiBaseUrl?: string;
  transport?: DiscordHttpTransport;
  requestTimeoutMs?: number;
  rateLimitWaitBudgetMs?: number;
  nowMs?: () => number;
  onDiagnostic?: (message: string) => void;
};

function assertGuildSnowflake(guildId: string): string {
  if (!isDiscordApplicationId(guildId)) {
    throw new Error('guildId must be a Discord snowflake string.');
  }
  return guildId;
}

function redactAuth(text: string, authorization: string): string {
  let out = redactDiagnosticText(text);
  const token = authorization.replace(/^Bot\s+/i, '').trim();
  if (token) out = out.split(token).join('[redacted-discord-token]');
  out = out.replace(/Bot\s+\S+/gi, 'Bot [redacted]');
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return out;
}

function optionFingerprint(value: unknown): string {
  // Discord may omit empty options; local bodies often use []. Treat both as empty.
  const normalized = value == null || (Array.isArray(value) && value.length === 0) ? [] : value;
  return JSON.stringify(normalized);
}

function commandsEquivalent(local: SlashCommandDefinition, remote: RemoteGuildCommand): boolean {
  const body = toDiscordCommandBody(local);
  if ((remote.type ?? 1) !== body.type) return false;
  if ((remote.description ?? '') !== body.description) return false;
  if (optionFingerprint(remote.options) !== optionFingerprint(body.options ?? [])) return false;
  const localPerm = body.default_member_permissions ?? null;
  const remotePerm = remote.default_member_permissions ?? null;
  if (localPerm !== remotePerm) return false;
  return true;
}

function formatPlan(plan: SlashRegistrationPlan): string {
  const lines = [
    `Discord slash registration DRY RUN`,
    `applicationId=${plan.applicationId} guildId=${plan.guildId}`,
    `validationErrors=${plan.validationErrors.length}`,
    `create=${plan.create.map((c) => c.name).join(',') || '(none)'}`,
    `update=${plan.update.map((u) => u.local.name).join(',') || '(none)'}`,
    `unchanged=${plan.unchanged.map((u) => u.local.name).join(',') || '(none)'}`,
    `collisions=${plan.collisions.map((c) => `${c.remote.name}:${c.reason}`).join(',') || '(none)'}`,
    `unrelated(preserved)=${plan.unrelated.map((c) => c.name).join(',') || '(none)'}`,
    `NOTE: POST upserts by name — same-name remotes may belong to another TS6 feature; require confirmSameNameOverwrite for updates.`,
    `NOTE: never DELETE or bulk-overwrite; unrelated remotes are preserved.`,
  ];
  return lines.join('\n');
}

/**
 * Guild-scoped slash registration client.
 * Default planning is dry-run. Apply never deletes and never touches global commands.
 */
export function createSlashRegistrationClient(opts: SlashRegistrationClientOpts) {
  if (!isDiscordApplicationId(opts.applicationId)) {
    throw new Error('applicationId must be a Discord snowflake string.');
  }
  const authorization = opts.authorization.trim();
  if (!authorization) throw new Error('Discord authorization is required for registration.');
  const apiBase = assertSafeDiscordApiBase(opts.apiBaseUrl ?? DEFAULT_API_BASE);
  const transport = opts.transport ?? { fetch: (url, init) => globalThis.fetch(url, init) };
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitBudget = opts.rateLimitWaitBudgetMs ?? DISCORD_429_WAIT_BUDGET_MS;

  function diag(message: string): void {
    const line = redactAuth(message, authorization).slice(0, 240);
    if (opts.onDiagnostic) opts.onDiagnostic(line);
    else console.warn(`[discord-slash-register] ${line}`);
  }

  function guildCommandsUrl(guildId: string, commandId?: string): string {
    const base = `${apiBase}/applications/${encodeURIComponent(opts.applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`;
    return commandId ? `${base}/${encodeURIComponent(commandId)}` : base;
  }

  function assertNotGlobal(url: string): void {
    // Guard against accidental global endpoint construction.
    if (/\/applications\/[^/]+\/commands(?:\?|$)/.test(url) && !url.includes('/guilds/')) {
      throw new Error('Global command registration is not allowed in this step.');
    }
  }

  async function request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; text: string }> {
    assertNotGlobal(url);
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await transport.fetch(url, {
        method,
        headers: {
          authorization,
          'content-type': 'application/json',
          'user-agent': 'TS6-Manager-DiscordSlashRegister/1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      const kind = classifyFetchNetworkError(err);
      diag(`registration ${method} network kind=${kind}`);
      throw new Error(kind === 'unsent'
        ? 'Discord registration network failure (unsent).'
        : 'Discord registration network failure (outcome unknown).');
    }

    const text = await res.text().catch(() => '');
    if (res.status === 429) {
      const waitMs = parseDiscordRetryAfterMs(res, text) ?? 1_000;
      if (waitMs > waitBudget) {
        diag(`registration rate limited waitMs=${waitMs}`);
        throw new Error('Discord registration rate limited.');
      }
      // Bounded honour of short Retry-After only.
      await new Promise((r) => setTimeout(r, waitMs));
      throw new Error('Discord registration rate limited; retry once manually.');
    }

    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.status === 401 || res.status === 403) {
      diag(`registration auth failed status=${res.status}`);
      throw new Error('Discord registration unauthorized.');
    }
    if (res.status >= 400) {
      const msg = typeof (json as { message?: unknown })?.message === 'string'
        ? (json as { message: string }).message
        : `HTTP ${res.status}`;
      diag(`registration failed status=${res.status}`);
      throw new Error(`Discord registration rejected: ${redactAuth(msg, authorization)}`);
    }
    return { status: res.status, json, text };
  }

  function planAgainst(
    guildId: string,
    remote: RemoteGuildCommand[],
    local: SlashCommandDefinition[] = getSupportedSlashCommands(),
  ): SlashRegistrationPlan {
    const id = assertGuildSnowflake(guildId);
    const validationErrors = validateSlashCommandRegistry(local);
    const remoteByName = new Map(remote.map((r) => [r.name, r]));
    const create: SlashCommandDefinition[] = [];
    const update: SlashRegistrationPlan['update'] = [];
    const unchanged: SlashRegistrationPlan['unchanged'] = [];
    const collisions: SlashRegistrationPlan['collisions'] = [];
    const seenRemote = new Set<string>();

    for (const cmd of local) {
      const existing = remoteByName.get(cmd.name);
      if (!existing) {
        create.push(cmd);
        continue;
      }
      seenRemote.add(cmd.name);
      if ((existing.type ?? 1) !== 1) {
        collisions.push({ remote: existing, reason: 'name exists with non-CHAT_INPUT type' });
        continue;
      }
      if (commandsEquivalent(cmd, existing)) {
        unchanged.push({ local: cmd, remote: existing });
      } else {
        update.push({ local: cmd, remote: existing });
      }
    }

    const unrelated = remote.filter((r) => !seenRemote.has(r.name));
    return {
      applicationId: opts.applicationId,
      guildId: id,
      dryRun: true,
      validationErrors,
      create,
      update,
      unchanged,
      collisions,
      unrelated,
    };
  }

  /** Dry-run: fetch remote (or use injected list) and report plan — no writes. */
  async function dryRun(guildId: string, injectedRemote?: RemoteGuildCommand[]): Promise<SlashRegistrationPlan> {
    const id = assertGuildSnowflake(guildId);
    let remote = injectedRemote;
    if (!remote) {
      const { json } = await request('GET', guildCommandsUrl(id));
      if (!Array.isArray(json)) throw new Error('Discord registration returned unexpected command list.');
      remote = json as RemoteGuildCommand[];
    }
    return planAgainst(id, remote);
  }

  /**
   * Explicit apply: POST upsert only for named commands that are create/update in a
   * freshly recomputed plan. Never DELETE. Never bulk PUT. Never touches unrelated remotes.
   */
  async function apply(
    guildId: string,
    optsApply: {
      /** Command names to create/update. Empty → no writes. */
      names: string[];
      /** Required confirmation that this is not a dry run. */
      confirmApply: true;
      /**
       * Required when any named command is an update (same name already exists).
       * Same-name remotes may belong to another TS6 feature — do not overwrite casually.
       */
      confirmSameNameOverwrite?: true;
      /**
       * Optional prior dry-run plan. applicationId/guildId must match this client and
       * the apply guildId (blocks silent retargeting between plan and apply).
       */
      fromPlan?: SlashRegistrationPlan;
      injectedRemote?: RemoteGuildCommand[];
    },
  ): Promise<SlashRegistrationApplyResult> {
    if (optsApply.confirmApply !== true) {
      throw new Error('apply requires confirmApply: true');
    }
    const id = assertGuildSnowflake(guildId);

    if (optsApply.fromPlan) {
      if (optsApply.fromPlan.applicationId !== opts.applicationId) {
        throw new Error('fromPlan applicationId does not match registration client.');
      }
      if (optsApply.fromPlan.guildId !== id) {
        throw new Error('fromPlan guildId does not match apply guildId.');
      }
    }

    // Recompute plan at apply time to reduce stale-plan overwrite risk.
    const plan = await dryRun(id, optsApply.injectedRemote);
    if (plan.validationErrors.length) {
      throw new Error(`Slash registry invalid: ${plan.validationErrors[0]}`);
    }
    if (plan.applicationId !== opts.applicationId || plan.guildId !== id) {
      throw new Error('Registration plan target mismatch.');
    }

    const wanted = new Set(optsApply.names.map((n) => n.trim()).filter(Boolean));
    const applied: SlashRegistrationApplyResult['applied'] = [];
    const skipped: string[] = [];
    const errors: SlashRegistrationApplyResult['errors'] = [];

    const creatable = new Map(plan.create.map((c) => [c.name, c]));
    const updatable = new Map(plan.update.map((u) => [u.local.name, u.local]));

    const wantsUpdate = [...wanted].some((name) => updatable.has(name));
    if (wantsUpdate && optsApply.confirmSameNameOverwrite !== true) {
      throw new Error(
        'Same-name updates require confirmSameNameOverwrite: true (remote may belong to another feature).',
      );
    }

    for (const name of wanted) {
      if (plan.collisions.some((c) => c.remote.name === name)) {
        errors.push({ name, message: 'name collision; refusing to upsert' });
        continue;
      }
      const def = creatable.get(name) ?? updatable.get(name);
      if (!def) {
        skipped.push(name);
        continue;
      }
      const action = creatable.has(name) ? 'create' : 'update';
      try {
        const { json } = await request('POST', guildCommandsUrl(id), toDiscordCommandBody(def));
        const remoteId = typeof (json as { id?: unknown })?.id === 'string'
          ? (json as { id: string }).id
          : undefined;
        applied.push({ name, action, id: remoteId });
      } catch (err) {
        errors.push({
          name,
          message: redactAuth(err instanceof Error ? err.message : String(err), authorization),
        });
      }
    }

    return {
      applicationId: opts.applicationId,
      guildId: id,
      dryRun: false,
      applied,
      skipped,
      errors,
    };
  }

  return {
    dryRun,
    apply,
    planAgainst,
    formatPlan,
    guildCommandsUrl,
  };
}

/** Offline dry-run helper for CLI / admin previews (no network when remote is provided). */
export function previewSlashRegistration(opts: {
  applicationId: string;
  guildId: string;
  remote?: RemoteGuildCommand[];
  local?: SlashCommandDefinition[];
}): { plan: SlashRegistrationPlan; text: string } {
  const client = createSlashRegistrationClient({
    applicationId: opts.applicationId,
    authorization: 'Bot preview-only-unused',
    transport: {
      async fetch() {
        throw new Error('previewSlashRegistration must not perform HTTP');
      },
    },
  });
  const plan = client.planAgainst(opts.guildId, opts.remote ?? [], opts.local);
  return { plan, text: client.formatPlan(plan) };
}
