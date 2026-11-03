import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseTrustProxy } from './trust-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/** Comma-separated Discord role snowflakes; empty → fail closed until configured. */
function envRoleIds(name: string): string[] {
  const raw = (process.env[name] || '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'file:./data/ts6webui.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  tsAllowSelfSigned: process.env.TS_ALLOW_SELF_SIGNED === 'true' || process.env.TS_ALLOW_SELF_SIGNED === '1',
  /** Off by default. When true, requires DISCORD_PUBLIC_KEY (64-char hex). */
  discordInteractionsEnabled: envFlag('DISCORD_INTERACTIONS_ENABLED'),
  discordPublicKeyHex: (process.env.DISCORD_PUBLIC_KEY || '').trim(),
  /**
   * Discord application snowflake for Edit Original Interaction Response.
   * Required (with public key) before deferred commands can be acknowledged.
   */
  discordApplicationId: (process.env.DISCORD_APPLICATION_ID || '').trim(),
  /**
   * Bot token for guild slash-command registration (Step 3B.2).
   * Never used at startup; only by an explicit dry-run/apply workflow.
   * Prefer reading from env at apply time rather than logging this value.
   */
  discordBotToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
  /** Must match DiscordGuildBinding.instanceId; no cross-instance bot fallback. */
  discordInstanceId: (process.env.DISCORD_INSTANCE_ID || 'local').trim() || 'local',
  discordViewerRoleIds: envRoleIds('DISCORD_VIEWER_ROLE_IDS'),
  discordAdminRoleIds: envRoleIds('DISCORD_ADMIN_ROLE_IDS'),
};
