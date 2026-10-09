# Media Bot UX + encode profiles

**Date:** 2026-09-30  
**Status:** Approved for implementation  
**Outcome:** One PR that renames Music Bot → Media Bot in the product UI, simplifies bot create/edit naming, unifies Play controls, and adds Performance / Balanced / Quality encode profiles with Advanced quality settings collapsed.

## Goals

1. Call bots **Media Bots** everywhere users see “Music Bot(s)”.
2. Route `/media-bots` with a redirect from `/music-bots`.
3. Single **Name** on create/edit (writes both `name` and `nickname`).
4. One **Play** split-button (primary + menu) and one **Stop**; remove the duplicate Play.
5. Play menu: Playlist / Song / Video / Radio / IPTV; remember last action.
6. Encode profiles **Performance / Balanced / Quality** (default Balanced); manual quality under **Advanced**.
7. Pass per-stream encode speed (`cpu-used`) so profiles actually change encode cost.
8. Consistent “Media Bot” copy on Bot Hub / IPTV surfaces.

## Non-goals

- Raw / passthrough video (deferred; TeamSpeak WebRTC needs VP8/H.264 + Opus).
- Renaming Prisma models, REST resource paths, or chat commands (`!play`, `!stream`, `!tv`).
- NVENC or new codecs.

## Naming and routing

| Surface | Change |
|---|---|
| Nav, page titles, dialogs, empty states, tests asserting labels | “Music Bot(s)” → “Media Bot(s)” |
| Route | Add `/media-bots`; redirect `/music-bots` → `/media-bots` |
| DB / API `MusicBot`, `music-bots` API prefixes | Unchanged |
| Default nickname string | Prefer `MediaBot` where a default is still applied |

## Create / edit form

- Show one **Name** field.
- On submit, set `name` and `nickname` to the same trimmed value (required, TeamSpeak nickname length limits apply).
- Keep both DB columns: nickname still rewrites temporarily while media plays; stable UI label can use `name`.

## Transport controls

- Remove the second Play control (the “Play Song…” style duplicate above volume or beside Stop — whichever is redundant after the split-button).
- **Play** split-button:
  - Primary click runs the **last-used** media action (persisted in `localStorage`, keyed globally or per-bot; prefer per-bot when bot id is known).
  - Fallback when unset: **Song**.
  - Chevron opens: Playlist, Song, Video, Radio, IPTV — each opens the existing dialog/flow for that type.
- **Stop** remains adjacent; volume row unchanged.

## Encode profiles

Simple control (defaults card + stream start where quality defaults apply):

| Profile | Auto max | Bitrate clamp | Encode speed (`cpu-used` for libvpx) |
|---|---|---|---|
| Performance | 720p | 2500 kbps | faster (e.g. `6`) |
| Balanced | 1080p | 4500 kbps | default (current `4`) |
| Quality | 1440p | no clamp (`0`) | slower / better (e.g. `2`) |

- Default for new installs / unset setting: **Balanced**.
- Selecting a profile writes `autoMaxPreset`, `maxBitrateKbps`, and encode-speed preference; clears “custom” state.
- **Advanced** (collapsed by default): Auto limit, bitrate limit, default encoder, prefer hardware, and any other existing manual knobs.
- Editing Advanced fields marks the selection as **custom** (simple profile control shows custom / none selected) without deleting the stored advanced values.
- Persist profile as an app setting (e.g. `video_encode_profile`: `performance` \| `balanced` \| `quality` \| `custom`).

### Per-stream encode speed

- Sidecar accepts encode-speed (or `cpuUsed`) on stream start and applies it to software VP8/VP9 args (override env defaults for that process).
- Backend forwards the active profile’s speed (or custom Advanced override if we expose one later — v1: profile or env default only).
- Hardware encoders ignore `cpu-used`; profiles still apply Auto max + bitrate for them.

## Copy consistency

- Bot Hub, IPTV helper text, and related user-visible strings that say “Music Bot” become “Media Bot” where they mean the media-capable bot entity.

## Testing

- Update Playwright / unit assertions for “Media Bots”, `/media-bots`, and redirect.
- Unit tests for profile → settings mapping and create form writing both name fields.
- Sidecar/backend test that stream start passes `cpuUsed` into ffmpeg args for software VP8.

## Rollout

- Feature branch from current `main` (not stacked on WebRTC UDP mux unless that PR is already merged).
- Conventional commit / PR title: `feat: Media Bot UX and encode profiles`.
- Open one PR; CodeRabbit as usual.
