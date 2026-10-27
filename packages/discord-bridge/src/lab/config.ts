import { registerSecret } from "../core/redact.js";

export const SLOT_TOKEN_VARS = [0, 1, 2, 3, 4].map((i) => `D1_DISCORD_TOKEN_SLOT_${i}`);
export const OVERFLOW_TOKEN_VAR = "D1_DISCORD_TOKEN_OVERFLOW";
const REQUIRED = [...SLOT_TOKEN_VARS, OVERFLOW_TOKEN_VAR, "D1_DISCORD_GUILD_ID", "D1_DISCORD_CHANNEL_ID", "D1_TS_HOST"];

export interface LabConfig {
  tokens: Record<"overflow" | `slot-${number}`, string>;
  guildId: string;
  channelId: string;
  ts: { host: string; port: number; channel?: string; password?: string };
}

export type ConfigResult = { ok: true; config: LabConfig } | { ok: false; missing: string[]; problems: string[] };

/** Credential presence is reported as SET/MISSING only; values are never returned in errors. */
export function presenceReport(env: NodeJS.ProcessEnv): Record<string, "SET" | "MISSING"> {
  return Object.fromEntries(REQUIRED.map((k) => [k, env[k] ? "SET" : "MISSING"] as const));
}

/** Lab-only: first planned join, then stop. Does not change DAVE wait, gates, or plaintext policy. */
export function labDaveDiagnostic(env: NodeJS.ProcessEnv): {
  singleAttempt: boolean;
  timing?: { maxRecoveries: 0 };
  retry?: { maxAttempts: 1 };
} {
  if (env.D1_DAVE_SINGLE_ATTEMPT !== "1") return { singleAttempt: false };
  return { singleAttempt: true, timing: { maxRecoveries: 0 }, retry: { maxAttempts: 1 } };
}

export function loadLabConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const missing = REQUIRED.filter((k) => !env[k]);
  const problems: string[] = [];
  const tokenVars = [...SLOT_TOKEN_VARS, OVERFLOW_TOKEN_VAR].filter((k) => env[k]);
  if (new Set(tokenVars.map((k) => env[k])).size !== tokenVars.length) problems.push("six distinct bot tokens are required (a token is repeated)");
  const port = Number(env.D1_TS_PORT ?? 9987);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("D1_TS_PORT is not a valid port");
  if (missing.length || problems.length) return { ok: false, missing, problems };
  for (const k of tokenVars) registerSecret(env[k]);
  registerSecret(env.D1_TS_PASSWORD);
  return {
    ok: true,
    config: {
      tokens: {
        "slot-0": env.D1_DISCORD_TOKEN_SLOT_0!,
        "slot-1": env.D1_DISCORD_TOKEN_SLOT_1!,
        "slot-2": env.D1_DISCORD_TOKEN_SLOT_2!,
        "slot-3": env.D1_DISCORD_TOKEN_SLOT_3!,
        "slot-4": env.D1_DISCORD_TOKEN_SLOT_4!,
        overflow: env.D1_DISCORD_TOKEN_OVERFLOW!,
      },
      guildId: env.D1_DISCORD_GUILD_ID!,
      channelId: env.D1_DISCORD_CHANNEL_ID!,
      ts: { host: env.D1_TS_HOST!, port, channel: env.D1_TS_CHANNEL, password: env.D1_TS_PASSWORD },
    },
  };
}
