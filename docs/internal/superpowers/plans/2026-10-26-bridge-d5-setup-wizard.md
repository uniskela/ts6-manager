# Bridge-D5 Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** [uniskela/ts6-manager#502](https://github.com/uniskela/ts6-manager/issues/502)

**Goal:** Ship a five-step native admin wizard that lets a homelab administrator map one Discord guild/voice channel to one TeamSpeak channel for the 5+1 bridge, without exposing tokens or joining voice until they press Start.

**Architecture:** The wizard is a frontend dialog modeled on `ConnectionSetupWizard`. It talks only to new administrator-only backend routes. The backend stores encrypted tokens with the existing `encrypt()` helper and talks to the isolated Node 24 worker over the internal network with a bearer secret. Invite URLs are built from application IDs using the same official OAuth2 formula as the D1 helper. Discord does not provide an API that creates bot applications for the operator; the wizard explains portal steps and never pretends it can skip them.

**Tech Stack:** TypeScript, Express, Prisma (SQLite), existing `encrypt`/`decrypt` in `packages/backend/src/utils/crypto.ts`, React + TanStack Query, dialog/stepper pattern from `packages/frontend/src/components/connections/ConnectionSetupWizard.tsx`, invite helpers extracted from `packages/discord-bridge/src/lab/invite.ts`.

## Global Constraints

- Complete 5+1 remains v1.12.0. Do not shrink to one bot.
- Do not start this plan until Bridge-D2 (schema + worker wiring) and Bridge-D3 (admin mapping API, enablement) have landed. D5 is the onboarding UI on top of those.
- Do not change D1 audio/security architecture: DAVE required, no plaintext fallback, one elected receiver, one shared TeamSpeak client, human-only receive, no audio files.
- Official Discord APIs only. No self-bots. No application-creation automation. No OAuth2 bypass.
- Invite mask is exactly `103810048`, validated against `discord.js` `PermissionFlagsBits` (View Channel, Connect, Speak, Use VAD, Change Nickname). Never Administrator.
- Tokens stored as `enc:iv:tag:ciphertext` via `encrypt()`. GET responses never include token plaintext or ciphertext. Empty token fields on update mean keep stored value (same rule as WebQuery/SSH).
- Worker mutating API requires `DISCORD_BRIDGE_SECRET`. Do not publish the worker port. `DISCORD_BRIDGE_URL` unset unless compose profile `discord-bridge` is on; production is fatal if the URL is set without the secret.
- Frontend never logs tokens, invite secrets, or TeamSpeak passwords. Do not put secrets in URLs or query strings.
- Verify (login + guild/channel permission + DAVE stack) must not join voice. Start requires an explicit second confirmation.
- Immediate Stop must be visible on the last step and on the running-status page.
- Disabled by default. #442 and #460 stay out of scope. No `feat:` until the owner says v1.12.0 may receive one.
- Do not hand-edit `version.txt`, package versions, `app-version.ts`, or `CHANGELOG.md`.

## What Discord cannot do (do not design around this)

| Wanted | Official support |
|---|---|
| Create six applications from TS6 Manager | **No.** Operator creates them in the Developer Portal. Wizard shows the steps. |
| Read install/permission status with only Application IDs | **No.** Membership and channel permissions require a bot token (or a full OAuth2 code grant we are not using). Status stays `unknown` until tokens are saved and Verify runs. |
| Revoke extra role permissions by generating a new invite | **No.** The wizard must say so and point at Server Settings → Roles. |
| Confirm DAVE from the first-party client Privacy tab | That is a human check. The worker reports `protocolVersion` / `ready` after Start. |
| Enumerate the operator's guilds without a user OAuth token | **No.** Step 1 is enter/select IDs (Developer Mode copy) plus optional guild picker only if a future user-OAuth scope is explicitly approved. Default is typed snowflakes. |

## File Structure

