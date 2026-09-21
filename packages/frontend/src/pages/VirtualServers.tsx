import { useRef, useState } from 'react';
import { useStartVirtualServer, useStopVirtualServer, useVirtualServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { formatUptime } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api-error';
import { Server, Play, Square, Users, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type StopTarget = {
  configId: number;
  sid: number;
  name: string;
};

export default function VirtualServers() {
  const { selectedConfigId } = useServerStore();
  const { data, isLoading } = useVirtualServers();
  const startServer = useStartVirtualServer();
  const stopServer = useStopVirtualServer();
  const [startingSid, setStartingSid] = useState<number | null>(null);
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [stopError, setStopError] = useState('');
  const actionGuards = useRef(new Set<string>());
  const stopCancelButton = useRef<HTMLButtonElement>(null);

  if (!selectedConfigId) return <EmptyState icon={Server} title="No server selected" />;
  if (isLoading) return <PageLoader />;

  const servers = Array.isArray(data) ? data : [];

  const handleStart = (sid: number, name: string) => {
    const configId = selectedConfigId;
    const guardKey = `start:${configId}:${sid}`;
    if (actionGuards.current.has(guardKey)) return;
    actionGuards.current.add(guardKey);
    setStartingSid(sid);
    startServer.mutate(
      { configId, sid },
      {
        onSuccess: () => toast.success(`Started ${name}`),
        onError: (error) => toast.error(`Could not start ${name}: ${apiErrorMessage(error, 'The server did not accept the request')}`),
        onSettled: () => {
          actionGuards.current.delete(guardKey);
          setStartingSid((current) => current === sid ? null : current);
        },
      },
    );
  };

  const closeStopDialog = () => {
    setStopTarget(null);
    setStopError('');
  };

  const handleStop = () => {
    if (!stopTarget) return;
    const target = stopTarget;
    const guardKey = `stop:${target.configId}:${target.sid}`;
    if (actionGuards.current.has(guardKey)) return;
    actionGuards.current.add(guardKey);
    setStopError('');
    stopServer.mutate(
      { configId: target.configId, sid: target.sid },
      {
        onSuccess: () => {
          toast.success(`Stopped ${target.name}`);
          closeStopDialog();
        },
        onError: (error) => {
          const message = `Could not stop ${target.name}: ${apiErrorMessage(error, 'The server did not accept the request')}`;
          setStopError(message);
          toast.error(message);
        },
        onSettled: () => { actionGuards.current.delete(guardKey); },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Virtual Servers</h1>
        <Badge variant="secondary" className="font-mono-data">{servers.length} server(s)</Badge>
      </div>

      <div className="grid gap-3">
        {servers.map((vs: any) => (
          <Card
            key={vs.virtualserver_id}
            role="group"
            aria-label={`${vs.virtualserver_name} virtual server`}
            className="hover:border-primary/30 transition-colors"
          >
            <CardContent className="p-4">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                    <Server className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{vs.virtualserver_name}</span>
                      <Badge variant={vs.virtualserver_status === 'online' ? 'success' : 'secondary'} className="text-[10px]">
                        {vs.virtualserver_status?.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono-data">SID: {vs.virtualserver_id}</span>
                      <span className="font-mono-data">Port: {vs.virtualserver_port}</span>
                      {vs.virtualserver_status === 'online' && (
                        <>
                          <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {vs.virtualserver_clientsonline - (vs.virtualserver_queryclientsonline || 0)}/{vs.virtualserver_maxclients}</span>
                          <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatUptime(vs.virtualserver_uptime || 0)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  {vs.virtualserver_status === 'online' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setStopTarget({ configId: selectedConfigId, sid: Number(vs.virtualserver_id), name: String(vs.virtualserver_name) });
                        setStopError('');
                      }}
                    >
                      <Square className="h-3 w-3 mr-1" /> Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleStart(Number(vs.virtualserver_id), String(vs.virtualserver_name))}
                      disabled={startingSid === Number(vs.virtualserver_id)}
                      aria-busy={startingSid === Number(vs.virtualserver_id)}
                    >
                      <Play className="h-3 w-3 mr-1" />
                      {startingSid === Number(vs.virtualserver_id) ? 'Starting…' : 'Start'}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!stopTarget}
        onOpenChange={(open) => { if (!open && !stopServer.isPending) closeStopDialog(); }}
      >
        <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); stopCancelButton.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Stop virtual server</DialogTitle>
            <DialogDescription>
              Stop <span className="font-medium text-foreground">{stopTarget?.name}</span> (SID {stopTarget?.sid}). All connected users will be disconnected.
            </DialogDescription>
          </DialogHeader>
          {stopError && <p role="alert" className="text-sm text-destructive">{stopError}</p>}
          <DialogFooter>
            <Button ref={stopCancelButton} className="min-h-10" variant="outline" onClick={closeStopDialog} disabled={stopServer.isPending}>Cancel</Button>
            <Button
              className="min-h-10"
              variant="destructive"
              onClick={handleStop}
              disabled={stopServer.isPending}
              aria-busy={stopServer.isPending}
            >
              <Square className="h-4 w-4 mr-1" />
              {stopServer.isPending ? 'Stopping…' : 'Stop server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
