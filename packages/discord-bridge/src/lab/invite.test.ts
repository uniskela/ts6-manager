import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionFlagsBits } from "discord.js";
import {
  APPROVED_INVITE_PERMISSIONS,
  APPROVED_PERMISSION_NAMES,
  approvedInviteMask,
  buildSetup,
  formatSetup,
  inviteUrl,
  labInviteMask,
  openInvitesSeparately,
  parseSetupArgs,
} from "./invite.js";

const six = {
  "slot-0": "1111111111111111111",
  "slot-1": "1222222222222222222",
  "slot-2": "1333333333333333333",
  "slot-3": "1444444444444444444",
  "slot-4": "1555555555555555555",
  overflow: "1666666666666666666",
};

describe("invite mask", () => {
  it("matches discord.js PermissionFlagsBits and the approved integer, without Administrator", () => {
    const mask = labInviteMask();
    assert.equal(mask, APPROVED_INVITE_PERMISSIONS);
    assert.equal(mask, approvedInviteMask(PermissionFlagsBits as unknown as Record<string, bigint | number>));
    assert.equal((mask & BigInt(PermissionFlagsBits.Administrator)) === 0n, true);
    let rebuilt = 0n;
    for (const n of APPROVED_PERMISSION_NAMES) rebuilt |= BigInt(PermissionFlagsBits[n]);
    assert.equal(rebuilt, mask);
  });
  it("refuses a drifted PermissionFlagsBits table", () => {
    const bits = { ...PermissionFlagsBits, ViewChannel: 1n } as unknown as Record<string, bigint | number>;
    assert.throws(() => approvedInviteMask(bits), /not the approved/);
  });
  it("refuses a table that includes Administrator in the OR", () => {
    const bits = { ViewChannel: 8n, Connect: 0n, Speak: 0n, UseVAD: 0n, ChangeNickname: 0n, Administrator: 8n };
    assert.throws(() => approvedInviteMask(bits), /Administrator/);
  });
});

describe("invite URLs", () => {
  it("uses the bot scope and the validated mask, and pre-selects a guild when given", () => {
    const url = inviteUrl(six["slot-0"], labInviteMask(), "1999999999999999999");
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(parsed.searchParams.get("client_id"), six["slot-0"]);
    assert.equal(parsed.searchParams.get("scope"), "bot");
    assert.equal(parsed.searchParams.get("permissions"), "103810048");
    assert.equal(parsed.searchParams.get("guild_id"), "1999999999999999999");
    assert.equal(parsed.searchParams.get("disable_guild_select"), "true");
  });
  it("omits guild lock when no guild id is given", () => {
    const parsed = new URL(inviteUrl(six.overflow, labInviteMask()));
    assert.equal(parsed.searchParams.has("guild_id"), false);
    assert.equal(parsed.searchParams.has("disable_guild_select"), false);
  });
});

describe("buildSetup", () => {
  it("accepts six distinct application ids and does not claim Discord verified the invites", () => {
    const r = buildSetup({ applicationIds: six, guildId: "1999999999999999999" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.invites.length, 6);
    assert.equal(r.permissions, "103810048");
    assert.deepEqual(r.invites.map((i) => i.role), ["slot-0", "slot-1", "slot-2", "slot-3", "slot-4", "overflow"]);
    assert.equal(r.steps.find((s) => s.id === "urls")?.state, "done");
    assert.equal(r.steps.find((s) => s.id === "authorise")?.state, "unknown");
    assert.equal(r.steps.find((s) => s.id === "roles")?.state, "unknown");
    assert.match(r.instructions, /individually/);
    assert.match(r.instructions, /Public Bot off/);
    assert.match(r.instructions, /private test/);
  });
  it("rejects a duplicate application id", () => {
    const r = buildSetup({ applicationIds: { ...six, "slot-2": six["slot-0"] } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.problems.some((p) => p.includes("reused")));
    assert.equal(r.steps.find((s) => s.id === "urls")?.state, "skipped");
  });
  it("rejects an invalid application id and an invalid guild id", () => {
    const bad = buildSetup({ applicationIds: { ...six, overflow: "not-an-id" } });
    assert.equal(bad.ok, false);
    const guild = buildSetup({ applicationIds: six, guildId: "abc" });
    assert.equal(guild.ok, false);
    if (!guild.ok) assert.ok(guild.problems.some((p) => p.startsWith("guild:")));
  });
  it("treats a missing guild as skipped, not as a generated success", () => {
    const r = buildSetup({ applicationIds: six });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.steps.find((s) => s.id === "guild")?.state, "skipped");
    assert.equal(new URL(r.invites[0].url).searchParams.has("guild_id"), false);
  });
});

describe("parseSetupArgs", () => {
  it("ignores a lone -- so pnpm can forward flags", () => {
    const parsed = parseSetupArgs(["--", "--overflow", six.overflow, "--help"]);
    assert.equal(parsed.help, true);
    assert.equal(parsed.input.applicationIds.overflow, six.overflow);
  });
  it("reads CLI ids over env and leaves --open off unless requested", () => {
    const env = { D1_DISCORD_APP_ID_SLOT_0: "should-not-win", D1_DISCORD_GUILD_ID: "1999999999999999999" };
    const parsed = parseSetupArgs(
      ["--slot-0", six["slot-0"], "--slot-1", six["slot-1"], "--slot-2", six["slot-2"], "--slot-3", six["slot-3"], "--slot-4", six["slot-4"], "--overflow", six.overflow],
      env,
    );
    assert.equal(parsed.open, false);
    assert.equal(parsed.input.applicationIds["slot-0"], six["slot-0"]);
    assert.equal(parsed.input.guildId, "1999999999999999999");
  });
  it("does not treat bot tokens in the environment as application ids", () => {
    const parsed = parseSetupArgs([], {
      D1_DISCORD_TOKEN_SLOT_0: "token-must-not-become-an-id",
      D1_DISCORD_APP_ID_OVERFLOW: six.overflow,
    });
    assert.equal(parsed.input.applicationIds["slot-0"], "");
    assert.equal(parsed.input.applicationIds.overflow, six.overflow);
  });
});

describe("formatSetup", () => {
  it("prints URLs and never echoes a token from the environment", () => {
    const r = buildSetup({ applicationIds: six });
    const text = formatSetup(r);
    assert.match(text, /103810048/);
    assert.match(text, /oauth2\/authorize/);
    assert.equal(text.includes("token-must-not-become-an-id"), false);
    assert.match(text, /\[unknown\] authorise/);
  });
});

describe("openInvitesSeparately", () => {
  it("opens one URL at a time, only after each prompt", async () => {
    const opened: string[] = [];
    const order: string[] = [];
    await openInvitesSeparately(["https://a", "https://b"], {
      prompt: async (url) => {
        order.push(`prompt:${url}`);
      },
      open: async (url) => {
        order.push(`open:${url}`);
        opened.push(url);
      },
    });
    assert.deepEqual(order, ["prompt:https://a", "open:https://a", "prompt:https://b", "open:https://b"]);
    assert.deepEqual(opened, ["https://a", "https://b"]);
  });
});
