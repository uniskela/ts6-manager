# Media Bots Requests tab

**Date:** 2026-09-30  
**Status:** Approved  
**Depends on:** #209 (Media Bot UX / `/media-bots`)

## Goal

Move System → Music Request History into Media Bots as a **Requests** tab with Play/Enqueue, and redirect `/music-requests`.

## Design

- Tab: `/media-bots?tab=requests`
- Remove sidebar link under System
- `/music-requests` → `/media-bots?tab=requests`
- Rows: title, time, Play / Enqueue (bot picker if multiple running), open URL secondary
- Empty state for no `!play` history

## Non-goals

- Changing request recording
- Non-admin request UI
