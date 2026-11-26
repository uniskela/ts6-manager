/**
 * Admin allowlist of LAN hosts that radio stations may use — a home server, a
 * NAS or a local Icecast running on 192.168.x.x. Radio stations are configured
 * by an administrator, so they get their own list; the IPTV list stays
 * IPTV-only. URLs typed in chat or pasted as links stay blocked.
 */

import { LocalHostsDialog, LocalHostsTrigger, type LocalHostsCopy } from '@/components/shared/LocalHostsDialog';
import { useRadioNetworkSettings, useUpdateRadioNetworkSettings } from '@/hooks/use-radio-network';

const COPY: LocalHostsCopy = {
  tooltip: 'Allow a home server or LAN radio station',
  title: 'Local network stations',
  description: 'Radio stations on your home network (for example a local Icecast at 192.168.x.x) '
    + 'are blocked by default. List the hosts you trust to allow them for radio only.',
  label: 'Allowed local radio hosts',
  inputId: 'radio-local-hosts',
  placeholder: '192.168.1.20\n192.168.1.0/24\nradio.lan',
  hint: 'One per line: an IP, a range or a hostname. Links typed in chat stay blocked; '
    + 'loopback and link-local addresses cannot be allowed.',
  savedToast: 'Local radio hosts saved — add or edit the station to use them',
  clearedToast: 'Local radio hosts cleared',
  failedToast: 'Failed to save local radio hosts',
};

/** Header control that opens the allowlist dialog. */
export function RadioLocalHostsTrigger({ onClick }: { readonly onClick: () => void }) {
  return <LocalHostsTrigger query={useRadioNetworkSettings(true)} tooltip={COPY.tooltip} onClick={onClick} />;
}

export function RadioLocalHostsDialog({ open, onOpenChange }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const query = useRadioNetworkSettings(true);
  const update = useUpdateRadioNetworkSettings();
  return <LocalHostsDialog open={open} onOpenChange={onOpenChange} query={query} update={update} copy={COPY} />;
}
