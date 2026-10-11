import type { MediaAdminDiagnosticReport, MediaDiagnosticStatus } from '@ts6/common';
import { redactDiagnosticText } from '@ts6/common';

export function mediaDiagnosticStatusWord(status: MediaDiagnosticStatus): string {
  if (status === 'ok') return 'Green';
  if (status === 'warning') return 'Warning';
  if (status === 'fail') return 'Failed';
  return 'Not checked';
}

export function mediaDiagnosticOverallWord(overall: MediaAdminDiagnosticReport['overall']): string {
  if (overall === 'ok') return 'Green';
  if (overall === 'partial') return 'Warning';
  return 'Failed';
}

function line(status: MediaDiagnosticStatus, label: string, message: string, version?: string): string {
  const versionSuffix = version ? ` (${version})` : '';
  return `- [${mediaDiagnosticStatusWord(status)}] ${label} — ${message}${versionSuffix}`;
}

/** Plain-text report for the clipboard. Redacts again in case the payload was edited. */
export function formatMediaDiagnosticReport(report: MediaAdminDiagnosticReport): string {
  const checks = report.checks.map((check) => {
    const row = [
      line(check.status, check.label, check.message, check.version),
      ...(check.path ? [`  executable: ${check.path}`] : []),
    ].join('\n');
    return check.remediation ? `${row}\n  ${check.remediation}` : row;
  });
  const sidecarVersion = report.sidecar.version ?? 'not reported by GET /health';
  const encoders = report.encoders.items.map((item) => {
    const kind = item.hardware ? 'hardware' : 'software';
    const state = item.available ? 'available' : `unavailable${item.detail ? ` — ${item.detail}` : ''}`;
    return `- ${item.id} (${item.codec}, ${kind}): ${state}`;
  });
  const warnings = report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ['- none'];
  return redactDiagnosticText([
    'TS6 Manager media diagnostics',
    `Checked: ${report.checkedAt}`,
    `Overall: ${mediaDiagnosticOverallWord(report.overall)}`,
    '',
    'Checks:',
    ...checks,
    '',
    `Sidecar (${report.sidecar.mode}): [${mediaDiagnosticStatusWord(report.sidecar.status)}] ${report.sidecar.message}`,
    `  version: ${sidecarVersion}`,
    `  health: ${report.sidecar.healthStatus ?? 'not reported'}`,
    `  video port: ${report.sidecar.videoPort ?? 'not reported'}`,
    `  audio port: ${report.sidecar.audioPort ?? 'not reported'}`,
    '',
    `Encoders: [${mediaDiagnosticStatusWord(report.encoders.status)}] ${report.encoders.message}`,
    ...(encoders.length ? encoders : ['- not loaded']),
    '',
    'Warnings:',
    ...warnings,
  ].join('\n'));
}
