import { useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
  const errorRef = useRef<HTMLParagraphElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const hintId = useId();

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
    else if (notice) noticeRef.current?.focus({ preventScroll: true });
  }, [error, notice]);

  const submit = () => {
    const problem = remoteMediaUrlError(url);
    if (problem) {
      flushSync(() => {
        setError(problem);
        setNotice(null);
      });
      errorRef.current?.focus({ preventScroll: true });
      return;
    }
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
        <form
          className="space-y-2"
          noValidate
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          <Label htmlFor="remote-url" className="text-base font-semibold">Media URL</Label>
          <p id={hintId} className="text-sm text-foreground/80">Paste a link to add a song that is not in the library.</p>
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
              className="h-11 min-h-11 sm:flex-1"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : hintId}
              onChange={(event) => {
                setUrl(event.target.value);
                if (error) setError(null);
              }}
            />
            <Button type="submit" className="h-11 min-h-11 w-full sm:w-auto" disabled={busy || url.trim().length === 0}>
              {busy ? 'Adding…' : 'Request URL'}
            </Button>
          </div>
          {error && (
            <p
              ref={errorRef}
              id={errorId}
              role="alert"
              tabIndex={-1}
              className="text-sm text-destructive outline-none"
            >
              {error}
            </p>
          )}
          {notice && (
            <p ref={noticeRef} tabIndex={-1} className="outline-none">
              <StatusNote>{notice}</StatusNote>
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
