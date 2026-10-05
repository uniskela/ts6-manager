/**
 * Header pill for the Media Library: what bots are playing right now, with a
 * menu to pause/resume music or jump to a bot's console in the Bot Hub.
 */

import { Link } from 'react-router-dom';
import { ChevronDown, LayoutGrid, Pause, Play, Radio, Tv } from 'lucide-react';
import { toast } from 'sonner';
import type { BotMediaOverview } from '@ts6/common';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BotAvatar } from '@/components/shared/BotAvatar';
import { useBotMedia, usePausePlayback, useResumePlayback } from '@/hooks/use-music-bots';
import { activeBots, activeBotsLabel, hubHeadline, hubTone } from '@/lib/bot-hub';
import { apiErrorMessage } from '@/lib/api-error';

function PlayPauseItem({ bot }: { bot: BotMediaOverview }) {
  const pause = usePausePlayback();
  const resume = useResumePlayback();
  const paused = bot.status === 'paused';
  const pending = pause.isPending || resume.isPending;
  return (
    <DropdownMenuItem
      className="shrink-0 justify-center px-2"
      disabled={pending}
      aria-label={`${paused ? 'Resume' : 'Pause'} ${bot.botName}`}
      onSelect={(e) => {
        // Keep the menu open so the new state shows on the next poll.
        e.preventDefault();
        const action = paused ? resume : pause;
        action.mutate(bot.botId, {
          onError: (err) => toast.error(apiErrorMessage(err, paused ? 'Could not resume' : 'Could not pause')),
        });
      }}
    >
      {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
    </DropdownMenuItem>
  );
}

function ActiveBotRow({ bot }: { bot: BotMediaOverview }) {
  const tone = hubTone(bot);
  const KindIcon = tone === 'live' ? Tv : Radio;
  return (
    <div className="flex items-center gap-1">
      <DropdownMenuItem asChild className="min-w-0 flex-1">
        <Link to={`/bot-hub/${bot.botId}`} aria-label={`Open console for ${bot.botName}`}>
          <BotAvatar
            botId={bot.botId}
            name={bot.botName}
            mode={bot.avatarMode}
            md5={bot.avatarMd5}
            className="h-8 w-8 shrink-0"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{bot.botName}</span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <KindIcon className="!size-3" aria-hidden="true" />
              <span className="truncate">
                {bot.status === 'paused' ? 'Paused · ' : ''}
                {hubHeadline(bot)}
              </span>
            </span>
          </span>
        </Link>
      </DropdownMenuItem>
      {tone === 'music' && !bot.music?.live && <PlayPauseItem bot={bot} />}
    </div>
  );
}

/** "Now playing" pill: hidden text on phones, a quiet Bot Hub link when nothing is on. */
export function ActiveBotsMenu() {
  const { data } = useBotMedia();
  const active = activeBots(data ?? []);
  const label = activeBotsLabel(active);

  if (!label) {
    return (
      <Button asChild variant="outline" size="sm" className="h-9 text-muted-foreground">
        <Link to="/bot-hub" aria-label="No bots playing. Open Bot Hub">
          <LayoutGrid className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
          <span className="hidden sm:inline">No bots playing</span>
        </Link>
      </Button>
    );
  }

  const allPaused = active.every((b) => b.status === 'paused');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 max-w-[18rem] gap-2 border-primary/40"
          aria-label={`Now playing: ${label}. Show active bots`}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
            {!allPaused && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:hidden" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${allPaused ? 'bg-amber-400' : 'bg-emerald-500'}`}
            />
          </span>
          <span className="sm:hidden">{active.length}</span>
          <span className="hidden min-w-0 truncate sm:inline">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          Now playing · {active.length} bot{active.length === 1 ? '' : 's'}
        </DropdownMenuLabel>
        {active.map((bot) => (
          <ActiveBotRow key={bot.botId} bot={bot} />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/bot-hub">
            <LayoutGrid aria-hidden="true" /> Open Bot Hub
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
