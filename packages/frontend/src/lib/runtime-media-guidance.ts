/**
 * Slice 6 PR5 — action-local copy for runtime/media diagnostics.
 */

import type { RuntimeMediaStageId, RuntimeMediaStageResult } from '@ts6/common';

export const RUNTIME_MEDIA_NOT_CHECKED =
  'Not checked. Use Refresh to probe yt-dlp, ffmpeg, ffprobe, and the media sidecar.';

export const RUNTIME_MEDIA_YTDLP_UPDATE_HINT =
  'Bundled yt-dlp does not self-update at runtime — pull or rebuild the TS6 Manager image to refresh it.';

export const RUNTIME_MEDIA_SIDECAR_START_HINT =
  'Video and IPTV streaming need a reachable media sidecar (Docker SIDECAR_URL or a local binary).';

const STAGE_LABELS: Record<RuntimeMediaStageId, string> = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  sidecar: 'Sidecar',
};

export function runtimeMediaStageLabel(id: RuntimeMediaStageId): string {
  return STAGE_LABELS[id];
}

/** Compact prerequisite line beside Start Stream / IPTV Stream when a stage failed. */
export function runtimeMediaPrerequisiteMessage(
  stages: RuntimeMediaStageResult[] | undefined,
  focus: RuntimeMediaStageId[] = ['sidecar', 'ffmpeg', 'yt-dlp'],
): string | null {
  if (!stages?.length) return null;
  for (const id of focus) {
    const stage = stages.find((s) => s.id === id);
    if (stage?.status === 'fail') {
      return stage.message;
    }
  }
  return null;
}

export function runtimeMediaOverallLabel(
  overall: 'ok' | 'partial' | 'fail' | undefined,
  unchecked: boolean,
): string {
  if (unchecked) return 'Not checked';
  if (overall === 'ok') return 'Ready';
  if (overall === 'partial') return 'Partial';
  if (overall === 'fail') return 'Unavailable';
  return 'Not checked';
}
