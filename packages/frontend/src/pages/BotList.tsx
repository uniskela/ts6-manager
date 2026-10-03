import { useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useBots, useCreateBot, useToggleBot } from '@/hooks/use-bots';
import { useServerStore } from '@/stores/server.store';
import { botsApi } from '@/api/bots.api';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { CONNECTION_SETUP_PATH, ConnectionRequiredNotice, useConnectionAvailability } from '@/components/shared/NoServerSelectedState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Bot, Plus, Pencil, Trash2, Play, Clock, AlertTriangle, LayoutTemplate } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { TemplateGallery } from '@/components/bots/TemplateGallery';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { timeAgo } from '@/lib/utils';
import { CommandsTab } from '@/pages/media-bots/CommandsTab';

/** Render Bot Flows and its server-scoped Chat commands tab. */
export default function BotList() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { selectedConfigId, selectedSid } = useServerStore();
  const { data, isLoading } = useBots();
  const createBot = useCreateBot();
  const toggleBot = useToggleBot();
  const deleteBot = useMutation({ mutationFn: (id: number) => botsApi.delete(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }) });

  const [showCreate, setShowCreate] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const bots = Array.isArray(data) ? data : [];
  const { isPending: connectionsPending, hasNoConnections } = useConnectionAvailability();
  const createBlocked = connectionsPending || hasNoConnections;

  if (isLoading) return <PageLoader />;

  const handleCreate = () => {
    if (!selectedConfigId) {
      toast.error('Please select a server first');
      return;
    }
    createBot.mutate({ name: newName, description: newDesc, serverConfigId: selectedConfigId, virtualServerId: selectedSid || 1, flowData: { nodes: [], edges: [] } }, {
      onSuccess: (bot: any) => { toast.success('Bot created'); setShowCreate(false); setNewName(''); setNewDesc(''); navigate(`/bots/${bot.id}`); },
      onError: () => toast.error('Failed to create bot'),
    });
  };

  const commandsTab = searchParams.get('tab') === 'commands';
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextCommands = event.key === 'ArrowRight' ? !commandsTab : commandsTab;
    setSearchParams(nextCommands ? { tab: 'commands' } : {});
  };
  const tabLinks = (
    <div className="flex gap-1 border-b" role="tablist" aria-label="Bot Flows sections">
      <button
        type="button"
        role="tab"
        id="bot-flows-tab"
        aria-controls="bot-flows-panel"
        aria-selected={!commandsTab}
        tabIndex={commandsTab ? -1 : 0}
        onKeyDown={handleTabKeyDown}
        className={`border-b-2 px-3 py-2 text-sm ${!commandsTab ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
        onClick={() => setSearchParams({})}
      >Flows</button>
      <button
        type="button"
        role="tab"
        id="bot-chat-commands-tab"
        aria-controls="bot-chat-commands-panel"
        aria-selected={commandsTab}
        tabIndex={commandsTab ? 0 : -1}
        onKeyDown={handleTabKeyDown}
        className={`border-b-2 px-3 py-2 text-sm ${commandsTab ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
        onClick={() => setSearchParams({ tab: 'commands' })}
      >Chat commands</button>
    </div>
  );

  if (commandsTab) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Bot Flows</h1>
          <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>Back to flows</Button>
        </div>
        {tabLinks}
        <div role="tabpanel" id="bot-chat-commands-panel" aria-labelledby="bot-chat-commands-tab" tabIndex={0}>
          <CommandsTab showClashWarnings />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Bot Flows</h1>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="outline" size="sm" disabled={createBlocked} onClick={() => setShowTemplates(true)}><LayoutTemplate className="h-4 w-4 mr-1" /> From Template</Button>
          <Button size="sm" disabled={createBlocked} onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-1" /> New Bot</Button>
        </div>
      </div>
      {tabLinks}
      <div role="tabpanel" id="bot-flows-panel" aria-labelledby="bot-flows-tab" tabIndex={0}>
      {bots.length > 0 && hasNoConnections && (
        <ConnectionRequiredNotice>New bot flows need a TeamSpeak server connection.</ConnectionRequiredNotice>
      )}

      {bots.length === 0 && hasNoConnections ? (
        <EmptyState icon={Bot} title="Connect a TeamSpeak server first" description="Bot flows run against a server connection. Add one in Settings → Connections, then create your first flow.">
          <Button size="sm" asChild>
            <Link to={CONNECTION_SETUP_PATH}>Open connection setup</Link>
          </Button>
        </EmptyState>
      ) : bots.length === 0 ? (
        <EmptyState icon={Bot} title="No bot flows yet" description="Create your first automation flow to get started." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bots.map((bot: any) => (
            <Card key={bot.id} className="group hover:border-primary/30 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium truncate">{bot.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={bot.enabled}
                      onCheckedChange={(enabled) => toggleBot.mutate({ id: bot.id, enabled }, {
                        onSuccess: () => toast.success(enabled ? 'Bot enabled' : 'Bot disabled'),
                      })}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground line-clamp-2">{bot.description || 'No description'}</p>

                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={bot.enabled ? 'default' : 'secondary'} className="text-[10px]">
                    {bot.enabled ? 'Active' : 'Inactive'}
                  </Badge>
                  {bot.serverConfigId && (
                    <Badge variant="outline" className="text-[10px]">Server #{bot.serverConfigId}</Badge>
                  )}
                </div>

                {bot.updatedAt && (
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" /> Updated {timeAgo(new Date(bot.updatedAt).getTime() / 1000)}
                  </p>
                )}

                <div className="touch-action-reveal flex items-center gap-1 pt-1 transition-opacity">
                  <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => navigate(`/bots/${bot.id}`)}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit Flow
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(bot.id)} aria-label={`Delete ${bot.name}`} title={`Delete ${bot.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Bot Flow</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My Automation" /></div>
            <div><Label className="text-xs">Description</Label><Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What does this bot do?" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName || !selectedConfigId || createBot.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Template Gallery */}
      <TemplateGallery
        open={showTemplates}
        onOpenChange={setShowTemplates}
        onSelect={(name, description, flowData) => {
          if (!selectedConfigId) {
            toast.error('Please select a server first');
            return;
          }
          createBot.mutate({ name, description, serverConfigId: selectedConfigId, virtualServerId: selectedSid || 1, flowData }, {
            onSuccess: (bot: any) => { toast.success(`Bot '${name}' created from template`); navigate(`/bots/${bot.id}`); },
            onError: () => toast.error('Failed to create bot from template'),
          });
        }}
      />

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Bot?"
        description="This will permanently delete this bot flow and all its execution history."
        onConfirm={() => {
          if (deleteId) deleteBot.mutate(deleteId, { onSuccess: () => { toast.success('Bot deleted'); setDeleteId(null); } });
        }}
        destructive
      />
      </div>
    </div>
  );
}
