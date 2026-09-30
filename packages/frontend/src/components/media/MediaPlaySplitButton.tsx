import { ChevronDown, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MEDIA_PLAY_ACTIONS,
  MEDIA_PLAY_LABELS,
  getLastPlayAction,
  setLastPlayAction,
  type MediaPlayAction,
} from '@/lib/media-bot-play';

interface MediaPlaySplitButtonProps {
  botId: number;
  botName: string;
  disabled?: boolean;
  className?: string;
  onAction: (action: MediaPlayAction) => void;
}

export function MediaPlaySplitButton({
  botId,
  botName,
  disabled,
  className,
  onAction,
}: MediaPlaySplitButtonProps) {
  const last = getLastPlayAction(botId);

  const run = (action: MediaPlayAction) => {
    setLastPlayAction(botId, action);
    onAction(action);
  };

  return (
    <div className={`flex items-center ${className ?? ''}`}>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs rounded-r-none border-r-0 flex-1"
        disabled={disabled}
        aria-label={`Play ${MEDIA_PLAY_LABELS[last].toLowerCase()} on ${botName}`}
        onClick={() => run(last)}
      >
        <Play className="h-3 w-3 mr-1" /> Play {MEDIA_PLAY_LABELS[last]}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-1.5 rounded-l-none"
            disabled={disabled}
            aria-label={`Choose what to play on ${botName}`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {MEDIA_PLAY_ACTIONS.map((action) => (
            <DropdownMenuItem key={action} onClick={() => run(action)}>
              {MEDIA_PLAY_LABELS[action]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
