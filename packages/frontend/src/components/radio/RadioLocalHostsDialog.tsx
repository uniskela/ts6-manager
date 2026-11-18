/**
 * Admin allowlist of LAN hosts that radio stations may use — a home server, a
 * NAS or a local Icecast running on 192.168.x.x. Radio stations are configured
 * by an administrator, so they get their own list; the IPTV list stays
 * IPTV-only. URLs typed in chat or pasted as links stay blocked.
 */

import { useEffect, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRadioNetworkSettings, useUpdateRadioNetworkSettings } from '@/hooks/use-radio-network';
import { apiErrorMessage } from '@/lib/api-error';
import { parseHostLines } from '@/lib/iptv-network';

const TOOLTIP = 'Allow a home server or LAN radio station';

/** Header control that opens the allowlist dialog. */
export function RadioLocalHostsTrigger({ onClick }: { onClick: () => void }) {
  const query = useRadioNetworkSettings(true);
  const count = query.data?.allowedLocalHosts.length ?? 0;

  return (
    <Button type="button" variant="outline" onClick={onClick} title={TOOLTIP}>
      <Network className="h-4 w-4 mr-1.5" aria-hidden="true" />
      Local hosts
      {count > 0 && (
        <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]" aria-label={`${count} allowed hosts`}>
          {count}
        </Badge>
      )}
    </Button>
  );
}

export function RadioLocalHostsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useRadioNetworkSettings(true);
  const update = useUpdateRadioNetworkSettings();
  const saved = query.data?.allowedLocalHosts ?? [];
  /** null = not loaded for this open cycle (avoids refetch clobbering dirty edits). */
  const [draft, setDraft] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      return;
    }
    // Capture the control that opened the dialog (header button or empty-state hint).
    if (document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.data || draft !== null) return;
    setDraft(query.data.allowedLocalHosts.join('\n'));
  }, [open, query.data, draft]);

  const draftText = draft ?? '';
  const hosts = parseHostLines(draftText);
  const dirty = draft !== null && hosts.join('\n') !== saved.join('\n');

  const save = () => {
    update.mutate(hosts, {
      onSuccess: (data) => {
        setDraft(data.allowedLocalHosts.join('\n'));
        toast.success(data.allowedLocalHosts.length
          ? 'Local radio hosts saved — edit the station to use them'
          : 'Local radio hosts cleared');
      },
      onError: (e) => toast.error(apiErrorMessage(e, 'Failed to save local radio hosts')),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" aria-hidden="true" /> Local network stations
          </DialogTitle>
          <DialogDescription>
            Radio stations on your home network (for example a local Icecast at 192.168.x.x)
            are blocked by default. List the hosts you trust to allow them for radio only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <Label htmlFor="radio-local-hosts">Allowed local radio hosts</Label>
          <Textarea
            id="radio-local-hosts"
            rows={5}
            spellCheck={false}
            placeholder={'192.168.1.20\n192.168.1.0/24\nradio.lan'}
            value={draftText}
            onChange={(e) => setDraft(e.target.value)}
            disabled={draft === null || !query.data}
          />
          <p className="text-xs text-muted-foreground">
            One per line: an IP, a range or a hostname. Links typed in chat stay blocked;
            loopback and link-local addresses cannot be allowed.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setDraft(saved.join('\n'))}>
              Reset
            </Button>
          )}
          <Button type="button" onClick={save} disabled={draft === null || !query.data || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save hosts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
