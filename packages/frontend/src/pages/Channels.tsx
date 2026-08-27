import { useMemo, useState } from 'react';
import { useChannels, useCreateChannel, useDeleteChannel, useEditChannel, useMoveChannel } from '@/hooks/use-channels';
import { useClients } from '@/hooks/use-clients';
import { channelsApi } from '@/api/channels.api';
import { useServerStore } from '@/stores/server.store';
import { useAuthStore } from '@/stores/auth.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Hash, Plus, Trash2, Pencil, ChevronRight, ChevronDown, Users, Lock, Volume2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface ChannelNode {
  cid: number;
  pid: number;
  channel_name: string;
  channel_topic: string;
  total_clients: number;
  channel_flag_permanent: number;
  channel_flag_password: number;
  channel_codec_quality: number;
  channel_icon_id?: number;
  channel_banner_gfx_url?: string;
  channel_banner_mode?: number;
  children: ChannelNode[];
}

interface EditChannelForm {
  channel_name: string;
  channel_topic: string;
  channel_password: string;
  channel_description: string;
  channel_icon_id: string;
  channel_banner_gfx_url: string;
  channel_banner_mode: string;
}

const EMPTY_EDIT_FORM: EditChannelForm = {
  channel_name: '',
  channel_topic: '',
  channel_password: '',
  channel_description: '',
  channel_icon_id: '0',
  channel_banner_gfx_url: '',
  channel_banner_mode: '0',
};

interface ClientInfo {
  clid: number;
  cid: number;
  client_nickname: string;
  client_type: string;
  client_away: number;
  client_input_muted: number;
}

function buildTree(channels: any[]): ChannelNode[] {
  const normalized = channels.map((ch) => ({
    ...ch,
    cid: Number(ch.cid),
    pid: Number(ch.pid),
    total_clients: Number(ch.total_clients) || 0,
    channel_flag_permanent: Number(ch.channel_flag_permanent) || 0,
    channel_flag_password: Number(ch.channel_flag_password) || 0,
    channel_codec_quality: Number(ch.channel_codec_quality) || 0,
    channel_icon_id: Number(ch.channel_icon_id) || 0,
    channel_topic: ch.channel_topic || '',
    channel_banner_gfx_url: ch.channel_banner_gfx_url || '',
    channel_banner_mode: Number(ch.channel_banner_mode) || 0,
  }));
  const map = new Map<number, ChannelNode>();
  const roots: ChannelNode[] = [];
  normalized.forEach((ch) => map.set(ch.cid, { ...ch, children: [] }));
  normalized.forEach((ch) => {
    const node = map.get(ch.cid)!;
    if (ch.pid === 0) roots.push(node);
    else map.get(ch.pid)?.children.push(node);
  });
  return roots;
}

