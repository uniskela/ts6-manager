import { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useServers, useVirtualServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { Server } from 'lucide-react';

export function ServerSelector() {
  const { selectedConfigId, selectedSid, setServer, setSid } = useServerStore();
  const { data: servers, isLoading: serversLoading } = useServers();
  const { data: virtualServers, isLoading: virtualServersLoading, isFetching: virtualServersFetching } = useVirtualServers();

  const selectedConnection = servers?.find((server: any) => Number(server.id) === selectedConfigId);

  // Auto-select first server if none selected
  useEffect(() => {
    if (!servers) return;
    if (servers.length === 0) {
      if (selectedConfigId !== null || selectedSid !== null) useServerStore.getState().clearServer();
      return;
    }
    if (!selectedConnection) setServer(Number(servers[0].id));
  }, [servers, selectedConnection, selectedConfigId, selectedSid, setServer]);

  // Auto-select first virtual server
  useEffect(() => {
    if (!selectedConnection || virtualServers === undefined) return;
    const validSid = virtualServers.some((server: any) => Number(server.virtualserver_id) === selectedSid);
    if (virtualServers.length === 0) {
      if (selectedSid !== null) setSid(null);
    } else if (!validSid) {
      setSid(Number(virtualServers[0].virtualserver_id));
    }
  }, [selectedConnection, selectedSid, setSid, virtualServers]);

  const contextLoading = serversLoading || virtualServersLoading || virtualServersFetching;
  const displaySid = contextLoading ? '' : selectedSid?.toString() || '';

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 md:flex-none md:gap-2">
      <Server className="hidden h-4 w-4 shrink-0 text-muted-foreground lg:block" />
      <div className="flex min-w-0 flex-1 items-center gap-1 md:flex-none">
      <span className="sr-only sm:not-sr-only text-[10px] uppercase tracking-wide text-muted-foreground">Connection</span>
      <Select
        value={selectedConfigId?.toString() || ''}
        onValueChange={(v) => setServer(parseInt(v))}
      >
        <SelectTrigger className="h-10 min-w-0 flex-1 px-2 text-xs sm:px-3 md:h-8 md:w-[180px] md:flex-none" aria-label="Select server connection">
          <SelectValue placeholder="Select server..." />
        </SelectTrigger>
        <SelectContent>
          {servers?.map((s: any) => (
            <SelectItem key={s.id} value={s.id.toString()}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      </div>

      {selectedConnection && (
        <>
          <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden="true">/</span>
          <span className="sr-only sm:not-sr-only text-[10px] uppercase tracking-wide text-muted-foreground">Virtual server</span>
          <Select
            value={displaySid}
            onValueChange={(v) => setSid(parseInt(v))}
            disabled={contextLoading || !virtualServers?.length}
          >
            <SelectTrigger className="h-10 min-w-0 flex-1 px-2 text-xs sm:px-3 md:h-8 md:w-[160px] md:flex-none" aria-label="Select virtual server">
              <SelectValue placeholder={contextLoading ? 'Loading virtual servers…' : 'No virtual server'} />
            </SelectTrigger>
            <SelectContent>
              {virtualServers?.map((vs: any) => (
                <SelectItem key={vs.virtualserver_id} value={vs.virtualserver_id.toString()}>
                  {vs.virtualserver_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}
