import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { serversApi } from '@/api/servers.api';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Cpu, Save, Server, Globe } from 'lucide-react';
import { formatBytes, formatUptime } from '@/lib/utils';
import { apiErrorMessage, teamSpeakQueryRetry } from '@/lib/api-error';
import { toast } from 'sonner';

const floodAwareRetry = teamSpeakQueryRetry;

export default function Instance() {
  const { selectedConfigId: c } = useServerStore();
  const qc = useQueryClient();
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  const infoQuery = useQuery({
    queryKey: ['instance-info', c],
    queryFn: () => serversApi.instanceInfo(c!),
    enabled: !!c,
    retry: floodAwareRetry,
    refetchInterval: (query) => (query.state.error as any)?.response?.status === 429 ? 15_000 : false,
  });
  const hostQuery = useQuery({
    queryKey: ['host-info', c],
    queryFn: () => serversApi.hostInfo(c!),
    enabled: !!c,
    retry: floodAwareRetry,
    refetchInterval: (query) => (query.state.error as any)?.response?.status === 429 ? 15_000 : false,
  });
  const versionQuery = useQuery({
    queryKey: ['version', c],
    queryFn: () => serversApi.version(c!),
    enabled: !!c,
    retry: floodAwareRetry,
    refetchInterval: (query) => (query.state.error as any)?.response?.status === 429 ? 15_000 : false,
  });

  const { data: info, isLoading: loadingInfo, error: infoError, isFetching: fetchingInfo, refetch: refetchInfo } = infoQuery;
  const { data: host, isLoading: loadingHost, error: hostError, isFetching: fetchingHost, refetch: refetchHost } = hostQuery;
  const { data: version, error: versionError, refetch: refetchVersion } = versionQuery;

  const editMutation = useMutation({
    mutationFn: (data: any) => serversApi.instanceEdit(c!, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['instance-info', c] }); toast.success('Instance settings updated'); setEditFields({}); },
    onError: (error) => toast.error(apiErrorMessage(error, 'Failed to update instance settings')),
  });

  if (!c) return <EmptyState icon={Cpu} title="No server selected" />;
  if ((loadingInfo || loadingHost) && !info && !host) return <PageLoader />;

  const loadError = infoError || hostError || versionError;
  if (!info && !host && loadError) {
    const detail = apiErrorMessage(loadError, 'Could not load instance data from the TeamSpeak server.');
    return (
      <div className="space-y-4">
        <EmptyState icon={Cpu} title="Instance unavailable" description={detail} />
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={fetchingInfo || fetchingHost}
            onClick={() => {
              void refetchInfo();
              void refetchHost();
              void refetchVersion();
            }}
          >
            {(fetchingInfo || fetchingHost) ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  const instanceData = Array.isArray(info) ? info[0] : info;
  const hostData = Array.isArray(host) ? host[0] : host;
  const versionData = Array.isArray(version) ? version[0] : version;

  const editableFields = [
    { key: 'serverinstance_guest_serverquery_group', label: 'Guest ServerQuery Group', type: 'number' },
    { key: 'serverinstance_template_serveradmin_group', label: 'Template Server Admin Group', type: 'number' },
    { key: 'serverinstance_template_serverdefault_group', label: 'Template Server Default Group', type: 'number' },
    { key: 'serverinstance_template_channeldefault_group', label: 'Template Channel Default Group', type: 'number' },
    { key: 'serverinstance_template_channeladmin_group', label: 'Template Channel Admin Group', type: 'number' },
    { key: 'serverinstance_filetransfer_port', label: 'File Transfer Port', type: 'number' },
    { key: 'serverinstance_serverquery_flood_commands', label: 'Flood Commands', type: 'number' },
    { key: 'serverinstance_serverquery_flood_time', label: 'Flood Time (sec)', type: 'number' },
    { key: 'serverinstance_serverquery_flood_ban_time', label: 'Flood Ban Time (sec)', type: 'number' },
  ];

  const handleSave = () => {
    if (Object.keys(editFields).length === 0) return;
    const data: any = {};
    for (const [k, v] of Object.entries(editFields)) data[k] = parseInt(v);
    editMutation.mutate(data);
  };

  const backgroundError = loadError
    ? apiErrorMessage(loadError, 'Instance refresh failed. Retry after the TeamSpeak Query cooldown if flood protection is active.')
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Instance</h1>
        {backgroundError && (
          <p className="text-xs text-amber-600 dark:text-amber-400 max-w-xl" role="status">
            {backgroundError}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Version Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2"><Server className="h-4 w-4 text-primary" /> Version</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <InfoRow label="Version" value={versionData?.version} />
            <InfoRow label="Build" value={versionData?.build} />
            <InfoRow label="Platform" value={versionData?.platform} />
          </CardContent>
        </Card>

        {/* Host Info Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2"><Globe className="h-4 w-4 text-primary" /> Host</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <InfoRow label="Uptime" value={hostData?.instance_uptime ? formatUptime(hostData.instance_uptime) : '-'} />
            <InfoRow label="Bytes Sent" value={hostData?.connection_bytes_sent_total ? formatBytes(hostData.connection_bytes_sent_total) : '-'} />
            <InfoRow label="Bytes Received" value={hostData?.connection_bytes_received_total ? formatBytes(hostData.connection_bytes_received_total) : '-'} />
            <InfoRow label="Virtual Servers" value={hostData?.virtualservers_total_maxclients ? `${hostData.virtualservers_total_clients_online || 0} / ${hostData.virtualservers_total_maxclients}` : '-'} />
          </CardContent>
        </Card>

        {/* Database Info Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2"><Cpu className="h-4 w-4 text-primary" /> Database</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <InfoRow label="DB Plugin" value={instanceData?.serverinstance_database_version} />
            <InfoRow label="FT Port" value={instanceData?.serverinstance_filetransfer_port} />
            <InfoRow label="Permissions Version" value={instanceData?.serverinstance_permissions_version} />
          </CardContent>
        </Card>
      </div>

      {/* Editable Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Instance Settings</CardTitle>
            <Button size="sm" onClick={handleSave} disabled={Object.keys(editFields).length === 0 || editMutation.isPending}>
              <Save className="h-4 w-4 mr-1" /> Save Changes
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {editableFields.map((field) => {
              const current = instanceData?.[field.key];
              return (
                <div key={field.key}>
                  <Label className="text-xs text-muted-foreground">{field.label}</Label>
                  <Input
                    type="number"
                    className="h-8 mt-1 font-mono-data text-xs"
                    defaultValue={current ?? ''}
                    onChange={(e) => setEditFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono-data font-medium">{value ?? '-'}</span>
    </div>
  );
}
