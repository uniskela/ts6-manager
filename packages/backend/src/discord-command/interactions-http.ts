import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import type { CommandResult, DiscordCommandIntent } from './adapter.js';
import { parseInteractionEnvelope, planAcknowledgement } from './interaction.js';
import { verifyDiscordSignature } from './security.js';
import type { DiscordInteractionFollowUp } from './follow-up.js';
import {
  discordDeferredAck,
  discordMessageFromResult,
  discordPong,
  safeCommandFailure,
} from './http-response.js';

export type DiscordInteractionAdapter = {
  handle(intent: DiscordCommandIntent): Promise<CommandResult>;
};

export type DiscordInteractionsHttpDeps = {
  publicKeyHex: string;
  /** Resolve adapter per request (supports app.locals injection). */
  getAdapter(req: Request): DiscordInteractionAdapter | null;
  /** Required for deferred commands — missing → 503 before type 5. */
  getFollowUp?(req: Request): DiscordInteractionFollowUp | null;
  /**
   * Trusted Discord application snowflake from configuration.
   * When set, deferred interactions must present the same application_id.
   */
  expectedApplicationId?: string | null;
  /**
   * Trusted receiver clock for signature freshness (never from the request).
   * Defaults to Date.now().
   */
  nowMs?: () => number;
  maxAgeMs?: number;
  /**
   * Observability for deferred delivery failures. Must not log interaction tokens
   * or signed request bodies.
   */
  onDeliveryError?(info: {
    command: string;
    guildId: string;
    reason: 'follow_up_failed' | 'handler_failed';
  }): void;
};

const SIG_HEADER = 'x-signature-ed25519';
const TS_HEADER = 'x-signature-timestamp';

function headerString(req: Request, name: string): string {
  const raw = req.headers[name];
  return typeof raw === 'string' ? raw : '';
}

function rawBodyUtf8(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return '';
}

function sendOnce(res: Response, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.status(status).json(body);
}

/**
 * Discord Interactions endpoint. Mount **before** `express.json()` so the
 * Ed25519 check sees the exact request bytes.
 */
export function createDiscordInteractionsRouter(deps: DiscordInteractionsHttpDeps): Router {
  const router = Router();
  router.post(
    '/',
    express.raw({ type: '*/*', limit: '256kb' }),
    (req: Request, res: Response, next: NextFunction) => {
      void handleInteraction(req, res, deps).catch((err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Interaction handling failed.' });
        }
        next(err);
      });
    },
  );
  return router;
}

/** Fail-closed stub when the feature is enabled but misconfigured. */
export function createDiscordInteractionsMisconfiguredRouter(): Router {
  const router = Router();
  router.post('/', (_req, res) => {
    res.status(503).json({ error: 'Discord interactions are misconfigured.' });
  });
  return router;
}

export function isValidDiscordPublicKeyHex(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

async function handleInteraction(
  req: Request,
  res: Response,
  deps: DiscordInteractionsHttpDeps,
): Promise<void> {
  const body = rawBodyUtf8(req);
  const timestamp = headerString(req, TS_HEADER);
  const signatureHex = headerString(req, SIG_HEADER);
  // Trusted server clock only — never read freshness from the request body/headers.
  const nowMs = deps.nowMs?.() ?? Date.now();

  if (!timestamp || !signatureHex) {
    sendOnce(res, 401, { error: 'Missing signature.' });
    return;
  }

  const verified = verifyDiscordSignature({
    publicKeyHex: deps.publicKeyHex,
    timestamp,
    body,
    signatureHex,
    nowMs,
    maxAgeMs: deps.maxAgeMs,
  });
  if (!verified.ok) {
    sendOnce(res, 401, { error: 'Invalid signature.' });
    return;
  }

  const envelope = parseInteractionEnvelope(body);
  if (envelope && 'ping' in envelope) {
    sendOnce(res, 200, discordPong());
    return;
  }
  if (!envelope) {
    sendOnce(res, 200, discordMessageFromResult({
      ok: false,
      code: 'unauthorized',
      ephemeral: true,
      content: 'Unsupported interaction.',
      ack: 'immediate',
    }));
    return;
  }

  const adapter = deps.getAdapter(req);
  if (!adapter) {
    sendOnce(res, 503, { error: 'Discord command handler is unavailable.' });
    return;
  }

  const parsed = envelope.intent;
  const ack = planAcknowledgement(parsed.command);
  if (ack === 'deferred') {
    const followUp = deps.getFollowUp?.(req) ?? null;
    // Do not type-5 ack without a configured delivery path (Memory stub must be explicit).
    if (!followUp) {
      sendOnce(res, 503, { error: 'Discord follow-up delivery is unavailable.' });
      return;
    }
    if (!envelope.applicationId || !envelope.interactionToken) {
      sendOnce(res, 503, { error: 'Discord follow-up delivery is unavailable.' });
      return;
    }
    const expected = deps.expectedApplicationId?.trim() || '';
    if (expected && envelope.applicationId !== expected) {
      // Signed body must match trusted config application id.
      sendOnce(res, 401, { error: 'Invalid signature.' });
      return;
    }
    // Prefer trusted config id when present; otherwise the verified body id.
    const applicationId = expected || envelope.applicationId;

    // Acknowledge within Discord's deadline; do not await command work first.
    // Exactly one initial acknowledgement (sendOnce guards against doubles).
    sendOnce(res, 200, discordDeferredAck(true));
    const receivedAtMs = nowMs;

    // A handler failure is reported, then delivered as the generic safe failure.
    let result: CommandResult;
    try {
      result = await adapter.handle(parsed);
    } catch {
      deps.onDeliveryError?.({
        command: parsed.command,
        guildId: parsed.guildId,
        reason: 'handler_failed',
      });
      result = safeCommandFailure();
    }

    try {
      await followUp.afterDeferred({
        interactionId: parsed.idempotencyKey,
        guildId: parsed.guildId,
        userId: parsed.userId,
        command: parsed.command,
        result,
        applicationId,
        interactionToken: envelope.interactionToken,
        receivedAtMs,
      });
    } catch {
      deps.onDeliveryError?.({
        command: parsed.command,
        guildId: parsed.guildId,
        reason: 'follow_up_failed',
      });
    }
    return;
  }

  try {
    const result = await adapter.handle(parsed);
    sendOnce(res, 200, discordMessageFromResult(result));
  } catch {
    sendOnce(res, 200, discordMessageFromResult(safeCommandFailure()));
  }
}
