import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { invalidateAfterPwaRecovery } from '@/lib/demand-driven-query-policy';
import { claimEdgeReauthAttempt, clearEdgeReauthAttempt, reauthenticateAtEdge } from '@/lib/edge-reauth';

/** Available on login/setup as well as protected routes. No persisted live data. */
export function PwaStatus() {
  const queryClient = useQueryClient();
  const [unavailable, setUnavailable] = useState(!navigator.onLine);
  const [signedOut, setSignedOut] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration>();
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const statusRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const status = statusRef.current;
    if (!status) return;
    // Leave room to scroll controls above the notice on short/keyboard views.
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--pwa-status-height', `${status.offsetHeight + 24}px`);
    });
    observer.observe(status);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--pwa-status-height');
    };
  }, [unavailable, signedOut, waiting]);

  useEffect(() => {
    // iOS does not resize layout viewport units when the keyboard opens.
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncViewport = () => {
      document.documentElement.style.setProperty('--visual-height', `${viewport.height}px`);
      document.documentElement.style.setProperty('--visual-top', `${viewport.offsetTop}px`);
    };
    syncViewport();
    viewport.addEventListener('resize', syncViewport);
    viewport.addEventListener('scroll', syncViewport);
    return () => {
      viewport.removeEventListener('resize', syncViewport);
      viewport.removeEventListener('scroll', syncViewport);
      document.documentElement.style.removeProperty('--visual-height');
      document.documentElement.style.removeProperty('--visual-top');
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let lastCheck = 0;
    let wasUnavailable = !navigator.onLine;
    let probing = false;
    let failures = 0;
    let probes = 0;
    let edited = false;
    const markEdited = () => { edited = true; };
    let retry: number | undefined;
    let controller = navigator.serviceWorker?.controller;
    const abort = new AbortController();

    const checkConnection = async () => {
      if (probing || document.visibilityState === 'hidden') return;
      probing = true;
      clearTimeout(retry);
      const probeAbort = new AbortController();
      const timeout = window.setTimeout(() => probeAbort.abort(), 5000);
      const cancel = () => probeAbort.abort();
      abort.signal.addEventListener('abort', cancel, { once: true });
      let available = false;
      // The backend never redirects this path. A redirect is an authenticating
      // proxy asking for a sign-in that only a page navigation can complete.
      let redirected = false;
      try {
        if (navigator.onLine) {
          const response = await fetch('/api/health', { cache: 'no-store', redirect: 'manual', signal: probeAbort.signal });
          redirected = response.type === 'opaqueredirect';
          const body = response.ok ? await response.json() : null;
          available = body?.status === 'ok';
        }
      } catch { /* Network-only health probe: no offline fallback. */ }
      finally {
        clearTimeout(timeout);
        abort.signal.removeEventListener('abort', cancel);
        probing = false;
      }
      if (disposed) return;
      probes += 1;
      if (available) clearEdgeReauthAttempt();
      // A page that has only just opened and is untouched has nothing to lose,
      // so renew at once. Otherwise ask first: a reload discards edits.
      if (redirected && probes === 1 && !edited && claimEdgeReauthAttempt()) { reauthenticateAtEdge(); return; }
      setSignedOut(redirected);
      setUnavailable(!available);
      // Recovery refreshes ordinary live queries but must not start expensive scans.
      if (wasUnavailable && available) void invalidateAfterPwaRecovery(queryClient);
      wasUnavailable = !available;
      // The cached shell opens instantly, often while the backend is still
      // restarting after an update. Keep probing so the notice clears as soon
      // as the server answers instead of on the next minute tick.
      failures = available ? 0 : failures + 1;
      if (!available) retry = window.setTimeout(() => void checkConnection(), Math.min(2000 * 2 ** (failures - 1), 15_000));
    };

    const checkUpdate = () => {
      if (!registration || !navigator.onLine || document.visibilityState === 'hidden') return;
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      void registration.update().catch(() => { /* Retry on the next check/resume. */ });
    };
    const resume = () => { void checkConnection(); checkUpdate(); };
    const offline = () => { wasUnavailable = true; setUnavailable(true); };
    const controllerChanged = () => {
      // First installation claims the page without interrupting it. An update
      // reloads controlled tabs only after an explicit, warned Reload action.
      if (controller) window.location.reload();
      controller = navigator.serviceWorker.controller;
      setWaiting(undefined);
    };
    const detectWaiting = () => {
      if (!disposed && registration?.active && registration.waiting) setWaiting(registration);
    };
    const updateFound = () => {
      const worker = registration?.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') detectWaiting();
      });
    };

    if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .then((value) => {
          if (disposed) return;
          registration = value;
          registration.addEventListener('updatefound', updateFound);
          updateFound();
          detectWaiting();
          checkUpdate();
        }).catch(() => { /* PWA is progressive enhancement; browser use still works. */ });
    }

    document.addEventListener('input', markEdited, { capture: true, once: true });
    void checkConnection();
    const interval = window.setInterval(resume, 60_000);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      abort.abort();
      clearInterval(interval);
      clearTimeout(retry);
      document.removeEventListener('input', markEdited, { capture: true });
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', resume);
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
      registration?.removeEventListener('updatefound', updateFound);
    };
  }, [queryClient]);

  useEffect(() => {
    if (!updating) return;
    const timeout = window.setTimeout(() => { setUpdating(false); setUpdateError(true); }, 15_000);
    return () => clearTimeout(timeout);
  }, [updating]);

  if (!unavailable && !waiting) return null;
  return (
    <aside ref={statusRef} className="pwa-status space-y-2 rounded-lg border border-border bg-popover p-3 text-sm shadow-lg" aria-label="App status">
      {unavailable && !signedOut && <p role="status">Server unavailable. Displayed data may be outdated. Live administration requires a connection; actions are not queued.</p>}
      {signedOut && <div className="space-y-2">
        <p role="status">Your access session has expired. Sign in again to reconnect. Unsaved changes on this page will be lost.</p>
        <Button size="sm" onClick={reauthenticateAtEdge}>Sign in again</Button>
      </div>}
      {waiting && <div className="space-y-2">
        <p role="status">Update available. Save your work in all open TS6 Manager tabs before reloading.</p>
        {updateError && <p role="alert">Update could not finish. Try Reload again when connected.</p>}
        <Button size="sm" disabled={updating || unavailable} onClick={() => {
          setUpdateError(false);
          if (!waiting.waiting) { window.location.reload(); return; }
          setUpdating(true);
          waiting.waiting.postMessage({ type: 'SKIP_WAITING' });
        }}>{updating ? 'Updating…' : 'Reload all tabs'}</Button>
      </div>}
    </aside>
  );
}
