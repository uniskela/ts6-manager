import { Check, Circle, Loader2, RefreshCw, X } from 'lucide-react';
import type { RuntimeMediaDiagnosticReport, RuntimeMediaStageId, RuntimeMediaStageResult } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { useRuntimeMediaDiagnostics } from '@/hooks/use-runtime-media-diagnostics';
import {
  RUNTIME_MEDIA_NOT_CHECKED,
  RUNTIME_MEDIA_SIDECAR_START_HINT,
  RUNTIME_MEDIA_YTDLP_UPDATE_HINT,
  runtimeMediaOverallLabel,
  runtimeMediaPrerequisiteMessage,
  runtimeMediaStageLabel,
} from '@/lib/runtime-media-guidance';
import { cn } from '@/lib/utils';

const STAGE_ORDER: RuntimeMediaStageId[] = ['yt-dlp', 'ffmpeg', 'ffprobe', 'sidecar'];

function StageIcon({ status, pending }: { status?: RuntimeMediaStageResult['status']; pending?: boolean }) {
  if (pending) return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  if (status === 'ok') return <Check className="h-3 w-3 text-emerald-400" />;
  if (status === 'fail') return <X className="h-3 w-3 text-destructive" />;
  return <Circle className="h-3 w-3 text-muted-foreground/50" />;
}

export interface RuntimeMediaDiagnosticsProps {
  className?: string;
  /** Limit which stages are highlighted / shown (still uses shared query). */
  focus?: RuntimeMediaStageId[];
  /** When false, only manual refresh runs (no page-entry probe). */
  autoEntry?: boolean;
  compact?: boolean;
  /** Show action-local prerequisite line for failed focus stages. */
  showPrerequisite?: boolean;
}

export function RuntimeMediaDiagnostics({
  className,
  focus,
  autoEntry = true,
  compact = true,
  showPrerequisite = false,
}: RuntimeMediaDiagnosticsProps) {
  const {
    report,
    isFetching,
    isError,
    offlineUnchecked,
    notChecked,
    invalidated,
    refresh,
  } = useRuntimeMediaDiagnostics({ autoEntry });

  const stages = report?.stages;
  const byId = new Map((stages ?? []).map((s) => [s.id, s]));
  const visible = focus?.length ? STAGE_ORDER.filter((id) => focus.includes(id)) : STAGE_ORDER;
  const overallLabel = runtimeMediaOverallLabel(
    report?.overall,
    Boolean(notChecked || offlineUnchecked || (!report && !isFetching && !isError)),
  );
  const prerequisite = showPrerequisite
    ? runtimeMediaPrerequisiteMessage(stages, focus ?? ['sidecar', 'ffmpeg', 'yt-dlp'])
    : null;

  return (
    <div
      className={cn('space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2', className)}
      data-testid="runtime-media-diagnostics"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-foreground">
            Runtime / media
            <span className="ml-1.5 font-normal text-muted-foreground">· {overallLabel}</span>
            {invalidated && report && (
              <span className="ml-1.5 font-normal text-amber-500">· stale</span>
            )}
          </p>
          {(notChecked || offlineUnchecked) && !isFetching && (
            <p className="text-[11px] text-muted-foreground leading-snug">{RUNTIME_MEDIA_NOT_CHECKED}</p>
          )}
          {isError && !isFetching && (
            <p className="text-[11px] text-destructive leading-snug">
              Could not run runtime diagnostics. Use Refresh to retry.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => refresh()}
          disabled={isFetching}
          aria-label="Refresh runtime media diagnostics"
          title="Refresh runtime media diagnostics"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
        </Button>
      </div>

      {(report || isFetching) && (
        <ol
          className={cn(
            'grid gap-1.5 text-[11px]',
            compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1',
          )}
          aria-label="Runtime media diagnostic stages"
        >
          {visible.map((id) => {
            const stage = byId.get(id);
            const status = stage?.status;
            return (
              <li
                key={id}
                className={cn(
                  'flex items-start gap-1.5 rounded border border-border/60 px-2 py-1.5',
                  status === 'ok' && 'border-emerald-500/30',
                  status === 'fail' && 'border-destructive/40',
                )}
                title={stage?.message}
              >
                <span className="mt-0.5 shrink-0">
                  <StageIcon status={status} pending={isFetching && !status} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{runtimeMediaStageLabel(id)}</span>
                  {!compact && stage?.message && (
                    <span className="block text-muted-foreground leading-snug">{stage.message}</span>
                  )}
                  {compact && stage?.version && status === 'ok' && (
                    <span className="block truncate text-muted-foreground">{stage.version}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {prerequisite && (
        <p role="note" className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          {prerequisite}
        </p>
      )}

      {report && !isFetching && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          {focus?.includes('yt-dlp') || !focus
            ? RUNTIME_MEDIA_YTDLP_UPDATE_HINT
            : RUNTIME_MEDIA_SIDECAR_START_HINT}
        </p>
      )}
    </div>
  );
}

/** Presentational helper for tests / story-like embeds. */
export function RuntimeMediaDiagnosticsReportView({
  report,
  pending = false,
}: {
  report?: RuntimeMediaDiagnosticReport | null;
  pending?: boolean;
}) {
  const byId = new Map((report?.stages ?? []).map((s) => [s.id, s]));
  return (
    <ol className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4" aria-label="Runtime media diagnostic stages">
      {STAGE_ORDER.map((id) => {
        const stage = byId.get(id);
        return (
          <li key={id} className="flex items-start gap-1.5 rounded border border-border/60 px-2 py-1.5">
            <StageIcon status={stage?.status} pending={pending && !stage} />
            <span className="font-medium">{runtimeMediaStageLabel(id)}</span>
          </li>
        );
      })}
    </ol>
  );
}
