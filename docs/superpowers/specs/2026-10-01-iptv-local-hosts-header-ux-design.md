# IPTV local hosts header UX

**Date:** 2026-10-01  
**Status:** Approved (pending implementation)  
**Scope:** Frontend IPTV page only — allowlist data model unchanged

## Goal

Keep **allowed local IPTV hosts** as a global admin security allowlist (not a playlist), but stop showing it as a permanent card that competes with playlist management. Surface edit behind a secondary header control.

## Problem

The IPTV page always shows a **Local network sources** card at the bottom. That card is rarely edited and makes an empty playlist page feel like two primary jobs.

## Decision

**Approach 1:** Remove the always-visible card. Admins open the same editor from a header button beside **+ Add Playlist**.

## Design

### Header (admin only)

- Secondary button to the left of **+ Add Playlist**, label: **Local hosts**
- Tooltip: `Allow Threadfin / xTeVe / TVHeadend for IPTV`
- Optional badge: saved host count when `> 0`
- Non-admins: no button (same visibility rule as today’s card)

### Editor

- Opens a **dialog** (not a third Add Playlist mode, not a playlist list row)
- Content: reuse current allowlist UI — textarea (one host/CIDR/hostname per line), help copy, Save / Reset
- API unchanged: `GET`/`PUT` `/settings/iptv-network` (`allowedLocalHosts`)
- Success toast can keep the existing “refresh a playlist to use them” hint when hosts are non-empty

### Empty playlist state

- Keep a single primary **+ Add Playlist** CTA
- One short secondary hint (text or subtle link that opens the same dialog), e.g.  
  `Using Threadfin, xTeVe or TVHeadend? Allow its host first.`
- Do **not** add a second large primary button for hosts in the empty state

### Mental model (unchanged)

| Concept | Role |
|---------|------|
| Playlist | Content source (URL or upload) to browse/stream |
| Local hosts | SSRF allowlist for private/LAN targets used by IPTV fetches |

Links typed in chat or the video URL box stay blocked from private addresses regardless of this list.

## Non-goals

- Modeling hosts as a playlist or Add Playlist tab
- Moving the editor only to Settings
- Changing allowlist validation, backend storage, or who may edit (admins only)
- Auto-detecting / scanning LAN devices
- Contextual “allow this host?” prompt when a playlist URL fails (nice follow-up; out of scope)

## Implementation sketch

1. Extract or adapt `IptvLocalHostsCard` into dialog-friendly content (header trigger + dialog shell).
2. Wire trigger in `Iptv.tsx` header next to Add Playlist; remove always-mounted bottom card.
3. Empty-state hint opens the same dialog.
4. Update Playwright coverage in `iptv-local-hosts.spec.ts` for header open → save flow.

## Success criteria

- Empty IPTV page no longer shows a full hosts editor by default
- Admins can still view/edit/save the allowlist in one click from the IPTV header
- Non-admins unchanged
- Existing host parse/save behavior and API contract preserved
