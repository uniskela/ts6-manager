/**
 * Admin allowlist of LAN hosts (Threadfin, xTeVe, TVHeadend, a router proxy …)
 * that IPTV playlists and channels may use. URLs typed in chat or the video
 * URL box stay blocked from private addresses regardless.
 */

import { LocalHostsDialog, LocalHostsTrigger, type LocalHostsCopy } from '@/components/shared/LocalHostsDialog';
import { useIptvNetworkSettings, useUpdateIptvNetworkSettings } from '@/hooks/use-iptv-network';

const COPY: LocalHostsCopy = {
  tooltip: 'Allow Threadfin / xTeVe / TVHeadend for IPTV',
  title: 'Local network sources',
  description: 'Playlists and channels on your home network (for example Threadfin, xTeVe or TVHeadend at 192.168.x.x) '
    + 'are blocked by default. List the hosts you trust to allow them for IPTV only.',
  label: 'Allowed local IPTV hosts',
  inputId: 'iptv-local-hosts',
  placeholder: '192.168.1.20\n192.168.1.0/24\nthreadfin.lan',
  hint: 'One per line: an IP, a range or a hostname. Links typed in chat or the video URL box stay blocked; '
    + 'loopback and link-local addresses cannot be allowed.',
  savedToast: 'Local IPTV hosts saved — refresh a playlist to use them',
  clearedToast: 'Local IPTV hosts cleared',
  failedToast: 'Failed to save local IPTV hosts',
};

/** Header / empty-state control that opens the allowlist dialog. */
export function IptvLocalHostsTrigger({ onClick }: { readonly onClick: () => void }) {
  return <LocalHostsTrigger query={useIptvNetworkSettings(true)} tooltip={COPY.tooltip} onClick={onClick} />;
}

export function IptvLocalHostsDialog({ open, onOpenChange }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const query = useIptvNetworkSettings(true);
  const update = useUpdateIptvNetworkSettings();
  return <LocalHostsDialog open={open} onOpenChange={onOpenChange} query={query} update={update} copy={COPY} />;
}
