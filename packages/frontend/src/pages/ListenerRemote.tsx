import { useEffect, useState } from 'react';
import { remoteLaunchToken } from '@/lib/listener-remote-launch';
import {
  exchangeRemoteToken,
  probeRemoteSession,
  remoteErrorMessage,
  remoteRememberPreference,
  remoteSession,
  remoteSessionKey,
  setRemoteRememberPreference,
  settleRemoteExchange,
  type RemotePhase,
} from '@/lib/listener-remote';
import { GateView } from './listener-remote/GateView';
import { ReadyView } from './listener-remote/ReadyView';

type Phase = RemotePhase;

function initialPhase(): Phase {
  if (remoteSession()) return { kind: 'ready', nonce: 0 };
  if (remoteLaunchToken()) return { kind: 'opening' };
  return { kind: 'opening' }; // probe cookie before need-link
}

function phaseWithoutToken(current: Phase): Phase {
  if (!remoteSession()) return { kind: 'need-link' };
  if (current.kind === 'ready') return current;
  return { kind: 'ready', nonce: 0 };
}

export default function ListenerRemote() {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [generation, setGeneration] = useState(0);
  const [remember, setRemember] = useState(remoteRememberPreference);

  useEffect(() => {
    const onToken = () => setGeneration((n) => n + 1);
    window.addEventListener('ts6-remote-token', onToken);
    return () => window.removeEventListener('ts6-remote-token', onToken);
  }, []);

  useEffect(() => {
    setRemoteRememberPreference(remember);
  }, [remember]);

  useEffect(() => {
    const token = remoteLaunchToken();
    if (token) {
      let alive = true;
      const before = remoteSessionKey(remoteSession());
      if (!before) setPhase({ kind: 'opening' });
      const settle = (error: string | null) => {
        if (!alive) return;
        const after = remoteSessionKey(remoteSession());
        setPhase((current) => settleRemoteExchange(current, before, after, error));
      };
      void exchangeRemoteToken(token, remoteRememberPreference()).then(
        () => settle(null),
        (error: unknown) => settle(remoteErrorMessage(error)),
      );
      return () => { alive = false; };
    }

    let alive = true;
    if (!remoteSession()) setPhase({ kind: 'opening' });
    void probeRemoteSession().then(
      (session) => {
        if (!alive) return;
        setPhase(session ? { kind: 'ready', nonce: 0 } : phaseWithoutToken({ kind: 'need-link' }));
      },
      (error: unknown) => {
        if (!alive) return;
        setPhase({ kind: 'ended', message: remoteErrorMessage(error) });
      },
    );
    return () => { alive = false; };
  }, [generation]);

  return (
    <main className="remote-shell mx-auto flex min-h-dvh w-full max-w-lg flex-col px-3 py-4 lg:max-w-6xl lg:px-6 lg:py-8">
      {phase.kind === 'ready'
        ? (
          <ReadyView
            key={phase.nonce}
            onEnded={(message) => setPhase({ kind: 'ended', message })}
          />
        )
        : (
          <GateView
            phase={phase}
            remember={remember}
            onRememberChange={setRemember}
          />
        )}
    </main>
  );
}
