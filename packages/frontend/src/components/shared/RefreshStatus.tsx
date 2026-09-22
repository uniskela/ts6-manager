import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type RefreshStatusTone = 'live' | 'degraded' | 'starting';

interface RefreshStatusProps {
  isRefreshing: boolean;
  /** When not refreshing: live (ok), degraded (failed refresh), or starting (Query warming up). */
  tone?: RefreshStatusTone;
  idleLabel?: string;
  refreshingLabel?: string;
  degradedLabel?: string;
  startingLabel?: string;
}

export function RefreshStatus({
  isRefreshing,
  tone = 'live',
  idleLabel = 'Up to date',
  refreshingLabel = 'Refreshing…',
  degradedLabel = 'Updates interrupted',
  startingLabel = 'Waiting for TeamSpeak Query…',
}: RefreshStatusProps) {
  const effective: 'refreshing' | RefreshStatusTone = isRefreshing ? 'refreshing' : tone;
  const label =
    effective === 'refreshing' ? refreshingLabel
      : effective === 'starting' ? startingLabel
        : effective === 'degraded' ? degradedLabel
          : idleLabel;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      {effective === 'refreshing' ? (
        <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : effective === 'starting' ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" aria-hidden="true" />
      ) : effective === 'degraded' ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success pulse-dot" aria-hidden="true" />
      )}
      <span
        className={cn(
          'break-words',
          effective === 'degraded' || effective === 'starting' ? 'text-warning' : undefined,
        )}
      >
        {label}
      </span>
    </div>
  );
}

interface StaleDataNoticeProps {
  message: string;
  onRetry: () => void;
  isRetrying: boolean;
  retryLabel?: string;
}

export function StaleDataNotice({
  message,
  onRetry,
  isRetrying,
  retryLabel = 'Retry refresh',
}: StaleDataNoticeProps) {
  return (
    <div role="status" className="flex min-w-0 flex-col gap-3 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <p className="min-w-0 break-words text-foreground">{message}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={isRetrying} aria-busy={isRetrying} className="shrink-0">
        {isRetrying ? 'Retrying…' : retryLabel}
      </Button>
    </div>
  );
}
