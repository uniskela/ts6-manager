import type { BotMediaOverview } from '@ts6/common';
import { Badge } from '@/components/ui/badge';
import { automationBadges } from '@/lib/bot-hub';

/** Auto-DJ and 24/7 badges for a bot; renders nothing when both are off. */
export function AutomationBadges({ bot }: { bot: BotMediaOverview }) {
  return (
    <>
      {automationBadges(bot).map((badge) => (
        <Badge key={badge.label} variant="outline" className="shrink-0" title={badge.title} aria-label={badge.title}>
          {badge.label}
        </Badge>
      ))}
    </>
  );
}
