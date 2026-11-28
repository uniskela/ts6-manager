import { PermissionFlagsBits } from "discord.js";

/** The five least-privilege flags the D1 lab is allowed to request. */
export const APPROVED_PERMISSION_NAMES = ["ViewChannel", "Connect", "Speak", "UseVAD", "ChangeNickname"] as const;
export type ApprovedPermissionName = (typeof APPROVED_PERMISSION_NAMES)[number];

/** Documented integer for those five flags. Generation fails if discord.js disagrees. */
export const APPROVED_INVITE_PERMISSIONS = 103810048n;

export const SLOT_APP_ID_VARS = [0, 1, 2, 3, 4].map((i) => `D1_DISCORD_APP_ID_SLOT_${i}`);
export const OVERFLOW_APP_ID_VAR = "D1_DISCORD_APP_ID_OVERFLOW";
export const GUILD_ID_VAR = "D1_DISCORD_GUILD_ID";

export type BotRole = "overflow" | `slot-${number}`;
export type Invite = { role: BotRole; applicationId: string; url: string };

export type StepState = "done" | "skipped" | "unknown";
export type SetupStep = { id: string; state: StepState; detail: string };

export interface SetupInput {
  applicationIds: Record<BotRole, string>;
  guildId?: string;
}

export type SetupResult =
  | { ok: true; invites: Invite[]; permissions: string; steps: SetupStep[]; instructions: string }
  | { ok: false; problems: string[]; steps: SetupStep[]; instructions: string };

const SNOWFLAKE = /^\d{17,20}$/;
const AUTHORIZE = "https://discord.com/oauth2/authorize";

export function isSnowflake(id: string): boolean {
  return SNOWFLAKE.test(id);
}

/** OR of the approved flags from a PermissionFlagsBits-like table. Throws on drift or Administrator. */
export function approvedInviteMask(bits: Record<string, bigint | number>): bigint {
  let mask = 0n;
  for (const name of APPROVED_PERMISSION_NAMES) {
    const v = bits[name];
    if (v === undefined) throw new Error(`PermissionFlagsBits.${name} is missing`);
    mask |= BigInt(v);
  }
  const admin = bits.Administrator;
  if (admin !== undefined && (mask & BigInt(admin)) !== 0n) throw new Error("invite mask includes Administrator");
  if (mask !== APPROVED_INVITE_PERMISSIONS) {
    throw new Error(`invite mask ${mask} is not the approved ${APPROVED_INVITE_PERMISSIONS}`);
  }
  return mask;
}

export function labInviteMask(): bigint {
  return approvedInviteMask(PermissionFlagsBits as unknown as Record<string, bigint | number>);
}

export function inviteUrl(applicationId: string, permissions: bigint, guildId?: string): string {
  const q = new URLSearchParams({ client_id: applicationId, scope: "bot", permissions: permissions.toString() });
  if (guildId) {
    q.set("guild_id", guildId);
    q.set("disable_guild_select", "true");
  }
  return `${AUTHORIZE}?${q}`;
}

const ROLES: BotRole[] = ["slot-0", "slot-1", "slot-2", "slot-3", "slot-4", "overflow"];

export function buildSetup(input: SetupInput): SetupResult {
  const instructions = SETUP_INSTRUCTIONS;
  const problems: string[] = [];
  const steps: SetupStep[] = [];
  const seen = new Map<string, BotRole>();

  for (const role of ROLES) {
    const id = (input.applicationIds[role] ?? "").trim();
    if (!id) {
      problems.push(`${role}: application id is missing`);
      steps.push({ id: `app:${role}`, state: "skipped", detail: "application id not provided" });
      continue;
    }
    if (!isSnowflake(id)) {
      problems.push(`${role}: application id is not a Discord snowflake`);
      steps.push({ id: `app:${role}`, state: "skipped", detail: "application id rejected" });
      continue;
    }
    const prior = seen.get(id);
    if (prior) {
      problems.push(`${role}: application id is reused as ${prior}`);
      steps.push({ id: `app:${role}`, state: "skipped", detail: "duplicate application id" });
      continue;
    }
    seen.set(id, role);
    steps.push({ id: `app:${role}`, state: "done", detail: "application id accepted" });
  }

  let guildId: string | undefined;
  const rawGuild = input.guildId?.trim();
  if (!rawGuild) {
    steps.push({ id: "guild", state: "skipped", detail: "guild id not provided; pick the private test server in the browser" });
  } else if (!isSnowflake(rawGuild)) {
    problems.push("guild: id is not a Discord snowflake");
    steps.push({ id: "guild", state: "skipped", detail: "guild id rejected" });
  } else {
    guildId = rawGuild;
    steps.push({ id: "guild", state: "done", detail: "guild id accepted (pre-selects the server; you still authorise each bot)" });
  }

  let permissions: bigint;
  try {
    permissions = labInviteMask();
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
    steps.push({ id: "urls", state: "skipped", detail: "invite mask rejected" });
    return { ok: false, problems, steps, instructions };
  }

  if (problems.length) {
    steps.push({ id: "urls", state: "skipped", detail: "invite URLs not generated" });
    steps.push({ id: "authorise", state: "unknown", detail: "Discord authorisation is not verified by this helper" });
    steps.push({ id: "roles", state: "unknown", detail: "role permissions are not verified by this helper" });
    return { ok: false, problems, steps, instructions };
  }

  const invites = ROLES.map((role) => ({
    role,
    applicationId: input.applicationIds[role].trim(),
    url: inviteUrl(input.applicationIds[role].trim(), permissions, guildId),
  }));
  steps.push({ id: "urls", state: "done", detail: "six invite URLs generated; not yet authorised" });
  steps.push({ id: "authorise", state: "unknown", detail: "Discord authorisation is not verified by this helper" });
  steps.push({ id: "roles", state: "unknown", detail: "role permissions are not verified by this helper" });
  return { ok: true, invites, permissions: permissions.toString(), steps, instructions };
}

