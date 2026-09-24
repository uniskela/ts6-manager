# Plan: #101 Part B — Custom CSS and recovery

Status: **design approved (Codex analysis); implementation not started**.  
Design attribution: Codex read-only analysis grounded on `main` @ [`bdcbaf3`](https://github.com/uniskela/ts6-manager/commit/bdcbaf3516cb4b886e87e3019133af7cc2964b24), with #126 fixture inspection used only as supporting context for other jobs (not required for Part B).

Refs: [#101](https://github.com/uniskela/ts6-manager/issues/101). Part A (theme/appearance store) is already on `main`. Keep Part B in a **separate PR**; do not fold into Release Please [#120](https://github.com/uniskela/ts6-manager/pull/120).

## Findings

1. Part A is present. The `ts6-ui` store is version 5 and preserves theme, accent, background, motion, intensity, sidebar sections, permission labels, and Query-client visibility.
2. Appearance is available to admins and viewers.
3. Built-in theme application runs before React.
4. The service worker handles explicit app routes and precached assets; it excludes API/WebSocket and authorization-bearing requests.

## Assumptions

- Custom CSS is a preference for this browser/origin, shared across accounts using that origin.
- Apply custom CSS only inside the authenticated management application; remove it on logout.
- Login, setup, and public widgets retain standard styling.
- A small flash of standard styling before custom CSS mounts is acceptable.

## Architecture

1. **Store** — Extend the existing UI store with `customCssText` and `customCssEnabled`, defaulting to `''` and `false`. Increment persistence version; extend both migration and same-version validation without losing existing preferences.
2. **Draft vs commit** — Keep editor changes in a draft. **Save CSS** commits the draft; when enabled, that explicit action updates presentation immediately. Typing and importing never activate CSS.
3. **Injection** — Use one managed `<style>` node after application styles. Assign CSS through `textContent`; never parse it as HTML or create scripts. Remove the node when disabled or outside the authenticated layout. Keep injection out of the existing inline theme bootstrap.
4. **Size limit** — Documented **64 KiB** limit, enforced consistently on import, save, and hydration. Reject oversized input visibly; do not silently truncate.
5. **Import** — Import `.css` locally into the draft only. No upload or URL-import feature.
6. **Disable / Reset** — Disable preserves text. Confirmed Reset clears text and disables the override immediately, retaining Part A preferences.
7. **Safe mode** — Evaluate `?safe-ui=1` before the first possible injection. Latch safe mode for the current document lifetime so redirects and SPA navigation cannot reactivate CSS. Do not persist this latch or erase CSS.
8. **Safe-mode UX** — Show a prominent Appearance notice, automatically expose Advanced controls, and keep Disable/Reset available. Block activation until a normal reload.
9. **Recovery URL** — Explain and provide **before enabling**: `/settings?tab=appearance&safe-ui=1`. Recovery cannot depend on a button remaining visible under hostile CSS.
10. **Warning policy** — Custom CSS can make browser requests through imports, URLs, and other resource constructs. Show that warning before activation and document it. Do not claim sanitization or rely on regex screening as a security boundary.

This introduces no backend storage, credential access, authorization changes, JavaScript execution mechanism, or service-worker changes. CSS can nevertheless obscure controls, spoof presentation, and expose DOM-dependent information through resource requests; treat it as trusted local customization.

## Implementation steps

1. Persistence + runtime injector (store fields, migration, managed `<style>` node).
2. Editor / import / reset UX (draft, Save CSS, local `.css` import, Disable/Reset).
3. Recovery UX (`safe-ui=1` latch, Appearance notice, recovery URL copy before enable).
4. Tests + security/PWA/recovery documentation.

Leave Part A’s design intact. Prefer reviewable commits in one Part B PR.

## Affected files

| Area | Paths |
|------|--------|
| Store | `packages/frontend/src/stores/ui.store.ts` (or current UI preference store) |
| Settings / layout | `packages/frontend/src/pages/Settings.tsx`, `packages/frontend/src/layouts/AppLayout.tsx` |
| New helpers | Focused custom-CSS runtime/helper and editor component under `packages/frontend/src/` |
| Tests | Production Playwright coverage + fixture server |
| Docs | Security / PWA / recovery documentation under `docs/` |

Exact filenames may shift slightly; keep injection out of the inline theme bootstrap.

## Tests

- Disabled defaults; disabled text remaining inert
- Enable / save / disable / reload
- Migration preserving every existing preference; malformed storage
- Size limits and storage failures
- Local import; reset confirmation/cancellation
- Safe mode preserving text and enabled preference
- Seed hostile CSS **before navigation** for `body { display:none }`, hidden navigation, and a fixed overlay
- Recovery through redirects and SPA navigation
- Zero custom-resource requests in safe mode; no HTML/script execution
- Mobile keyboard usability; unchanged PWA/API caching behavior

## Risks and rollback

| Risk | Mitigation |
|------|------------|
| Arbitrary CSS overrides accessibility and semantic colors | Only disabling restores built-in guarantees; document trusted-local policy |
| Large / pathological selectors hurt rendering | 64 KiB cap; reject oversize visibly |
| Hostile CSS hides Disable/Reset | Safe-mode URL before enable; document lifetime latch |

**Rollback:** Remove injector/UI while retaining stored text; safe mode provides immediate user recovery. No database or version bumps.
