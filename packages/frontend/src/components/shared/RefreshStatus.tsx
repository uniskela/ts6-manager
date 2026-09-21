import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RefreshStatusProps {
  isRefreshing: boolean;
  idleLabel?: string;
  refreshingLabel?: string;
}

export function RefreshStatus({
  isRefreshing,
  idleLabel = 'Up to date',
  refreshingLabel = 'Refreshing…',
}: RefreshStatusProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      {isRefreshing ? (
        <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success pulse-dot" aria-hidden="true" />
      )}
      <span className="break-words">{isRefreshing ? refreshingLabel : idleLabel}</span>
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
