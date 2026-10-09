# Media Bot UX + Encode Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Media Bot rename + `/media-bots` redirect, single-name create/edit, unified Play split-button with last-used persistence, and Performance/Balanced/Quality encode profiles (Advanced collapsed) with per-stream `cpuUsed` to the sidecar.

**Architecture:** Keep Prisma/API `MusicBot` identifiers; change user-facing copy and routes. Encode profiles are an app-setting layer that maps onto existing `autoMaxPreset` / `maxBitrateKbps` plus a new `cpuUsed` forwarded on `POST /source`. Play UX consolidates the two idle Play entry points on `BotPlayerCard` into one split-button that opens existing dialogs.

**Tech Stack:** React + React Router, TanStack Query, shared `@ts6/common` types, Express backend settings, Go sidecar ffmpeg args.

## Global Constraints

- No Raw/passthrough UI.
- Do not rename Prisma models or REST `/api/music-bots` paths.
- Do not rename chat commands (`!play`, `!stream`, `!tv`).
- Profile defaults: Performance `720p`/`2500`/`6`, Balanced `1080p`/`4500`/`4`, Quality `1440p`/`0`/`2`.
- Default profile for unset settings: `balanced`.
- Branch: `feat/media-bot-ux-encode-profiles` from `main`.
- Conventional commits; one PR titled `feat: Media Bot UX and encode profiles`.

## File map

| File | Responsibility |
|---|---|
| `packages/common/src/types/music.ts` | `VideoEncodeProfile`, extend `VideoStreamSettings`, optional `cpuUsed` on start/source types |
| `packages/backend/src/voice/streaming/encode-profiles.ts` | Profile ↔ settings mapping + cpuUsed |
| `packages/backend/src/utils/app-settings.ts` | Persist `video_encode_profile` (+ cpuUsed if stored) |
| `packages/backend/src/voice/streaming/sidecar-client.ts` | Forward `cpuUsed` on `/source` |
| `packages/backend/src/voice/voice-bot.ts` | Pass cpuUsed when starting ffmpeg source |
| `packages/sidecar/encoders.go` + `main.go` | Accept `cpuUsed` on SourceRequest; apply in `encoderArgs` |
| `packages/frontend/src/lib/encode-profiles.ts` | Frontend profile constants + apply helpers |
| `packages/frontend/src/lib/media-bot-play.ts` | Last-used play action localStorage |
| `packages/frontend/src/components/media/MediaPlaySplitButton.tsx` | Split-button UI |
| `packages/frontend/src/components/video/VideoStreamDefaultsCard.tsx` | Profile control + Advanced collapse |
| `packages/frontend/src/pages/MusicBots.tsx` | Single Name, Play split-button, copy |
| `packages/frontend/src/App.tsx` | `/media-bots` + redirect |
| `packages/frontend/src/pages/BotHub.tsx`, `Iptv.tsx`, nav/sidebar | Media Bot copy + links |
| Tests under `packages/*/…` and Playwright specs | Assertions for labels, routes, profiles, cpuUsed |

---

### Task 1: Encode profile mapping (common + backend)

**Files:**
- Create: `packages/backend/src/voice/streaming/encode-profiles.ts`
- Create: `packages/backend/src/voice/streaming/encode-profiles.test.ts`
- Modify: `packages/common/src/types/music.ts`
- Modify: `packages/backend/src/utils/app-settings.ts`
- Modify: `packages/backend/src/utils/app-settings.video.test.ts`

**Interfaces:**
- Produces: `VideoEncodeProfile = 'performance' | 'balanced' | 'quality' | 'custom'`
- Produces: `ENCODE_PROFILE_PRESETS: Record<'performance'|'balanced'|'quality', { autoMaxPreset, maxBitrateKbps, cpuUsed }>`
- Produces: `applyEncodeProfile(profile): Partial<VideoStreamSettings> & { cpuUsed: number }`
- Produces: `inferEncodeProfile(settings): VideoEncodeProfile`
- Extends `VideoStreamSettings` with `encodeProfile: VideoEncodeProfile` and `cpuUsed: number`

- [ ] **Step 1: Add shared types**

In `packages/common/src/types/music.ts`, add:

```ts
export type VideoEncodeProfile = 'performance' | 'balanced' | 'quality' | 'custom';

export interface VideoStreamSettings {
  noViewerTimeoutSec: number;
  autoMaxPreset: VideoStreamPresetKey;
  defaultEncoder: VideoEncoderRequest;
  preferHardware: boolean;
  maxBitrateKbps: number;
  encodeProfile: VideoEncodeProfile;
  /** libvpx -cpu-used (higher = faster). Hardware encoders ignore this. */
  cpuUsed: number;
}
```