export const SETUP_INSTRUCTIONS = `Each of the six bots must be authorised individually by a server owner or administrator. This helper only prints official OAuth2 links. It cannot create Discord applications, skip the consent screen, or confirm that a bot joined.

Developer Portal (already created apps — do not recreate them):
- Installation: User Install off, Install Link = None.
- Bot: Public Bot off, Require OAuth2 Code Grant off. No privileged intents.
- Token stays in the local lab/.env file. This helper never asks for it.

Private test server:
- In the browser, choose only the dedicated private test guild. If a guild id was supplied, Discord pre-selects it and the picker is locked.
- Enable Developer Mode (Settings → Advanced) to copy the server and voice-channel IDs for lab/.env.

Permissions on the invite: View Channel, Connect, Speak, Use Voice Activity, Change Nickname (${APPROVED_INVITE_PERMISSIONS}). Never Administrator.

After authorising: Server Settings → Roles → each bot role. Keep only those five flags. A new invite does not strip extras from an existing role.`;

export function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv = {}): { input: SetupInput; open: boolean; help: boolean } {
  const ids: Partial<Record<BotRole, string>> = {};
  let guildId = env[GUILD_ID_VAR];
  let open = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--") continue;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--open") open = true;
    else if (a === "--guild") guildId = next();
    else if (a === "--overflow") ids.overflow = next();
    else if (a.startsWith("--slot-") && /^--slot-[0-4]$/.test(a)) ids[`slot-${a.slice("--slot-".length)}` as BotRole] = next();
    else if (a.startsWith("--")) throw new Error(`unknown argument ${a}`);
  }
  for (const [i, v] of SLOT_APP_ID_VARS.entries()) ids[`slot-${i}` as BotRole] ??= env[v];
  ids.overflow ??= env[OVERFLOW_APP_ID_VAR];
  return {
    input: {
      applicationIds: {
        "slot-0": ids["slot-0"] ?? "",
        "slot-1": ids["slot-1"] ?? "",
        "slot-2": ids["slot-2"] ?? "",
        "slot-3": ids["slot-3"] ?? "",
        "slot-4": ids["slot-4"] ?? "",
        overflow: ids.overflow ?? "",
      },
      guildId,
    },
    open,
    help,
  };
}

export function formatSetup(result: SetupResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(`Invite permission mask ${result.permissions} (validated against discord.js PermissionFlagsBits).`);
    lines.push("Authorise one bot at a time. Do not open all six links together.");
    for (const inv of result.invites) lines.push(`${inv.role}: ${inv.url}`);
  } else {
    lines.push("Invite URLs were not generated.");
    for (const p of result.problems) lines.push(`problem: ${p}`);
  }
  lines.push("", "Steps (this helper does not verify Discord):");
  for (const s of result.steps) lines.push(`  [${s.state}] ${s.id}: ${s.detail}`);
  lines.push("", result.instructions);
  return `${lines.join("\n")}\n`;
}

export async function openInvitesSeparately(
  urls: string[],
  io: { prompt: (url: string, index: number, total: number) => Promise<void>; open: (url: string) => Promise<void> },
): Promise<void> {
  for (let i = 0; i < urls.length; i++) {
    await io.prompt(urls[i], i, urls.length);
    await io.open(urls[i]);
  }
}
