import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { useServers, useVirtualServers } from '@/hooks/use-servers';
import { useAuthStore } from '@/stores/auth.store';
import { useServerStore } from '@/stores/server.store';

export const CONNECTION_SETUP_PATH = '/settings?tab=connections&wizard=1';

/** `hasNoConnections` is only true once the connection list has loaded and is empty. */
export function useConnectionAvailability() {
  const { data: servers, isSuccess, isPending } = useServers();
  return {
    isPending,
    hasNoConnections: isSuccess && Array.isArray(servers) && servers.length === 0,
  };
}

interface NoServerSelectedStateProps {
  pageTitle: string;
  icon: LucideIcon;
  /** Shown when connections exist but none is selected. */
  selectDescription?: string;
}

/**
 * Keeps the page heading visible and explains how to get past the missing server context,
 * so pages gated on a selected connection never render a bare, title-less dead end.
 */
export function NoServerSelectedState({
  pageTitle,
  icon,
  selectDescription = 'Choose a server connection from the selector in the header.',
}: NoServerSelectedStateProps) {
  const isAdmin = useAuthStore((state) => state.isAdmin());
  const selectedConfigId = useServerStore((state) => state.selectedConfigId);
  const { isPending: connectionsPending, hasNoConnections } = useConnectionAvailability();
  const {
    data: virtualServers,
    isFetching: virtualServersFetching,
    isError: virtualServersFailed,
  } = useVirtualServers();

  const header = <PageHeader title={pageTitle} />;
  const virtualServersResolved = !virtualServersFetching && (virtualServersFailed || Array.isArray(virtualServers));
  const hasVirtualServers = Array.isArray(virtualServers) && virtualServers.length > 0;
  // The header selector auto-selects a connection and virtual server; avoid flashing guidance meanwhile.
  const resolving = connectionsPending
    || (selectedConfigId !== null && (!virtualServersResolved || hasVirtualServers));
  if (resolving) return <div className="space-y-5">{header}</div>;

  let title = 'No server selected';
  let description = selectDescription;
  let action: ReactNode = null;
  if (hasNoConnections) {
    title = isAdmin ? 'No server connection configured' : 'No server connection available';
    description = isAdmin
      ? 'Use the setup wizard in Settings → Connections to add your TeamSpeak server.'
      : 'Ask an administrator to add a TeamSpeak connection or grant you access to one.';
    if (isAdmin) action = <Link to={CONNECTION_SETUP_PATH}>Open connection setup</Link>;
  } else if (selectedConfigId !== null && virtualServersFailed) {
    title = 'Virtual servers unavailable';
    description = 'Virtual servers for the selected connection could not be loaded. Open Virtual Servers for details.';
    if (isAdmin) action = <Link to="/servers">View virtual servers</Link>;
  } else if (selectedConfigId !== null) {
    title = 'No virtual server available';
    description = 'The selected connection has no virtual server to manage. Start one or choose another connection in the header.';
    if (isAdmin) action = <Link to="/servers">View virtual servers</Link>;
  }

  return (
    <div className="space-y-5">
      {header}
      <EmptyState icon={icon} title={title} description={description}>
        {action && <Button size="sm" asChild>{action}</Button>}
      </EmptyState>
    </div>
  );
}

/** Explains disabled create actions on pages that still list existing items. */
export function ConnectionRequiredNotice({ children }: { children: ReactNode }) {
  const isAdmin = useAuthStore((state) => state.isAdmin());
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span>{children}</span>
      </p>
      {isAdmin && (
        <Button size="sm" variant="outline" asChild>
          <Link to={CONNECTION_SETUP_PATH}>Open connection setup</Link>
        </Button>
      )}
    </div>
  );
}
