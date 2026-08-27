import { useState } from 'react';
import {
  useServerGroups, useServerGroupMembers, useCreateServerGroup, useDeleteServerGroup,
  useAddServerGroupMember, useRemoveServerGroupMember,
} from '@/hooks/use-groups';
import { useQuery } from '@tanstack/react-query';
import { clientsApi } from '@/api/clients.api';
import { useServerStore } from '@/stores/server.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Shield, Plus, Trash2, Users, ChevronRight, UserMinus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

export default function ServerGroups() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const { data, isLoading, error, refetch, isFetching } = useServerGroups();
  const createGroup = useCreateServerGroup();
  const deleteGroup = useDeleteServerGroup();
  const addMember = useAddServerGroupMember();
  const removeMember = useRemoveServerGroupMember();
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null);
  const { data: members } = useServerGroupMembers(selectedGroup);
  const [showCreate, setShowCreate] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [addCldbid, setAddCldbid] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ sgid: number; name: string } | null>(null);
  const [newName, setNewName] = useState('');

  const { data: onlineClients } = useQuery({
    queryKey: ['clients-for-groups', selectedConfigId, selectedSid],
    queryFn: () => clientsApi.list(selectedConfigId!, selectedSid!),
    enabled: !!selectedConfigId && !!selectedSid && showAddMember,
  });

  if (!selectedConfigId || !selectedSid) return <EmptyState icon={Shield} title="No server selected" />;
  if (isLoading) return <PageLoader />;
  if (error) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Shield}
          title="Connection failed"
          description={(error as any)?.response?.data?.error || (error as any)?.message || 'Could not load server groups from the TeamSpeak server.'}
        />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  const groups = Array.isArray(data) ? data : [];
  const clientOptions = (Array.isArray(onlineClients) ? onlineClients : [])
    .filter((c: any) => String(c.client_type) === '0')
    .map((c: any) => ({
      cldbid: Number(c.client_database_id),
      name: c.client_nickname,
    }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Server Groups</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" /> Create Group
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Groups ({groups.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[500px]">
              <div className="p-2 space-y-0.5">
                {groups.map((g: any) => (
                  <button
                    key={g.sgid}
                    onClick={() => setSelectedGroup(g.sgid)}
                    className={cn(
                      'flex items-center justify-between w-full rounded-md px-3 py-2 text-sm transition-colors text-left',
                      selectedGroup === g.sgid ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Shield className="h-3.5 w-3.5" />
                      <span className="truncate">{g.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] font-mono-data">{g.sgid}</Badge>
                      <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                Members
                {selectedGroup && <Badge variant="default" className="font-mono-data text-[10px]">SGID: {selectedGroup}</Badge>}
              </CardTitle>
              {selectedGroup && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setAddCldbid(''); setShowAddMember(true); }}>
                    <UserPlus className="h-3 w-3 mr-1" /> Add member
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                    const g = groups.find((g: any) => g.sgid === selectedGroup);
                    if (g) setDeleteTarget({ sgid: g.sgid, name: g.name });
                  }}>
                    <Trash2 className="h-3 w-3 mr-1" /> Delete Group
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!selectedGroup ? (
              <p className="text-sm text-muted-foreground text-center py-12">Select a group to view its members</p>
            ) : (
              <ScrollArea className="h-[440px]">
                <div className="space-y-1">
                  {Array.isArray(members) && members.length > 0 ? (
                    members.map((m: any, i: number) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/30 transition-colors">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-mono-data text-primary">
                            {m.client_nickname?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span className="text-sm">{m.client_nickname || `DBID: ${m.cldbid}`}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground font-mono-data">DBID: {m.cldbid}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="Remove from group"
                            onClick={() => removeMember.mutate(
                              { sgid: selectedGroup, cldbid: Number(m.cldbid) },
                              {
                                onSuccess: () => toast.success('Member removed'),
                                onError: () => toast.error('Failed to remove member'),
                              },
                            )}
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">No members in this group</p>
                  )}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Server Group</DialogTitle></DialogHeader>
          <div><Label className="text-xs">Group Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New Group" autoFocus /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => { createGroup.mutate(newName, { onSuccess: () => { toast.success('Group created'); setShowCreate(false); setNewName(''); } }); }}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add group member</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Client database ID</Label>
              <Input
                value={addCldbid}
                onChange={(e) => setAddCldbid(e.target.value)}
                placeholder="cldbid"
                className="font-mono-data"
              />
            </div>
            {clientOptions.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Online clients</Label>
                <ScrollArea className="h-40 border rounded-md">
                  <div className="p-1 space-y-0.5">
                    {clientOptions.map((c) => (
                      <button
                        key={c.cldbid}
                        type="button"
                        className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted/50"
                        onClick={() => setAddCldbid(String(c.cldbid))}
                      >
                        {c.name} <span className="text-muted-foreground font-mono-data text-xs">({c.cldbid})</span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMember(false)}>Cancel</Button>
            <Button
              disabled={!selectedGroup || !addCldbid}
              onClick={() => {
                if (!selectedGroup) return;
                addMember.mutate(
                  { sgid: selectedGroup, cldbid: parseInt(addCldbid, 10) },
                  {
                    onSuccess: () => { toast.success('Member added'); setShowAddMember(false); },
                    onError: () => toast.error('Failed to add member'),
                  },
                );
              }}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)} title="Delete Server Group" description={`Delete "${deleteTarget?.name}"?`} confirmLabel="Delete" destructive onConfirm={() => { if (deleteTarget) deleteGroup.mutate(deleteTarget.sgid, { onSuccess: () => { toast.success('Group deleted'); setDeleteTarget(null); setSelectedGroup(null); } }); }} />
    </div>
  );
}
