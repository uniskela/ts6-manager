/** Player widget URLs for one bot (channel description BBCode and JSON). */

import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { musicBotsApi } from '@/api/music.api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiErrorMessage } from '@/lib/api-error';

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <div className="flex gap-1.5 mt-1">
        <Input readOnly aria-label={label} className="h-9 text-[11px] font-mono-data" value={value} />
        <Button variant="outline" size="sm" className="h-9 text-xs shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => toast.success('Copied!'),
              () => toast.error('Could not copy. Select the text and copy it by hand.'),
            );
          }}
        >Copy</Button>
      </div>
    </div>
  );
}

export function WidgetLinkDialog({ botId, botName, open, onOpenChange }: {
  botId: number;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const token = useQuery({
    queryKey: ['music-bot-widget-token', botId],
    queryFn: () => musicBotsApi.playerWidgetToken(botId) as Promise<{ token: string; jsonUrl: string; bbcodeUrl: string }>,
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Player widget: {botName}</DialogTitle>
          <DialogDescription className="text-xs">
            Embed these URLs in your TeamSpeak channel description or website.
          </DialogDescription>
        </DialogHeader>
        {token.isLoading && <p className="text-xs text-muted-foreground">Loading widget link…</p>}
        {token.isError && (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">{apiErrorMessage(token.error, 'Could not load the widget link.')}</p>
            <Button size="sm" variant="outline" onClick={() => { void token.refetch(); }} disabled={token.isFetching}>Try again</Button>
          </div>
        )}
        {token.data && (
          <div className="space-y-3">
            <CopyRow label="BBCode URL (for channel description)" value={token.data.bbcodeUrl} />
            <CopyRow label="JSON URL (for websites/integrations)" value={token.data.jsonUrl} />
            <div>
              <Label className="text-[10px] text-muted-foreground">Token</Label>
              <Input readOnly aria-label="Widget token" className="h-9 text-[11px] font-mono-data mt-1" value={token.data.token} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
