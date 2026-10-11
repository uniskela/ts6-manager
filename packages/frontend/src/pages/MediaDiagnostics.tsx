import { Copy, RefreshCw, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import type { MediaDiagnosticCheck, MediaDiagnosticStatus } from '@ts6/common';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMediaAdminDiagnostics } from '@/hooks/use-media-admin-diagnostics';
import {
  formatMediaDiagnosticReport,
  mediaDiagnosticOverallWord,
  mediaDiagnosticStatusWord,
} from '@/lib/media-diagnostics-report';

function badgeVariant(status: MediaDiagnosticStatus): 'success' | 'warning' | 'destructive' | 'outline' {
  if (status === 'ok') return 'success';
  if (status === 'warning') return 'warning';
  if (status === 'fail') return 'destructive';
  return 'outline';
}

function CheckRow({ check }: { readonly check: MediaDiagnosticCheck }) {
  return (
    <li className="rounded-md border border-border px-3 py-2" data-status={check.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badgeVariant(check.status)}>{mediaDiagnosticStatusWord(check.status)}</Badge>
        <span className="font-medium">{check.label}</span>
        {check.version && <span className="text-xs text-muted-foreground">{check.version}</span>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{check.message}</p>
      {check.path && <p className="mt-1 break-all text-xs text-muted-foreground">Executable: {check.path}</p>}
      {check.remediation && (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">{check.remediation}</p>
      )}
    </li>
  );
}

export default function MediaDiagnostics() {
  const { report, isFetching, isError, invalidated, notChecked, offlineUnchecked, refresh } = useMediaAdminDiagnostics();

  let statusMessage = '';
  if (isFetching) statusMessage = 'Checking media tools…';
  else if (report) statusMessage = `Last checked: ${new Date(report.checkedAt).toLocaleString()}`;

  const copyReport = async () => {
    if (!report) return;
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard is not available');
      return;
    }
    try {
      await navigator.clipboard.writeText(formatMediaDiagnosticReport(report));
      toast.success('Diagnostic report copied');
    } catch {
      toast.error('Could not copy the diagnostic report');
    }
  };

  return (
    <div className="space-y-4" data-testid="media-diagnostics">
      <PageHeader
        title="Media diagnostics"
        icon={Stethoscope}
        description="Check media tools, audio encoding, and sidecar health."
        badge={report && (
          <Badge variant={badgeVariant(report.overall === 'partial' ? 'warning' : report.overall)}>
            {mediaDiagnosticOverallWord(report.overall)}
          </Badge>
        )}
        actions={(
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyReport()} disabled={!report || isFetching}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy diagnostic report
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => refresh()} disabled={isFetching}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        )}
      />

      <output className="block text-sm text-muted-foreground">{statusMessage}</output>

      {(notChecked || offlineUnchecked) && !report && (
        <p className="text-sm text-muted-foreground">Not checked. Use Refresh when this browser is online.</p>
      )}
      {isError && !isFetching && (
        <p className="text-sm text-destructive">Could not run media diagnostics. Use Refresh to retry.</p>
      )}
      {invalidated && report && (
        <p className="text-sm text-amber-700 dark:text-amber-400">This report is stale. Use Refresh to probe again.</p>
      )}

      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Tools and smoke tests</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {report.checks.map((check) => <CheckRow key={check.id} check={check} />)}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sidecar</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Badge variant={badgeVariant(report.sidecar.status)}>{mediaDiagnosticStatusWord(report.sidecar.status)}</Badge>
              <p>{report.sidecar.message}</p>
              <dl className="grid gap-1 text-muted-foreground sm:grid-cols-2">
                <div>Mode: {report.sidecar.mode}</div>
                <div>Version: {report.sidecar.version ?? 'not reported by GET /health'}</div>
                <div>Health: {report.sidecar.healthStatus ?? 'not reported'}</div>
                <div>Ports: {report.sidecar.videoPort ?? '—'} video / {report.sidecar.audioPort ?? '—'} audio</div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Encoders</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Badge variant={badgeVariant(report.encoders.status)}>{mediaDiagnosticStatusWord(report.encoders.status)}</Badge>
              <p className="text-sm text-muted-foreground">{report.encoders.message}</p>
              {report.encoders.items.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {report.encoders.items.map((item) => {
                    let status: MediaDiagnosticStatus = 'fail';
                    if (item.available) status = 'ok';
                    else if (item.hardware) status = 'warning';
                    return (
                      <li key={item.id} className="flex flex-wrap items-baseline gap-2">
                        <Badge variant={badgeVariant(status)}>
                          {mediaDiagnosticStatusWord(status)}
                        </Badge>
                        <span className="font-medium">{item.id}</span>
                        <span className="text-muted-foreground">
                          {item.codec} · {item.hardware ? 'hardware' : 'software'}
                          {item.detail ? ` — ${item.detail}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Warnings and failures</CardTitle>
            </CardHeader>
            <CardContent>
              {report.warnings.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
