import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { useServers } from '@/hooks/use-servers';
import { useAuthStore } from '@/stores/auth.store';

export const CONNECTION_SETUP_PATH = '/settings?tab=connections&wizard=1';

interface NoServerSelectedStateProps {
  pageTitle: string;
  icon: LucideIcon;
  /** Shown when connections exist but none (or no virtual server) is selected. */
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
  const { data: servers, isSuccess } = useServers();
  const isAdmin = useAuthStore((state) => state.isAdmin());
  const hasNoConnections = isSuccess && Array.isArray(servers) && servers.length === 0;

  let title = 'No server selected';
  let description = selectDescription;
  if (hasNoConnections) {
    title = isAdmin ? 'No server connection configured' : 'No server connection available';
    description = isAdmin
      ? 'Use the setup wizard in Settings → Connections to add your TeamSpeak server.'
      : 'Ask an administrator to add a TeamSpeak connection or grant you access to one.';
  }

  return (
    <div className="space-y-5">
      <PageHeader title={pageTitle} />
      <EmptyState icon={icon} title={title} description={description}>
        {hasNoConnections && isAdmin && (
          <Button size="sm" asChild>
            <Link to={CONNECTION_SETUP_PATH}>Open connection setup</Link>
          </Button>
        )}
      </EmptyState>
    </div>
  );
}