| File | Responsibility |
|---|---|
| `packages/common/src/discord-invite.ts` | Extracted from D1 `invite.ts`: snowflake check, mask from `PermissionFlagsBits`, `inviteUrl`, `buildSetup`. No tokens. |
| `packages/common/src/types/discord-bridge.ts` | Mapping DTO, verify/start/stop/status types. No token fields on GET. |
| `packages/backend/prisma/schema.prisma` | D2 already adds `DiscordBridgeMapping` (one row per TeamSpeak server). D5 does not invent a second store. |
| `packages/backend/src/routes/discord-bridge.routes.ts` | Admin-only GET/PUT mapping, POST verify/start/stop, GET status. |
| `packages/backend/src/services/discord-bridge-worker.ts` | Bearer client to the worker. Never logs the start payload. |
| `packages/frontend/src/components/discord-bridge/DiscordBridgeSetupWizard.tsx` | Five-step dialog. |
| `packages/frontend/src/pages/DiscordBridge.tsx` | Status + Stop after setup. Hidden unless the mapping exists or the admin opens the wizard. |
| `packages/discord-bridge/src/lab/invite.ts` | Re-export from common after extract, so D1 `lab:setup` keeps working. |

---

## Design (product)

**Step 1 — Discord server.** Admin enters guild snowflake and voice-channel snowflake (Developer Mode copy). Short copy: private test/homelab server; bots need View Channel, Connect, Speak, Use Voice Activity, Change Nickname; no Administrator; restrict the voice channel to testers + the six bots. Do not invent IDs.

**Step 2 — Create and invite bots.** Numbered Developer Portal checklist (Public Bot off, Install Link None, no privileged intents). Six Application ID fields (slot 0–4 + overflow). Generate six `scope=bot&permissions=103810048` links, optional `guild_id` + `disable_guild_select=true`. One-at-a-time open is opt-in. Duplicate/invalid IDs rejected. Install status: `unknown` until Verify.

**Step 3 — Secure credentials.** Six password inputs, admin-only route, HTTPS assumed via existing Public URL guidance. Submit over POST/PUT body, not query. Encrypt at rest. GET returns `{ slot0: "set", … }` only. Blank field = keep.

**Step 4 — Connect TeamSpeak.** Reuse the selected `TsServerConfig`. Channel name/id + optional server password + bridge nickname (default `ts6-bridge`). One shared TS client. Verify = connect the worker's TS client and check channel join, then disconnect. Do not keep a lingering TS session from Verify.

**Step 5 — Test and activate.** Verify first: six distinct logins, guild membership, channel perms, native DAVE/Opus present, no voice join. Show per-bot pass/fail without tokens. Start is a second button behind a confirm dialog. After Start: receiver, generation, DAVE per bot, `duplicateReceivers`, health, Stop Bridge.

Participant notice (contract): audio crosses Discord and TeamSpeak; no raw recording.

---

### Task 1: Extract invite helpers into `@ts6/common`

**Files:**
- Create: `packages/common/src/discord-invite.ts`
- Create: `packages/common/src/discord-invite.test.ts`
- Modify: `packages/discord-bridge/src/lab/invite.ts` to re-export the common functions (D1 CLI stays)
- Modify: `packages/common` exports

**Interfaces:**
- Produces: `approvedInviteMask`, `inviteUrl`, `buildSetup`, `isSnowflake`, `APPROVED_INVITE_PERMISSIONS` — same contracts as D1.

- [ ] **Step 1: Move the D1 tests verbatim into common and fail until the module exists**

```ts
it("matches discord.js PermissionFlagsBits and the approved integer, without Administrator", () => {
  const mask = approvedInviteMask(PermissionFlagsBits as unknown as Record<string, bigint | number>);
  assert.equal(mask, 103810048n);
});
```

- [ ] **Step 2: Copy `invite.ts` logic into common. Do not add token parameters.**
- [ ] **Step 3: Point the D1 helper at the common export. `pnpm --filter @ts6/discord-bridge test` and common tests both pass.**

---

### Task 2: Mapping DTO and admin routes (no voice join)

**Files:**
- Create: `packages/common/src/types/discord-bridge.ts`
- Create: `packages/backend/src/routes/discord-bridge.routes.ts`
- Create: `packages/backend/src/routes/discord-bridge.routes.test.ts`
- Modify: `packages/backend/src/routes/settings.routes.ts` style admin gate (`req.user?.role !== 'admin'` → 403)

**Interfaces:**
- Produces:

```ts
type TokenPresence = "set" | "missing";
interface DiscordBridgeMappingView {
  serverId: number;
  guildId: string;
  channelId: string;
  tsChannel?: string;
  applicationIds: Record<"overflow" | `slot-${0 | 1 | 2 | 3 | 4}`, string>;
  tokens: Record<"overflow" | `slot-${0 | 1 | 2 | 3 | 4}`, TokenPresence>;
  enabled: boolean;
}
interface DiscordBridgeVerifyResult {
  bots: Array<{ role: string; ok: boolean; reason?: string }>;
  distinctApplications: boolean;
  daveNative: boolean;
  joinedVoice: false;
}
```

