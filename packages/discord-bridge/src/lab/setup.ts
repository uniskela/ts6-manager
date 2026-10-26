/**
 * Bridge-D1 invite helper. Prints official OAuth2 bot URLs from application ids.
 * Does not read or print bot tokens and does not join Discord.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildSetup, formatSetup, openInvitesSeparately, parseSetupArgs } from "./invite.js";

const HELP = `Usage: pnpm run lab:setup -- --slot-0 <id> --slot-1 <id> --slot-2 <id> --slot-3 <id> --slot-4 <id> --overflow <id> [--guild <id>] [--open]

Application ids only. Tokens are not accepted. --open is opt-in and opens one link at a time.
Env fallbacks: D1_DISCORD_APP_ID_SLOT_0..4, D1_DISCORD_APP_ID_OVERFLOW, D1_DISCORD_GUILD_ID.
`;

function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Absolute path + fixed PATH: avoid a writable PATH hijacking `xdg-open` (S4036).
    // Do not inherit process.env — lab tokens must not reach the opener.
    const child = spawn("/usr/bin/xdg-open", [url], {
      stdio: "ignore",
      env: {
        PATH: "/usr/bin:/bin",
        DISPLAY: process.env.DISPLAY ?? "",
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`xdg-open exited ${code}`))));
  });
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseSetupArgs(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const result = buildSetup(parsed.input);
  process.stdout.write(formatSetup(result));
  if (!result.ok) process.exit(2);
  if (!parsed.open) {
    process.stdout.write("Browser opening skipped (pass --open to authorise one bot at a time).\n");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<void>((resolve) => rl.question(q, () => resolve()));
  try {
    await openInvitesSeparately(
      result.invites.map((i) => i.url),
      {
        prompt: async (url, i, n) => {
          process.stdout.write(`\n[${i + 1}/${n}] ${url}\n`);
          await ask("Press Enter to open this one link (Ctrl-C to stop): ");
        },
        open: openUrl,
      },
    );
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
