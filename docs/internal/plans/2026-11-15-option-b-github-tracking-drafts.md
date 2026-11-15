# Option B — prepared GitHub text (do not apply until reviewed)

**Date:** 2026-11-15  
**Instruction:** Draft only. Do **not** edit issue/PR metadata on GitHub until an independent review approves these texts.

Related local docs: [release checklist](./2026-11-06-v1.12.0-release-checklist.md), [v1.12.0 gates](./2026-11-15-v1.12.0-acceptance-gates.md), [v2.0.0 gates](./2026-11-15-v2.0.0-commands-radio-acceptance.md).

---

## Issue #648 — proposed replacement body

**Proposed title:** `[ADHD] Option B release sequence: v1.12.0 → v2.0.0 Commands/Radio → later bridge`

```markdown
## Goal

Ship the owner-approved Option B sequence (2026-11-15):

1. **v1.12.0** — Listener Remote + existing non-breaking changes ([#609](https://github.com/uniskela/ts6-manager/pull/609)).
2. **v2.0.0** — Commands & Radio from [#658](https://github.com/uniskela/ts6-manager/pull/658) (exclude D1), including the accepted radio media-fetcher break.
3. **Later** — Discord ↔ TeamSpeak voice bridge D1–D6.

This supersedes the combined “full v1.12.0 = bridge + Commands + Listener” goal.

## Focus

Finish v1.12.0 acceptance gates and changelog curation for #609; keep #658 draft until after v1.12.0 is released.

## Next

1. Complete Listener-scoped acceptance + owner GO for #609 (no merge until GO).
2. After v1.12.0 tag/images: staging acceptance on final #658 HEAD; squash must use `feat!:` + `BREAKING CHANGE:`.
3. Keep bridge D1–D6 (#504 / #563 / Bridge-K) on the later track — outside both releases.

## Resume

Option B documented in-repo (`docs/internal/plans/2026-11-06-v1.12.0-release-checklist.md` and 2026-11-15 gate docs). #658 HEAD at decision: `81eb54089891b38c336ed9d3c736fb800e5256ef`. Do not merge #609 or #658 from this issue alone.

## Attribution
Made with [ADHD Progress Hub](https://github.com/uniskela/adhd-hub)
```

---

## PR #658 — proposed description updates (append or replace Summary framing)

**Keep title:** `feat!: Path A Commands & Radio release candidate (exclude D1)`

**Proposed framing paragraph (top of body):**

```markdown
## Release framing (Option B — 2026-11-15)

This draft is the **v2.0.0 Commands & Radio** candidate. It excludes unfinished Discord voice-bridge **D1**.

- **v1.12.0** (Listener Remote) ships first via Release Please [#609](https://github.com/uniskela/ts6-manager/pull/609) — do **not** merge this PR before that release.
- After merge, Release Please should open **v2.0.0** from the `feat!:` squash (include a `BREAKING CHANGE:` footer for fail-closed radio / media-fetcher). No `Release-As` override expected.
- Voice bridge D1–D6 remains a **later** release.

Radio compatibility: isolated media-fetcher overlay + Landlock ABI ≥ 4; without the fetcher, radio fails closed. Station rows unchanged.
```

Retain existing Summary / Behaviour / Phase / Test plan sections; refresh Phase status when acceptance advances. **Do not merge** until v2.0.0 gates + owner GO.

**Squash commit body reminder (at merge time, not now):**

```text
feat!: Commands & Radio with isolated media-fetcher (exclude D1)

BREAKING CHANGE: remote radio requires the media-fetcher Compose overlay
on Linux with Landlock ABI >= 4; without it, radio fails closed. Station
rows are unchanged. Music and YouTube are unchanged.
```

---

## PR #609 — proposed comment / curation notes (retain v1.12.0 Listener scope)

**Retain title:** `chore(main): release 1.12.0`

**Proposed maintainer comment (or checklist note):**

```markdown
## Option B scope (2026-11-15)

#609 remains the **v1.12.0** Release Please PR for **Listener Remote + non-breaking** work already on `main`.

Out of this release (do not describe as shipped here):

- Commands & Radio → v2.0.0 via #658
- Discord voice bridge D1–D6 → later

### Changelog curation (duplicate / collapse candidates)

From the current generated body, before merge:

1. **Duplicate fix lines:** `fix: route in-channel command replies through SSH helper` appears twice (`806abde` / `cb0d4c0`) — collapse to one bullet.
2. Keep Listener Remote feature/fix bullets that describe shipped behaviour; collapse near-duplicate incremental remote/playlist bullets only when they describe the same user-facing change (human curation after final tip).
3. Do **not** add bridge or Commands bullets.

Do not merge until Listener acceptance gates + explicit owner GO.
```

---

## Issue #659 — closure readiness assessment

**Current title:** `[ADHD] PR #658 F1 nameKey migration preflight`

**Assessment (2026-11-15):**

| Check | Result |
|-------|--------|
| F1 intent | Refuse incompatible playlist names before schema push / nameKey upgrade |
| On #658? | **Yes** — commits including `f19a47b3` (`fix(db): refuse incompatible playlist names before schema push`) and follow-ups (`e0493d3f`, `5aee01c0`, `b7cc2b8d`, …) are ancestors of HEAD `81eb5408` |
| Issue body stale? | **Yes** — still says “not pushed” / HEAD `3f71dedb`; F1 has since been integrated into #658 |
| Safe to close? | **Ready to close after a short confirming comment**, once a reviewer agrees F1 is fully represented on current #658 tip. No further F1 implementation work required for Option B docs. |

**Proposed closing comment:**

```markdown
F1 nameKey preflight is integrated on PR #658 (tip `81eb5408` includes `f19a47b3` and follow-up preflight hardening). Closing this tracking issue as done. Remaining Commands & Radio acceptance is tracked under Option B / #658 / #648 — not as open F1 work.
```

**Do not close #659 from this planning commit** until the prepared text is reviewed.