- [ ] **Step 1: Tests**

```ts
it("GET omits token plaintext and ciphertext", async () => {
  const res = await getMapping(admin, serverId);
  assert.equal(res.body.tokens["slot-0"], "set");
  assert.equal(JSON.stringify(res.body).includes("enc:"), false);
  assert.equal(JSON.stringify(res.body).includes(plainToken), false);
});

it("empty token field keeps the stored value", async () => {
  await putMapping(admin, { tokens: { "slot-0": "" } });
  assert.equal(storedStillDecryptsTo(oldToken), true);
});

it("viewer cannot PUT or POST verify", async () => {
  assert.equal((await putMapping(viewer, body)).status, 403);
});

it("POST /verify does not join voice", async () => {
  const res = await verify(admin, serverId);
  assert.equal(res.body.joinedVoice, false);
  assert.equal(workerJoins, 0);
});
```

- [ ] **Step 2: Implement routes. Encrypt on write. Decrypt only in-process to call the worker. Rate-limit verify/start.**
- [ ] **Step 3: Worker verify command: `login` + existing `DiscordBot.verify()` + native smoke. No `join({ receive })`.**

---

### Task 3: Wizard UI (steps 1–3)

**Files:**
- Create: `packages/frontend/src/components/discord-bridge/DiscordBridgeSetupWizard.tsx`
- Create: `packages/frontend/src/api/discord-bridge.api.ts`
- Create: Playwright or unit tests next to `ConnectionSetupWizard` tests if present; otherwise `discord-bridge-wizard.test.tsx`

**Interfaces:**
- Consumes: Task 1 `inviteUrl` / `buildSetup` (bundle the tiny helpers; do not ship tokens to the browser).
- Consumes: Task 2 GET/PUT.

- [ ] **Step 1: Render five slots + overflow ID fields. Generate links locally from IDs (no backend token).**
- [ ] **Step 2: Token inputs `type="password"` `autoComplete="off"`. Submit PUT. After save, refetch GET and show SET/MISSING only.**
- [ ] **Step 3: Tests**

```ts
it("does not claim a bot is installed before verify", () => {
  render(<Step2 ids={six} />);
  assert.match(screen.getByTestId("authorise").textContent ?? "", /unknown/i);
});

it("rejects duplicate application ids in the form", () => {
  // same as D1 buildSetup
});
```

---

### Task 4: TeamSpeak step and activate/stop

**Files:**
- Modify: wizard steps 4–5
- Create: `packages/frontend/src/pages/DiscordBridge.tsx`
- Modify: worker start/stop already specified in D3 — D5 only calls them

- [ ] **Step 1: Verify TS connect/disconnect without holding the session.**
- [ ] **Step 2: Start disabled until Verify passed in this session. Confirm dialog text includes the participant disclosure.**
- [ ] **Step 3: Status page shows `receiver`, `generation`, per-bot DAVE, `duplicateReceivers`, Stop always enabled while running.**

```ts
it("Stop is available without navigating away from Start", () => {
  render(<Step5 running />);
  assert.ok(screen.getByRole("button", { name: /stop bridge/i }));
});
```

---

### Task 5: Homelab copy and fail-closed defaults

**Files:**
- Create: `packages/frontend/src/content/discord-bridge-setup.ts` (copy only)
- Modify: `docs/public/` only when the owner approves publishing v1.12.0 Discord sentences (not this task's merge)

- [ ] Checklist copy: Public Bot off, Install Link None, five permissions, no Administrator, private channel, tokens only in the wizard, evidence/logs redacted.
- [ ] Default `enabled: false`. Default compose does not start the worker.

---

## Review Focus

1. GET mapping leaking `enc:` ciphertext or a token in a log line.
2. Verify that joins voice (treat as a ship blocker).
3. Start without a second confirmation.
4. Invite mask drift vs `PermissionFlagsBits`.
5. Two TeamSpeak servers sharing tokens or PCM (contract isolation).
6. Viewer role reaching any of these routes.

## Out of scope for D5

- D1 live evidence, D2 schema PR, D3 worker enablement internals, D4 (if any) recovery UX beyond Stop, D6 release matrix / consoles.
- Creating Discord applications.
- Recording audio.
- Changing #442 or #460.
