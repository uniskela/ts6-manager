import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMediaSwitchStore } from '@/stores/media-switch.store';
import { conflictIsReplaceable, describeMediaSession } from '@/lib/media-switch';

/** Global confirmation for replacing an active media session (music ↔ video). */
export function MediaSwitchDialog() {
  const pending = useMediaSwitchStore((s) => s.pending);
  const answer = useMediaSwitchStore((s) => s.answer);
  if (!pending) return null;

  const { conflict } = pending;
  const replaceable = conflictIsReplaceable(conflict);
  const starting = conflict.requested === 'video' ? 'this video stream' : 'this music';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) answer(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
            {replaceable ? 'Replace what is playing?' : 'Media is still starting'}
          </DialogTitle>
          <DialogDescription>
            {replaceable
              ? `Music and video never play at the same time, and only one video stream runs at once. Starting ${starting} will stop:`
              : 'Wait for this to finish starting, then try again:'}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-sm">
          {conflict.conflicts.map((c) => (
            <li key={c.id} className="rounded bg-muted/50 px-3 py-2">{describeMediaSession(c)}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>
            {replaceable ? 'Keep playing' : 'OK'}
          </Button>
          {replaceable && (
            <Button variant="destructive" onClick={() => answer(true)}>
              Stop and switch
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
