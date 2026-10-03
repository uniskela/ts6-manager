import { useState } from 'react';
import { useServers } from '@/hooks/use-servers';
import { useServerStore } from '@/stores/server.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, Pencil, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatCommandInfo, ChatCommandPreset } from '@ts6/common';
import {
  useChatCommands,
  useChatCommandPresets,
  useSeedChatCommandPresets,
  useCreateChatCommand,
  useUpdateChatCommand,
  useDeleteChatCommand,
} from '@/hooks/use-chat-commands';
import { TS6_CHAT_RESPONSE_EXAMPLE } from '@/lib/ts6-chat-format';
import { Ts6ChatResponseEditor } from '@/components/Ts6ChatResponseEditor';
import { BUILTIN_CHAT_COMMANDS } from '@ts6/common';
import { useFlowCommandTriggers } from '@/hooks/use-flow-command-triggers';
import { describeCommandClash, findCommandClashes } from '@/lib/command-clashes';


// ─── Commands Tab ────────────────────────────────────────────────────────────

/** Render custom chat command CRUD, optionally with Bot Flows clash context. */
export function CommandsTab({ showClashWarnings = false }: { showClashWarnings?: boolean } = {}) {
  const { selectedConfigId } = useServerStore();
  const { data: servers } = useServers();
  const [serverId, setServerId] = useState<number | null>(selectedConfigId);
  const configId = serverId || selectedConfigId;

  const { data: commands, isLoading } = useChatCommands(configId);
  const { data: presets } = useChatCommandPresets(configId);
  const seedPresets = useSeedChatCommandPresets();
  const createCommand = useCreateChatCommand();
  const updateCommand = useUpdateChatCommand();
  const deleteCommand = useDeleteChatCommand();

  const [showAdd, setShowAdd] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [editCmd, setEditCmd] = useState<ChatCommandInfo | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', response: '', description: '', enabled: true });

  const serverList = Array.isArray(servers) ? servers : [];
  const commandList = (Array.isArray(commands) ? commands : []) as ChatCommandInfo[];
  const presetList = (Array.isArray(presets) ? presets : []) as ChatCommandPreset[];
  const existingNames = new Set(commandList.map((c) => c.name));
  const missingPresetCount = presetList.filter((p) => !existingNames.has(p.name)).length;
  const flowCommandNames = useFlowCommandTriggers(showClashWarnings ? configId : null);
  const clashes = showClashWarnings
    ? findCommandClashes({
        custom: commandList.map((command) => command.name),
        flows: flowCommandNames,
        builtins: BUILTIN_CHAT_COMMANDS,
      })
    : [];

  const resetForm = () => setForm({ name: '', response: '', description: '', enabled: true });

  const openEdit = (cmd: ChatCommandInfo) => {
    setEditCmd(cmd);
    setForm({
      name: cmd.name,
      response: cmd.response,
      description: cmd.description || '',
      enabled: cmd.enabled,
    });
  };

  const handleSeedPresets = () => {
    if (!configId) return;
    seedPresets.mutate(configId, {
      onSuccess: (result: { created: number; createdNames: string[] }) => {
        if (result.created === 0) {
          toast.message('All recommended presets are already present');
        } else {
          toast.success(
            `Added ${result.created} preset${result.created === 1 ? '' : 's'} (disabled until you edit & enable)`,
          );
        }
        setShowPresets(false);
      },
      onError: (err: any) =>
        toast.error(err?.response?.data?.error || 'Failed to seed presets'),
    });
  };

  const handleCreateFromPreset = (preset: ChatCommandPreset) => {
    if (!configId) return;
    if (existingNames.has(preset.name)) {
      toast.message(`!${preset.name} already exists`);
      return;
    }
    createCommand.mutate(
      {
        configId,
        data: {
          name: preset.name,
          response: preset.response,
          description: preset.description,
          enabled: false,
        },
      },
      {
        onSuccess: () => toast.success(`Added !${preset.name} (disabled)`),
        onError: (err: any) =>
          toast.error(err?.response?.data?.error || `Failed to add !${preset.name}`),
      },
    );
  };

  const handleCreate = () => {
    if (!configId || !form.name.trim() || !form.response.trim()) {
      toast.error('Name and response are required');
      return;
    }
    createCommand.mutate(
      {
        configId,
        data: {
          name: form.name,
          response: form.response,
          description: form.description || undefined,
          enabled: form.enabled,
        },
      },
      {
        onSuccess: () => {
          toast.success('Command added');
          setShowAdd(false);
          resetForm();
        },
        onError: (err: any) =>
          toast.error(err?.response?.data?.error || 'Failed to add command'),
      },
    );
  };

  const handleUpdate = () => {
    if (!configId || !editCmd) return;
    updateCommand.mutate(
      {
        configId,
        id: editCmd.id,
        data: {
          name: form.name,
          response: form.response,
          description: form.description || null,
          enabled: form.enabled,
        },
      },
      {
        onSuccess: () => {
          toast.success('Command updated');
          setEditCmd(null);
          resetForm();
        },
        onError: (err: any) =>
          toast.error(err?.response?.data?.error || 'Failed to update command'),
      },
    );
  };

  if (!configId) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Select a server"
        description="Choose a server to manage custom chat commands."
      />
    );
  }

  return (
    <div className="space-y-4">
      {showClashWarnings && (
        <>
          <p className="text-sm text-muted-foreground">
            Custom replies are answered by media bots in their command channels; flows run in the flow engine.
          </p>
          {clashes.length > 0 && (
            <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium text-amber-200">Command name clashes</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {clashes.map((clash) => <li key={clash.name}>{describeCommandClash(clash)}</li>)}
              </ul>
            </div>
          )}
          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">Built-in commands</p>
            <p className="mt-1 text-xs text-muted-foreground">These commands are handled by media bots.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BUILTIN_CHAT_COMMANDS.map((name) => <code key={name} className="rounded bg-muted px-1.5 py-0.5 text-xs">!{name}</code>)}
            </div>
          </div>
        </>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(configId)} onValueChange={(v) => setServerId(parseInt(v))}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Server..." />
          </SelectTrigger>
          <SelectContent>
            {serverList.map((s: any) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setShowPresets(true)}>
          <MessageSquare className="h-4 w-4 mr-1" /> Presets
          {missingPresetCount > 0 && (
            <Badge variant="secondary" className="ml-1.5 text-[10px]">
              {missingPresetCount}
            </Badge>
          )}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            resetForm();
            setShowAdd(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> Add command
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Users type <code className="text-[11px]">!help</code> for built-in music commands or{' '}
        <code className="text-[11px]">!commands</code> for enabled custom replies. Seed recommended
        presets (!rules, !links, !discord, !info, !about), edit the text, then enable. Custom
        responses support TS6 Markdown.
      </p>

      {isLoading ? (
        <PageLoader />
      ) : commandList.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No custom commands"
          description="Seed recommended presets or add a command like !rules that replies with fixed text in chat."
        >
          <Button size="sm" variant="outline" onClick={() => setShowPresets(true)}>
            Browse presets
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {commandList.map((cmd) => (
            <div
              key={cmd.id}
              className="flex items-start gap-2 py-2 px-2 hover:bg-muted/30 transition-colors rounded group"
            >
              <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">!{cmd.name}</p>
                  {!cmd.enabled && (
                    <Badge variant="secondary" className="text-[10px]">
                      Disabled
                    </Badge>
                  )}
                </div>
                {cmd.description && (
                  <p className="text-[11px] text-muted-foreground truncate">{cmd.description}</p>
                )}
                <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5">{cmd.response}</p>
              </div>
              <div className="touch-action-reveal flex shrink-0 items-center gap-1 transition-opacity">
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit command ${cmd.name}`} onClick={() => openEdit(cmd)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  aria-label={`Delete command ${cmd.name}`}
                  onClick={() => setDeleteId(cmd.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={showPresets} onOpenChange={setShowPresets}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Recommended command presets</DialogTitle>
            <DialogDescription>
              Seed server-scoped canned replies. New presets are created disabled so you can edit
              placeholder text before enabling. Built-in <code>!commands</code> lists enabled
              customs (no seed needed).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {presetList.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No presets available.</p>
            ) : (
              presetList.map((preset) => {
                const exists = existingNames.has(preset.name);
                return (
                  <div
                    key={preset.name}
                    className="flex items-start gap-2 py-2 px-2 rounded hover:bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">!{preset.name}</p>
                      <p className="text-[11px] text-muted-foreground">{preset.description}</p>
                    </div>
                    {exists ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Added
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 h-7"
                        disabled={createCommand.isPending}
                        onClick={() => handleCreateFromPreset(preset)}
                      >
                        Add
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPresets(false)}>
              Close
            </Button>
            <Button
              onClick={handleSeedPresets}
              disabled={seedPresets.isPending || missingPresetCount === 0}
            >
              {seedPresets.isPending ? 'Seeding…' : `Seed missing (${missingPresetCount})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={showAdd}
        onOpenChange={(open) => {
          if (!open) {
            setShowAdd(false);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add chat command</DialogTitle>
            <DialogDescription>
              When someone types !name in the media bot channel, the bot replies with your response.
              Use the formatting toolbar to match TS6 chat styling.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs" htmlFor="chat-command-name">Command name</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">!</span>
                <Input
                  id="chat-command-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="rules"
                  className="flex-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Help blurb (optional)</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Shown next to the command in !help"
              />
            </div>
            <div>
              <Label className="text-xs">Response</Label>
              <Ts6ChatResponseEditor
                value={form.response}
                onChange={(response) => setForm({ ...form, response })}
                placeholder={TS6_CHAT_RESPONSE_EXAMPLE}
                rows={8}
                className="mt-1"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Preview in TS6 client — web toolbar inserts Markdown / BBCode source text.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
              <Label className="text-xs">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createCommand.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editCmd !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditCmd(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit !{editCmd?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs" htmlFor="chat-command-name">Command name</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">!</span>
                <Input
                  id="chat-command-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="flex-1"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Help blurb (optional)</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs">Response</Label>
              <Ts6ChatResponseEditor
                value={form.response}
                onChange={(response) => setForm({ ...form, response })}
                rows={8}
                className="mt-1"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Preview in TS6 client — web toolbar inserts Markdown / BBCode source text.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
              <Label className="text-xs">Enabled</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditCmd(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={updateCommand.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete command?"
        description="Users will no longer be able to trigger this chat command."
        onConfirm={() => {
          if (!configId || deleteId === null) return;
          deleteCommand.mutate(
            { configId, id: deleteId },
            {
              onSuccess: () => {
                toast.success('Command deleted');
                setDeleteId(null);
              },
              onError: () => toast.error('Failed to delete command'),
            },
          );
        }}
        destructive
      />
    </div>
  );
}
