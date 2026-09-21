import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tokensApi } from '@/api/bans.api';
import { useServerStore } from '@/stores/server.store';
import { DataTable } from '@/components/shared/DataTable';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { KeyRound, Trash2, Copy } from 'lucide-react';
import { type ColumnDef } from '@tanstack/react-table';
import { toast } from 'sonner';

export default function Tokens() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const { data, isLoading } = useQuery({ queryKey: ['tokens', c, s], queryFn: () => tokensApi.list(c!, s!), enabled: !!c && !!s });
  const qc = useQueryClient();
  const deleteToken = useMutation({ mutationFn: (token: string) => tokensApi.delete(c!, s!, token), onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }) });

  const tokens = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const columns: ColumnDef<any>[] = useMemo(() => [
    { accessorKey: 'token', header: 'Token', cell: ({ getValue }) => (
      <div className="flex items-center gap-1">
        <span className="font-mono-data text-xs truncate max-w-[200px]">{getValue() as string}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy privilege key"
          onClick={() => { void navigator.clipboard.writeText(getValue() as string); toast.success('Copied'); }}
        >
          <Copy className="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>
    )},
    { accessorKey: 'token_type', header: 'Type', cell: ({ getValue }) => <span className="text-xs">{(getValue() as number) === 0 ? 'Server Group' : 'Channel Group'}</span> },
    { accessorKey: 'token_id1', header: 'Group ID', cell: ({ getValue }) => <span className="font-mono-data text-xs">{getValue() as number}</span> },
    { accessorKey: 'token_description', header: 'Description', cell: ({ getValue }) => <span className="text-xs">{(getValue() as string) || '-'}</span> },
    { id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => (
      <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" aria-label="Delete privilege key" onClick={() => deleteToken.mutate(row.original.token, { onSuccess: () => toast.success('Token deleted') })}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    )},
  ], [deleteToken.mutate]);

  if (!c || !s) return <EmptyState icon={KeyRound} title="No server selected" />;
  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Privilege Keys</h1>
      <DataTable
        columns={columns}
        data={tokens}
        searchEnabled
        searchLabel="Search privilege keys"
        searchPlaceholder="Search tokens..."
        tableLabel="Privilege keys table"
        density="compact"
        stickyHeader
        emptyText="No privilege keys found"
        filteredEmptyText="No privilege keys match your search"
      />
    </div>
  );
}