- [ ] **Step 2: Write failing tests for profile mapping**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEncodeProfile, inferEncodeProfile, ENCODE_PROFILE_PRESETS } from './encode-profiles.js';

describe('encode profiles', () => {
  it('maps performance/balanced/quality', () => {
    assert.deepEqual(applyEncodeProfile('performance'), {
      autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6, encodeProfile: 'performance',
    });
    assert.equal(applyEncodeProfile('balanced').cpuUsed, 4);
    assert.equal(applyEncodeProfile('quality').maxBitrateKbps, 0);
  });
  it('infers custom when settings diverge', () => {
    assert.equal(inferEncodeProfile({
      autoMaxPreset: '720p', maxBitrateKbps: 2500, cpuUsed: 6,
    }), 'performance');
    assert.equal(inferEncodeProfile({
      autoMaxPreset: '720p', maxBitrateKbps: 999, cpuUsed: 6,
    }), 'custom');
  });
});
```

- [ ] **Step 3: Implement `encode-profiles.ts` and wire app-settings**

Persist key `video_encode_profile` and `video_cpu_used`. Default profile `balanced` → cpuUsed `4`, autoMax `1080p`, maxBitrate `4500`. When PATCH sets `encodeProfile` to a non-custom value, overwrite autoMax/maxBitrate/cpuUsed from the preset. When PATCH changes autoMax/maxBitrate/cpuUsed independently, set `encodeProfile` to `custom`.

- [ ] **Step 4: Run tests**

```bash
cd packages/backend && pnpm exec tsx --test src/voice/streaming/encode-profiles.test.ts src/utils/app-settings.video.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/common packages/backend/src/voice/streaming/encode-profiles.ts packages/backend/src/voice/streaming/encode-profiles.test.ts packages/backend/src/utils/app-settings.ts packages/backend/src/utils/app-settings.video.test.ts
git commit -m "feat: add Performance/Balanced/Quality encode profile settings"
```

---

### Task 2: Sidecar + backend per-stream `cpuUsed`

**Files:**
- Modify: `packages/sidecar/main.go` (`SourceRequest`, `POST /source`)
- Modify: `packages/sidecar/encoders.go` (`encoderArgs` signature to accept optional cpuUsed)
- Modify: `packages/sidecar/encoders_test.go`
- Modify: `packages/backend/src/voice/streaming/sidecar-client.ts`
- Modify: `packages/backend/src/voice/voice-bot.ts` (source start payload)

**Interfaces:**
- Consumes: settings `cpuUsed` from Task 1
- Produces: JSON field `cpuUsed` on `POST /source` (int; omit or 0 = use env default)

- [ ] **Step 1: Failing Go test**

```go
func TestEncoderArgsHonorsCpuUsed(t *testing.T) {
	spec, _ := lookupEncoder("vp8")
	args := strings.Join(encoderArgs(spec, "2500k", false, 6), " ")
	if !strings.Contains(args, "-cpu-used 6") {
		t.Fatalf("expected cpu-used 6, got %s", args)
	}
}
```

- [ ] **Step 2: Implement**

Add `CpuUsed int` to `SourceRequest`. Change `encoderArgs(spec, vBitrate, lowPower, cpuUsed int)` — when `cpuUsed > 0` use it for vp8/vp9; else env defaults. Decode `cpuUsed` from POST `/source`. Backend sidecar client + voice-bot pass `cpuUsed: this._videoSettings.cpuUsed`.

- [ ] **Step 3: Run tests**

```bash
cd packages/sidecar && go test ./... -count=1
cd packages/backend && pnpm exec tsx --test src/voice/streaming/*.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: pass per-stream cpuUsed into sidecar VP8/VP9 encode"
```

---

### Task 3: Route `/media-bots` + Media Bot copy + single Name

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Modify: `packages/frontend/src/pages/MusicBots.tsx` (form + titles)
- Modify: `packages/frontend/src/pages/BotHub.tsx`
- Modify: `packages/frontend/src/pages/Iptv.tsx`
- Modify: sidebar / nav components that link to Music Bots (grep `Music Bots`)
- Modify: Playwright specs (`sidebar.spec.ts`, `page-header.spec.ts`, `docs-screenshots.spec.ts`, `bot-hub.spec.ts` as needed)
- Modify: `packages/backend/src/voice/voice-bot-manager.ts` default nickname `MediaBot`

- [ ] **Step 1: Routes**

```tsx
<Route path="/media-bots" element={<AdminRoute><MusicBots /></AdminRoute>} />
<Route path="/music-bots" element={<Navigate to="/media-bots" replace />} />
```

Preserve query string: prefer a tiny wrapper or `Navigate` with `useLocation` search if needed:

```tsx
function MusicBotsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/media-bots${search}`} replace />;
}
```

- [ ] **Step 2: Single Name field**

Remove nickname input from create/edit dialog. On submit: `nickname: form.name.trim()`, validate name non-empty (and TS nickname max length if enforced elsewhere). Hide duplicate nickname badge on card when equal to name (or always show name only).

- [ ] **Step 3: Copy pass**

Replace user-visible “Music Bot(s)” with “Media Bot(s)” on Bot Hub cards/links, IPTV alerts, page header title/description, create toasts. Update Bot Hub links to `/media-bots`.

- [ ] **Step 4: Update Playwright assertions; run targeted tests**

```bash
cd packages/frontend && pnpm exec playwright test tests/sidebar.spec.ts tests/page-header.spec.ts --reporter=line
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: rename Music Bot to Media Bot and add /media-bots route"
```

---

### Task 4: Play split-button + last-used + media-type menu

**Files:**
- Create: `packages/frontend/src/lib/media-bot-play.ts`
- Create: `packages/frontend/src/lib/media-bot-play.test.ts`
- Create: `packages/frontend/src/components/media/MediaPlaySplitButton.tsx`
- Modify: `packages/frontend/src/pages/MusicBots.tsx` (`BotPlayerCard`)

**Interfaces:**
- `MediaPlayAction = 'playlist' | 'song' | 'video' | 'radio' | 'iptv'`
- `getLastPlayAction(botId: number): MediaPlayAction`
- `setLastPlayAction(botId: number, action: MediaPlayAction): void`
- Default when unset: `'song'`

- [ ] **Step 1: localStorage helper + unit test**

Key: `ts6.mediaBot.lastPlay.<botId>`. Validate values against the union; invalid → `'song'`.

- [ ] **Step 2: Split-button component**

Primary button runs `onAction(last)`; dropdown lists five actions. Use existing shadcn `Button` + `DropdownMenu`.

- [ ] **Step 3: Wire BotPlayerCard**

Remove full-width “Play Song...” (lines ~321–326) and ghost “Play...” next to Stop (~456–460). Place one `MediaPlaySplitButton` in the Start/Stop row when `isRunning`. Actions:
- `song` → existing `PlaySongDialog` / `onPlay`
- `playlist` → open playlist load UI (existing playlist tab/dialog path used elsewhere on the page)
- `video` → navigate or set tab `?tab=video&bot=<id>`
- `radio` → radio tab/dialog
- `iptv` → navigate `/iptv` (or IPTV picker if already on page)

If playlist/radio need dialogs that only exist as page tabs, primary action for those may `navigate` to `/media-bots?tab=…&bot=…` and persist last-used.

- [ ] **Step 4: Unit test + smoke build**

```bash
cd packages/frontend && pnpm exec vitest run src/lib/media-bot-play.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: unify Media Bot Play into split-button with last-used"
```

---

### Task 5: Video defaults UI — profiles + Advanced

**Files:**
- Create: `packages/frontend/src/lib/encode-profiles.ts` (mirror backend constants for UI)
- Modify: `packages/frontend/src/components/video/VideoStreamDefaultsCard.tsx`
- Modify: docs snippets in `docs/public/video-streaming.md` / `docs/public/environment-variables.md` for profile + cpuUsed

- [ ] **Step 1: UI**

Top control: segmented select **Performance | Balanced | Quality**. Selecting one PATCHes settings via `applyEncodeProfile`.  
Below: collapsible **Advanced** (closed by default) containing existing Auto limit, bitrate, encoder, prefer-hardware, no-viewer timeout. Editing any advanced field that affects profile mapping sets `encodeProfile: 'custom'` (show “Custom” on the simple control).

- [ ] **Step 2: Manual check**

Load defaults card; pick Performance; confirm Auto limit 720p and bitrate 2500; open Advanced; change bitrate → profile shows Custom.

- [ ] **Step 3: Docs one-liner + commit**

```bash
git commit -m "feat: expose encode profiles in video defaults with Advanced collapse"
```

---

### Task 6: Verify, push, open PR

- [ ] **Step 1: Run backend + sidecar + frontend unit tests for touched areas**
- [ ] **Step 2: `git push -u origin HEAD`**
- [ ] **Step 3: `gh pr create`** with summary covering rename, route, Play UX, profiles, cpuUsed; test plan checklist
- [ ] **Step 4: Hub `mark_done` / progress update for thread `20ee460c4492d977`**

---

## Spec coverage check

| Spec item | Task |
|---|---|
| Media Bot rename | 3 |
| `/media-bots` + `/music-bots` redirect | 3 |
| Single Name → name+nickname | 3 |
| Play split-button + menu | 4 |
| Last-used Play | 4 |
| Profiles mapping A + default Balanced | 1, 5 |
| Advanced collapse | 5 |
| Per-stream cpuUsed | 2 |
| Bot Hub / IPTV copy | 3 |
| No Raw | (non-goal) |
