/**
 * Per-bot settings menu (Bot Hub cards and the console header): edit,
 * start or stop the bot, widget link, delete.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link2, MoreHorizontal, Pencil, Power, PowerOff, Trash2 } from 'lucide-react';
import type { MusicBotSummary } from '@ts6/common';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useQuery } from '@tanstack/react-query';
import { musicBotsApi } from '@/api/music.api';
import { useDeleteMusicBot, useStartMusicBot, useStopMusicBot } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import { BotFormDialog } from './BotFormDialog';
import { WidgetLinkDialog } from './WidgetLinkDialog';

/** A bot counts as running unless it is stopped or failed. */
export function isBotRunning(status: string): boolean {
  return status !== 'stopped' && status !== 'error';
}

export function BotSettingsMenu({ botId, botName, status, onDeleted, size = 'sm' }: {
  botId: number;
  botName: string;
  status: string;
  onDeleted?: () => void;
  size?: 'sm' | 'default';
}) {
  const [editOpen, setEditOpen] = useState(false);
  // Full settings are only needed for Edit; no extra polling on the hub.
  const bots = useQuery({ queryKey: ['music-bots'], queryFn: musicBotsApi.list, enabled: editOpen });
  const summary = (Array.isArray(bots.data) ? bots.data as MusicBotSummary[] : []).find((b) => b.id === botId) ?? null;
  const startBot = useStartMusicBot();
  const stopBot = useStopMusicBot();
  const deleteBot = useDeleteMusicBot();
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const running = isBotRunning(status);

  useEffect(() => {
    if (!editOpen || !bots.isError || bots.isFetching) return;
    toast.error(apiErrorMessage(bots.error, 'Could not load the bot settings'));
    setEditOpen(false);
  }, [editOpen, bots.isError, bots.isFetching, bots.error]);

  return (
    <>
      {/* Non-modal so the dialogs it opens keep pointer events. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size={size === 'sm' ? 'icon' : 'default'} className={size === 'sm' ? 'h-9 w-9' : 'h-10'}
            aria-label={`Settings for ${botName}`}>
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            {size !== 'sm' && <span className="ml-1.5">Bot settings</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" aria-hidden="true" /> Edit bot
          </DropdownMenuItem>
          {running ? (
            <DropdownMenuItem disabled={stopBot.isPending} onSelect={() => stopBot.mutate(botId, {
              onSuccess: () => toast.success('Bot stopped'),
              onError: (err) => toast.error(apiErrorMessage(err, 'Failed to stop bot')),
            })}>
              <PowerOff className="mr-2 h-4 w-4" aria-hidden="true" /> Stop bot
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={startBot.isPending} onSelect={() => startBot.mutate(botId, {
              onSuccess: () => toast.success('Bot started'),
              onError: (err) => toast.error(apiErrorMessage(err, 'Failed to start bot')),
            })}>
              <Power className="mr-2 h-4 w-4" aria-hidden="true" /> Start bot
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setWidgetOpen(true)}>
            <Link2 className="mr-2 h-4 w-4" aria-hidden="true" /> Widget link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" /> Delete bot
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BotFormDialog open={editOpen && !!summary} bot={summary} onClose={() => setEditOpen(false)} />
      <WidgetLinkDialog botId={botId} botName={botName} open={widgetOpen} onOpenChange={setWidgetOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${botName}?`}
        description="This will permanently delete this media bot and disconnect it from the server."
        confirmLabel="Delete"
        loading={deleteBot.isPending}
        onConfirm={() => {
          deleteBot.mutate(botId, {
            onSuccess: () => {
              toast.success('Bot deleted');
              setDeleteOpen(false);
              onDeleted?.();
            },
            onError: (err) => toast.error(apiErrorMessage(err, 'Failed to delete bot')),
          });
        }}
        destructive
      />
    </>
  );
}
