/**
 * Admin allowlist of LAN hosts (Threadfin, xTeVe, TVHeadend, a router proxy …)
 * that IPTV playlists and channels may use. URLs typed in chat or the video
 * URL box stay blocked from private addresses regardless.
 */

import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useIptvNetworkSettings, useUpdateIptvNetworkSettings } from '@/hooks/use-iptv-network';
import { apiErrorMessage } from '@/lib/api-error';
import { parseHostLines } from '@/lib/iptv-network';

export function IptvLocalHostsCard() {
  const query = useIptvNetworkSettings(true);
  const update = useUpdateIptvNetworkSettings();
  const saved = query.data?.allowedLocalHosts ?? [];
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (query.data && draft === null) setDraft(query.data.allowedLocalHosts.join('\n'));
  }, [query.data, draft]);

  if (!query.data || draft === null) return null;

  const hosts = parseHostLines(draft);
  const dirty = hosts.join('\n') !== saved.join('\n');
  const save = () => {
    update.mutate(hosts, {
      onSuccess: (data) => {
        setDraft(data.allowedLocalHosts.join('\n'));
        toast.success(data.allowedLocalHosts.length
          ? 'Local IPTV hosts saved — refresh a playlist to use them'
          : 'Local IPTV hosts cleared');
      },
      onError: (e) => toast.error(apiErrorMessage(e, 'Failed to save local IPTV hosts')),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Network className="h-4 w-4" aria-hidden="true" /> Local network sources
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Playlists and channels on your home network (for example Threadfin, xTeVe or TVHeadend at 192.168.x.x)
          are blocked by default. List the hosts you trust to allow them for IPTV only.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="iptv-local-hosts">Allowed local IPTV hosts</Label>
          <Textarea
            id="iptv-local-hosts"
            rows={3}
            spellCheck={false}
            placeholder={'192.168.1.20\n192.168.1.0/24\nthreadfin.lan'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            One per line: an IP, a range or a hostname. Links typed in chat or the video URL box stay blocked;
            loopback and link-local addresses cannot be allowed.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save hosts'}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved.join('\n'))}>Reset</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
