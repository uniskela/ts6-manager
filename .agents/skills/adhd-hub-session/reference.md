# ADHD Hub MCP tools (reference)

| Tool | Purpose |
|------|---------|
| `session_digest` | Compact open threads (id, title, goal, focus, next, blocked, resume) + reminders + `guidance` (expected versions / last local verification status) |
| `report_guidance_health` | Record versions **you** verified locally (doctor / setup `--check` / reading markers). Hub cannot inspect the client FS |
| `check_overlap` | Rank open threads vs a query (uses goal/title/focus, not full PROGRESS.md) |
| `resolve_project` | Map cwd → project slug |
| `list_projects` / `upsert_project` | Project registry |
| `list_open_threads` | Browse unfinished work |
| `upsert_thread` | Create/update a thread (one finishable outcome; optional goal/focus/next) |
| `upsert_progress` | Update structured active state + PROGRESS.md; pass `thread_id` when known; `force_new_thread` for a new outcome; may return `needs_thread_selection` |
| `pause_thread` | Set resume_step on a known thread |
| `mark_done` | Close a known thread |
| `set_reminder` | once / session / daily / random |

## Keeping skills / AGENTS current

Hub owns version pins (`<!-- adhd-hub:guidance-version:N -->`, `hub_skill_version`, `hub_guidance_version`). Detection is **local**:

1. Operator: `adhd-hub doctor --project .` (also records verification on Hub when credentials work)
2. Repair AGENTS only: `adhd-hub setup . --refresh`
3. Opt-in global Hub skills: `adhd-hub setup . --install-skills` (or Marketplace plugin update — see [Cursor plugin skill sync](../../docs/cursor-plugin-skill-sync.md))
4. Agent: if `session_digest.guidance.status` is not `last_verified_current`, mention once + point at doctor/refresh; after a local check, optionally `report_guidance_health`

## Progress routing

- Explicit `thread_id` → update exactly that thread
- `force_new_thread=true` → always create a new outcome thread
- No unfinished threads → create when `create_thread_if_missing`
- One clearly matching unfinished thread (goal/title) → reuse
- Multiple unfinished / ambiguous → `needs_thread_selection` with candidates (does not silently pick newest)

Structured fields: `goal`, `focus` (exactly one), `next_steps` (max 3), `blocked_reason` (omit when empty), `resume_step`.

Setup: configure the `/mcp` endpoint for an ADHD Hub instance you operate and an `Authorization: Bearer` header using an environment variable (for example, `ADHD_HUB_MCP_TOKEN`). Prefer HTTPS; plain HTTP is only for loopback, Docker, or a private LAN/Tailscale network controlled by the operator. Browser session cookies only authorize REST, not MCP. Run `uv run python scripts/probe_mcp.py` from the repo to verify tool discovery. Never paste credentials into progress notes. The Hub stores only the requested project/thread/reminder fields in its configured local SQLite/Markdown directory; this protocol sends no full transcripts.

Hub UI: `{ADHD_HUB_PUBLIC_URL}/ui` when configured.
