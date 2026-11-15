# Option B — prepared GitHub text (do not apply until reviewed)

**Date:** 2026-11-15 (corrected after independent review)  
**Instruction:** Draft only. Do **not** edit issue/PR metadata on GitHub until an independent review approves these texts. These drafts do **not** authorise merging, publishing, or deployment.

Related local docs: [release checklist](./2026-11-06-v1.12.0-release-checklist.md), [v1.12.0 gates](./2026-11-15-v1.12.0-acceptance-gates.md), [v2.0.0 gates](./2026-11-15-v2.0.0-commands-radio-acceptance.md).

---

## Issue #648 — proposed replacement body

**Proposed title:** `[ADHD] Option B release sequence: v1.12.0 → v2.0.0 Commands/Radio → later bridge`

```markdown
## Goal

Ship the owner-approved Option B sequence (**15 November 2026**):

1. **v1.12.0** — Changes already on `main` (Listener Remote, music search, playlist voting, session/auth hardening, related music/UI improvements) via [#609](https://github.com/uniskela/ts6-manager/pull/609). Security gates unchanged.
2. **v2.0.0** — Breaking Discord Commands & Radio from [#658](https://github.com/uniskela/ts6-manager/pull/658) (exclude D1), including the accepted radio media-fetcher break.
3. **Later** — Discord ↔ TeamSpeak voice bridge D1–D6.

**Supersedes (10 November 2026):** the combined goal “full v1.12.0 = Bridge D1–D6 + Commands & Radio + Listener Remote”.

## Focus

Finish v1.12.0 acceptance (including the additional security workstream) and changelog curation for #609; keep #658 draft until after v1.12.0 is released.

## Next

1. Complete v1.12.0 acceptance + owner GO for #609 (no merge until GO).
2. After v1.12.0 tag/images: staging acceptance on final #658 HEAD; **squash merge only** with curated subject/body (see below).
3. Keep bridge D1–D6 (#504 / #563 / Bridge-K) on the later track — outside both releases.

## Resume

Option B documented in-repo (`docs/internal/plans/2026-11-06-v1.12.0-release-checklist.md` and 2026-11-15 gate docs). #658 HEAD at decision: `81eb54089891b38c336ed9d3c736fb800e5256ef`. Do not merge #609 or #658 from this issue alone.

## Attribution
Made with [ADHD Progress Hub](https://github.com/uniskela/adhd-hub)
```

---

## PR #658 — proposed description updates (append framing; do not change title yet)

**Keep current title** until merge time (do not modify the PR in this docs task).

**Proposed framing paragraph (top of body):**

```markdown
## Release framing (Option B — 15 November 2026)

This draft is the **v2.0.0 Discord Commands & Radio** candidate. It excludes unfinished Discord voice-bridge **D1**.

- **v1.12.0** (on-`main` Listener Remote / music / session work) ships first via Release Please [#609](https://github.com/uniskela/ts6-manager/pull/609) — do **not** merge this PR before that release.
- **Merge method:** squash merge **only** (no merge commit, no rebase merge). Manually edit the squash subject and body.
- Required squash subject:

  `feat!: Commands & Radio with isolated media-fetcher (exclude D1)`

- Squash body must include a `BREAKING CHANGE:` footer covering the isolated media-fetcher overlay, supported Linux/Landlock environment, and unavailable legacy in-process radio path (see acceptance gates doc).
- After squash-merge, confirm Release Please proposes **v2.0.0**, not v1.13.0. No `Release-As` override expected if sequencing is correct.
- Voice bridge D1–D6 remains a **later** release.

Authoritative operator upgrade text for the radio break remains on this PR (today’s “Radio isolated fetcher” section + `radio-fetcher.md` + nameKey preflight). Recommendation for later reconciliation after v1.12.0: rename that heading to “Upgrading to 2.0.0”.
```

**Exact squash message to use at merge time (not now):**

```text
feat!: Commands & Radio with isolated media-fetcher (exclude D1)

BREAKING CHANGE: remote radio requires the isolated media-fetcher Compose
overlay on a supported Linux host with Landlock ABI >= 4. Without that
fetcher, radio fails closed. The legacy in-process ffmpeg radio path is
unavailable. Station rows are unchanged, but radio URLs must use ports
80/443/8000/8008/8080/8443 and HTTP→HTTPS redirects are refused. Upgrades
stop before schema changes if playlist names collide case-insensitively;
fix them first. YouTube playback is unchanged. Discord Commands & Radio
is optional and does not enable voice bridging.
```

---

## PR #609 — proposed comment / curation notes

**Retain title:** `chore(main): release 1.12.0`

```markdown
## Option B scope (15 November 2026)

#609 remains the **v1.12.0** Release Please PR for changes already on `main` (Listener Remote, music search, playlist voting, session/auth hardening, related music/UI improvements). Security gates are **not** waived.

Out of this release (do not describe as shipped here):

- Discord Commands & Radio → v2.0.0 via #658
- Discord–TeamSpeak voice bridge D1–D6 → later

Keep legitimate TeamSpeak chat-command entries already on `main` (for example `!playlistvote` / SSH helper routing).

### Changelog curation (do not edit the generated PR from planning alone)

1. **SSH helper:** true duplicate — merge commit `806abdea` (#608) and fix commit `cb0d4c0b` are the same change. **Intended curation:** collapse to one bullet (prefer the fix commit / #608).
2. Do **not** list Discord Commands & Radio or Discord–TeamSpeak voice-bridge bullets as shipped.
3. Collapse other near-duplicate bullets only when they describe the same user-facing change (human curation after final tip).

Do not merge until v1.12.0 acceptance gates (including the additional security workstream) + explicit owner GO.
```

---

## Issue #659 — closure readiness assessment

**Current title:** `[ADHD] PR #658 F1 nameKey migration preflight`

**Assessment (15 November 2026):**

| Check | Result |
|-------|--------|
| F1 intent | Refuse incompatible playlist names before schema push / nameKey upgrade |
| On #658? | **Yes** — integrated; cite `e0493d3f` (`fix(db): refuse empty or unrelated SQLite DBs in nameKey preflight`) among the F1 hardening chain; earlier core refuse commit `f19a47b3` also on the branch. Independent review GO previously recorded for F1. |
| On `main`? | **No** — still only on draft PR #658 |
| Live migration rehearsal | **Outstanding** (refusal / remediation / rollback on a real upgrade path) |
| Issue body stale? | **Yes** — still describes pre-push local-only state |
| Close now? | **Draft closing comment prepared; do not close until reviewed.** Closing the tracking issue does not mean F1 is on `main` or that live rehearsal is done. |

**Proposed closing comment (do not post until reviewed; do not close from this task):**

```markdown
F1 nameKey preflight is integrated on draft PR #658 (including `e0493d3f` and the F1 hardening chain; independent approval recorded). It is **not** on `main` until #658 merges. Live migration rehearsal (refuse / remediate / rollback) remains an outstanding v2.0.0 acceptance gate. Closing this tracking issue as F1 implementation-on-candidate done — not as “shipped on main”.
```
