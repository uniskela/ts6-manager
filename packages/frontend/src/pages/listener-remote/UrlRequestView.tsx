import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  enqueueRemoteMutation,
  remoteErrorMessage,
  remoteMediaUrlError,
  remoteSession,
  requestRemoteUrl,
} from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function UrlRequestView({ expire, refresh }: {
  readonly expire: (error: unknown) => boolean;
  readonly refresh: () => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const submit = () => {
    const problem = remoteMediaUrlError(url);
    if (problem) { setError(problem); setNotice(null); return; }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void enqueueRemoteMutation(() => requestRemoteUrl(url)).then(
      async () => {
        if (!remoteSession()) return;
        setUrl('');
        setNotice('Added the link to the queue.');
        await refresh();
      },
      (err: unknown) => { if (!expire(err)) setError(remoteErrorMessage(err)); },
    ).finally(() => { lock.current = false; setBusy(false); });
  };

  return (
    <Card>
      <CardContent className="p-4">
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <Label htmlFor="remote-url" className="text-base font-semibold">Media URL</Label>
          <p className="text-sm text-muted-foreground">Paste a link to add a song that is not in the library.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="remote-url"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="done"
              maxLength={2048}
              placeholder="https://"
              value={url}
              className="h-11 sm:flex-1"
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button type="submit" className="h-11 w-full sm:w-auto" disabled={busy || url.trim().length === 0}>
              {busy ? 'Adding…' : 'Request URL'}
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {notice && <StatusNote>{notice}</StatusNote>}
        </form>
      </CardContent>
    </Card>
  );
}
