import type { RemotePhase } from '@/lib/listener-remote';
import { StatusNote } from './StatusNote';

export function GateView({
  phase,
  remember,
  onRememberChange,
}: {
  readonly phase: Exclude<RemotePhase, { kind: 'ready' }>;
  readonly remember: boolean;
  readonly onRememberChange: (value: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Listener remote</h1>
      {phase.kind === 'opening' && <StatusNote>Opening your remote…</StatusNote>}
      {phase.kind === 'need-link' && (
        <p className="text-sm text-muted-foreground">
          Type !remote in the bot&apos;s channel. The bot sends a private link to this page.
        </p>
      )}
      {phase.kind === 'ended' && (
        <>
          <p role="alert" className="text-sm text-destructive">{phase.message}</p>
          <p className="text-sm text-muted-foreground">
            Type !remote in the bot&apos;s channel. The bot sends a private link to this page.
          </p>
        </>
      )}
      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="mt-1"
          checked={remember}
          onChange={(event) => onRememberChange(event.target.checked)}
        />
        <span>Remember this browser for 24 hours (still requires you stay in the bot channel).</span>
      </label>
    </div>
  );
}
