import type { RemotePhase } from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function GateView({ phase }: { readonly phase: Exclude<RemotePhase, { kind: 'ready' }> }) {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Listener remote</h1>
      {phase.kind === 'opening' && <StatusNote>Opening your remote…</StatusNote>}
      {phase.kind === 'need-link' && (
        <p className="text-sm text-muted-foreground">Type !remote in the bot's channel. The bot sends a private link to this page.</p>
      )}
      {phase.kind === 'ended' && (
        <>
          <p role="alert" className="text-sm text-destructive">{phase.message}</p>
          <p className="text-sm text-muted-foreground">Type !remote in the bot's channel. The bot sends a private link to this page.</p>
        </>
      )}
    </div>
  );
}