function ClientEntry({ client, depth }: { client: ClientInfo; depth: number }) {
  return (
    <div
      className="flex items-center gap-1.5 py-0.5 px-2 text-xs text-muted-foreground"
      style={{ paddingLeft: `${depth * 16 + 28}px` }}
    >
      <div className="h-4 w-4 rounded-full bg-primary/10 flex items-center justify-center text-[8px] font-mono-data text-primary shrink-0">
        {client.client_nickname?.[0]?.toUpperCase() || '?'}
      </div>
      <span className="truncate">{client.client_nickname}</span>
      {client.client_away === 1 && <Badge variant="warning" className="text-[8px] px-1 py-0 h-3.5">Away</Badge>}
      {client.client_input_muted === 1 && !client.client_away && <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5">Muted</Badge>}
    </div>
  );
}

interface TreeNodeProps {
  node: ChannelNode;
  depth?: number;
  isAdmin: boolean;
  clientsByChannel: Map<number, ClientInfo[]>;
  onDelete: (cid: number, name: string) => void;
  onEdit: (node: ChannelNode) => void;
  onDrop: (draggedCid: number, targetCid: number) => void;
  draggedCid: number | null;
  setDraggedCid: (cid: number | null) => void;
}

function ChannelTreeNode({ node, depth = 0, isAdmin, clientsByChannel, onDelete, onEdit, onDrop, draggedCid, setDraggedCid }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [dropOver, setDropOver] = useState(false);
  const hasChildren = node.children.length > 0;
  const clients = clientsByChannel.get(node.cid) || [];
  const hasContent = hasChildren || clients.length > 0;
  const isSpacer = node.channel_name.startsWith('[spacer') || node.channel_name.startsWith('[*spacer');

  if (isSpacer) {
    return (
      <div className="py-0.5" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
        <div className="border-t border-border/40 my-1" />
      </div>
    );
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', String(node.cid));
    e.dataTransfer.effectAllowed = 'move';
    setDraggedCid(node.cid);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedCid && draggedCid !== node.cid) {
      setDropOver(true);
    }
  };

  const handleDragLeave = () => setDropOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOver(false);
    const cidStr = e.dataTransfer.getData('text/plain');
    const cid = Number(cidStr);
    if (cid && cid !== node.cid) {
      onDrop(cid, node.cid);
    }
  };

  const handleDragEnd = () => setDraggedCid(null);

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 py-1 px-2 rounded-sm hover:bg-muted/30 transition-colors group text-sm',
          isAdmin && 'cursor-grab active:cursor-grabbing',
          dropOver && 'bg-primary/10 ring-1 ring-primary/40',
          draggedCid === node.cid && 'opacity-40',
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        draggable={isAdmin}
        onDragStart={isAdmin ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
        {hasContent ? (
          <button onClick={() => setExpanded(!expanded)} className="p-0.5 hover:bg-muted rounded">
            {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </button>
        ) : (
          <span className="w-4" />
        )}

        <Hash className="h-3.5 w-3.5 text-primary/70 shrink-0" />

        <span className="truncate flex-1">{node.channel_name}</span>

        <span className="text-[10px] font-mono-data text-muted-foreground/50 shrink-0">#{node.cid}</span>

        {isAdmin && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onEdit(node)}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={() => onDelete(node.cid, node.channel_name)}
              className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 ml-1">
          {node.channel_flag_password === 1 && <Lock className="h-3 w-3 text-amber-400/60" />}
          {(node.total_clients > 0 || clients.length > 0) && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground font-mono-data">
              <Users className="h-3 w-3" />
              {clients.length || node.total_clients}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <>
          {clients.map((client) => (
            <ClientEntry key={client.clid} client={client} depth={depth + 1} />
          ))}
          {node.children.map((child) => (
            <ChannelTreeNode
              key={child.cid}
              node={child}
              depth={depth + 1}
              isAdmin={isAdmin}
              clientsByChannel={clientsByChannel}
              onDelete={onDelete}
              onEdit={onEdit}
              onDrop={onDrop}
              draggedCid={draggedCid}
              setDraggedCid={setDraggedCid}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default function Channels() {
  const { selectedConfigId, selectedSid } = useServerStore();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const { data: channelData, isLoading: channelsLoading, error: channelsError, refetch: refetchChannels, isFetching: channelsFetching } = useChannels();
  const { data: clientData } = useClients();
  const createChannel = useCreateChannel();
  const deleteChannel = useDeleteChannel();
  const editChannel = useEditChannel();
  const moveChannel = useMoveChannel();

  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ cid: number; name: string } | null>(null);
  const [editTarget, setEditTarget] = useState<ChannelNode | null>(null);
  const [editForm, setEditForm] = useState<EditChannelForm>(EMPTY_EDIT_FORM);
  const [editLoading, setEditLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [draggedCid, setDraggedCid] = useState<number | null>(null);

  const tree = useMemo(() => {
    if (!channelData || !Array.isArray(channelData)) return [];
    return buildTree(channelData);
  }, [channelData]);

  const clientsByChannel = useMemo(() => {
    const map = new Map<number, ClientInfo[]>();
    if (!clientData || !Array.isArray(clientData)) return map;
    for (const c of clientData) {
      if (String(c.client_type) !== '0') continue;
      const cid = Number(c.cid);
      const entry: ClientInfo = {
        clid: Number(c.clid),
        cid,
        client_nickname: c.client_nickname || '?',
        client_type: String(c.client_type),
        client_away: Number(c.client_away) || 0,
        client_input_muted: Number(c.client_input_muted) || 0,
      };
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid)!.push(entry);
    }
    return map;
  }, [clientData]);

  if (!selectedConfigId || !selectedSid) return <EmptyState icon={Hash} title="No server selected" />;
  if (channelsError) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Hash}
          title="Connection failed"
          description={(channelsError as any)?.response?.data?.error || (channelsError as any)?.message || 'Could not load channels from the TeamSpeak server.'}
        />
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => refetchChannels()} disabled={channelsFetching}>
            {channelsFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }
  if (channelsLoading) return <PageLoader />;

  const handleCreate = () => {
    if (!newName.trim()) return;
    createChannel.mutate({ channel_name: newName, channel_flag_permanent: 1 }, {
      onSuccess: () => { toast.success('Channel created'); setShowCreate(false); setNewName(''); },
      onError: () => toast.error('Failed to create channel'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteChannel.mutate(deleteTarget.cid, {
      onSuccess: () => { toast.success('Channel deleted'); setDeleteTarget(null); },
      onError: () => toast.error('Failed to delete channel'),
    });
  };

  const handleEditOpen = async (node: ChannelNode) => {
    setEditTarget(node);
    setEditForm({
      channel_name: node.channel_name,
      channel_topic: node.channel_topic || '',
      channel_password: '',
      channel_description: '',
      channel_icon_id: String(node.channel_icon_id || 0),
      channel_banner_gfx_url: node.channel_banner_gfx_url || '',
      channel_banner_mode: String(node.channel_banner_mode || 0),
    });
    if (!selectedConfigId || !selectedSid) return;

    setEditLoading(true);
    try {
      const info = await channelsApi.get(selectedConfigId, selectedSid, node.cid);
      const ch = Array.isArray(info) ? info[0] : info;
      if (!ch) return;
      setEditForm({
        channel_name: ch.channel_name || node.channel_name,
        channel_topic: ch.channel_topic || '',
        channel_password: '',
        channel_description: ch.channel_description || '',
        channel_icon_id: String(ch.channel_icon_id ?? node.channel_icon_id ?? 0),
        channel_banner_gfx_url: ch.channel_banner_gfx_url || '',
        channel_banner_mode: String(ch.channel_banner_mode ?? 0),
      });
    } catch {
      toast.error('Failed to load full channel details');
    } finally {
      setEditLoading(false);
    }
  };

  const handleEditSave = () => {
    if (!editTarget || !editForm.channel_name.trim()) return;
    const data: Record<string, string | number> = {
      channel_name: editForm.channel_name,
      channel_topic: editForm.channel_topic,
      channel_description: editForm.channel_description,
      channel_banner_gfx_url: editForm.channel_banner_gfx_url,
      channel_banner_mode: parseInt(editForm.channel_banner_mode, 10) || 0,
    };
    const iconId = parseInt(editForm.channel_icon_id, 10);
    if (Number.isFinite(iconId)) data.channel_icon_id = iconId;
    if (editForm.channel_password) data.channel_password = editForm.channel_password;
    editChannel.mutate({ cid: editTarget.cid, data }, {
      onSuccess: () => { toast.success('Channel updated'); setEditTarget(null); },
      onError: () => toast.error('Failed to update channel'),
    });
  };

  const handleDrop = (draggedCid: number, targetCid: number) => {
    moveChannel.mutate({ cid: draggedCid, data: { cpid: targetCid } }, {
      onSuccess: () => toast.success('Channel moved'),
      onError: () => toast.error('Failed to move channel'),
    });
  };

  const totalClients = clientsByChannel.size > 0
    ? Array.from(clientsByChannel.values()).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Channels</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {Array.isArray(channelData) ? channelData.length : 0} channels · {totalClients} clients online
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create Channel
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-primary" />
            Channel Tree
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <div className="space-y-0">
              {tree.map((node) => (
                <ChannelTreeNode
                  key={node.cid}
                  node={node}
                  isAdmin={isAdmin}
                  clientsByChannel={clientsByChannel}
                  onDelete={(cid, name) => setDeleteTarget({ cid, name })}
                  onEdit={handleEditOpen}
                  onDrop={handleDrop}
                  draggedCid={draggedCid}
                  setDraggedCid={setDraggedCid}
                />
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Channel Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New Channel" autoFocus />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createChannel.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(v) => { if (!v) setEditTarget(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Channel{editTarget ? ` #${editTarget.cid}` : ''}</DialogTitle>
          </DialogHeader>
          {editLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading channel details…
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Channel Name</Label>
                <Input value={editForm.channel_name} onChange={(e) => setEditForm({ ...editForm, channel_name: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">Topic</Label>
                <Input value={editForm.channel_topic} onChange={(e) => setEditForm({ ...editForm, channel_topic: e.target.value })} placeholder="Optional" />
              </div>
              <div>
                <Label className="text-xs">Description</Label>
                <Textarea
                  value={editForm.channel_description}
                  onChange={(e) => setEditForm({ ...editForm, channel_description: e.target.value })}
                  placeholder="Optional channel description (supports BBCode)"
                  rows={4}
                />
              </div>
              <div>
                <Label className="text-xs">Icon ID</Label>
                <Input
                  className="font-mono-data"
                  value={editForm.channel_icon_id}
                  onChange={(e) => setEditForm({ ...editForm, channel_icon_id: e.target.value })}
                  placeholder="0 = no icon"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Numeric icon ID already uploaded on the server. Use <span className="font-mono">0</span> to clear.
                </p>
              </div>
              <div>
                <Label className="text-xs">Banner image URL</Label>
                <Input
                  value={editForm.channel_banner_gfx_url}
                  onChange={(e) => setEditForm({ ...editForm, channel_banner_gfx_url: e.target.value })}
                  placeholder="https://… or ts3image://…"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  TS6 channel banner. External HTTPS URL or a <span className="font-mono">ts3image://</span> link to a file on this server.
                </p>
              </div>
              <div>
                <Label className="text-xs">Banner mode</Label>
                <Select
                  value={editForm.channel_banner_mode}
                  onValueChange={(v) => setEditForm({ ...editForm, channel_banner_mode: v })}
                >
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0 — Stretch</SelectItem>
                    <SelectItem value="1">1 — Keep aspect ratio</SelectItem>
                    <SelectItem value="2">2 — Ignore aspect / fill</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Password</Label>
                <Input type="password" value={editForm.channel_password} onChange={(e) => setEditForm({ ...editForm, channel_password: e.target.value })} placeholder="Leave empty to keep current" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleEditSave} disabled={editLoading || !editForm.channel_name.trim() || editChannel.isPending}>
              {editChannel.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title="Delete Channel"
        description={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        loading={deleteChannel.isPending}
      />
    </div>
  );
}
