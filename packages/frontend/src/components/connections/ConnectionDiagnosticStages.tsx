import { Check, Circle, Loader2, X } from 'lucide-react';
import type { ConnectionDiagnosticReport, DiagnosticStageId, DiagnosticStageResult } from '@ts6/common';
import {
  DIAGNOSTIC_READ_DOES_NOT_AUTHORIZE_WRITES,
  diagnosticSuccessToastMessage,
} from '@/lib/action-guidance';
import { cn } from '@/lib/utils';

const STAGE_LABELS: Record<DiagnosticStageId, string> = {
  reachability: 'Reachability',
  authentication: 'Authentication',
  permissions: 'Read permissions',
  virtual_server: 'Virtual server',
};

const STAGE_ORDER: DiagnosticStageId[] = [
  'reachability',
  'authentication',
  'permissions',
  'virtual_server',
];

export function diagnosticToastMessage(report: ConnectionDiagnosticReport): string {
  if (report.success) {
    return diagnosticSuccessToastMessage(report.version);
  }
  const failed = report.stages.find((s) => s.status === 'fail');
  if (report.partial && failed) {
    return `Partial: ${failed.message}`;
  }
  return failed?.message || 'Connection diagnostics failed';
}

function StageIcon({ status, pending }: { status?: DiagnosticStageResult['status']; pending?: boolean }) {
  if (pending) return <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  if (status === 'ok') return <Check className="h-3 w-3 text-emerald-400" />;
  if (status === 'fail') return <X className="h-3 w-3 text-destructive" />;
  return <Circle className="h-3 w-3 text-muted-foreground/50" />;
}

interface ConnectionDiagnosticStagesProps {
  report?: ConnectionDiagnosticReport | null;
  pending?: boolean;
  className?: string;
  compact?: boolean;
}

export function ConnectionDiagnosticStages({
  report,
  pending = false,
  className,
  compact = false,
}: ConnectionDiagnosticStagesProps) {
  const byId = new Map((report?.stages ?? []).map((s) => [s.id, s]));
  const readPermissionsOk = byId.get('permissions')?.status === 'ok';

  return (
    <div className={cn('space-y-1.5', className)}>
      <ol
        className={cn(
          'grid gap-1.5 text-[11px]',
          compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1',
        )}
        aria-label="WebQuery diagnostic stages"
      >
        {STAGE_ORDER.map((id) => {
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
                <StageIcon status={status} pending={pending && !status} />
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{STAGE_LABELS[id]}</span>
                {!compact && stage?.message && (
                  <span className="block text-muted-foreground leading-snug">{stage.message}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {readPermissionsOk && !pending && (
        <p
          role="note"
          className="text-[11px] leading-snug text-muted-foreground"
          data-testid="diagnostic-read-not-write"
        >
          {DIAGNOSTIC_READ_DOES_NOT_AUTHORIZE_WRITES}
        </p>
      )}
    </div>
  );
}
