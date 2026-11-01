import type { CommandResult, DiscordCommandIntent } from './adapter.js';
import { type ReplayGuard, verifyInvokeHmac } from './security.js';

type SessionAdapter = { handle(intent: DiscordCommandIntent): Promise<CommandResult> };

export type OutboundEnvelope = {
  timestamp: string;
  nonce: string;
  body: string;
  signatureHex: string;
  nowMs?: number;
};

/**
 * Customer → Uniskela session. The hub pushes signed intents on this
 * connection; TS6 Manager never exposes an inbound command HTTP route.
 */
export function createOutboundCommandSession(opts: {
  instanceId: string;
  secret: string;
  adapter: SessionAdapter;
  replay: ReplayGuard;
}) {
  let revoked = false;

  return {
    instanceId: opts.instanceId,
    revoke() {
      revoked = true;
    },
    async receive(envelope: OutboundEnvelope): Promise<CommandResult> {
      if (revoked) {
        return { ok: false, code: 'unpaired', ephemeral: true, content: 'This connection was revoked.', ack: 'immediate' };
      }
      const verified = verifyInvokeHmac({
        secret: opts.secret,
        timestamp: envelope.timestamp,
        nonce: envelope.nonce,
        body: envelope.body,
        signatureHex: envelope.signatureHex,
        replay: opts.replay,
        nowMs: envelope.nowMs,
      });
      if (!verified.ok) {
        return { ok: false, code: verified.code, ephemeral: true, content: 'Rejected.', ack: 'immediate' };
      }
      let intent: DiscordCommandIntent;
      try {
        intent = JSON.parse(envelope.body) as DiscordCommandIntent;
      } catch {
        return { ok: false, code: 'unauthorized', ephemeral: true, content: 'Rejected.', ack: 'immediate' };
      }
      if (!intent?.guildId || !intent.userId || !intent.command) {
        return { ok: false, code: 'unauthorized', ephemeral: true, content: 'Rejected.', ack: 'immediate' };
      }
      return opts.adapter.handle(intent);
    },
  };
}
