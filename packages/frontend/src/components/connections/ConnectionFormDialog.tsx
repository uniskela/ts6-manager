import { useRef } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FIELD_HELP, type ConnectionFormState } from '@/content/connection-setup';

interface ConnectionFormDialogProps {
  open: boolean;
  editId: number | null;
  form: ConnectionFormState;
  saving?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (form: ConnectionFormState) => void;
  onSave: () => void;
}

function FieldLabel({
  label,
  help,
  htmlFor,
  tooltipAlign = 'center',
}: {
  label: string;
  help: string;
  htmlFor: string;
  tooltipAlign?: 'start' | 'center' | 'end';
}) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <Label htmlFor={htmlFor} className="text-xs truncate">{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`About ${label}`} className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <HelpCircle className="h-3 w-3" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align={tooltipAlign}>
          {help}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ConnectionFormDialog({
  open,
  editId,
  form,
  saving,
  onOpenChange,
  onChange,
  onSave,
}: ConnectionFormDialogProps) {
  const canSave = !!form.name && !!form.host && (!!form.apiKey || !!editId);
  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md [--dialog-max-height:90vh] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          // The first focusable node is a help icon; opening its tooltip would cover the section copy.
          event.preventDefault();
          nameInputRef.current?.focus();
        }}
      >
        <TooltipProvider delayDuration={200}>
          <DialogHeader>
            <DialogTitle>{editId ? 'Edit Connection' : 'Add Connection'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-3">
              <p className="text-xs font-medium text-foreground">WebQuery (required)</p>
              <p className="text-[11px] text-muted-foreground -mt-2">
                Primary API for dashboard, channels, clients, permissions, and most bot actions.
              </p>

              <div>
                <FieldLabel label="Name" htmlFor="connection-name" help={FIELD_HELP.name} />
                <Input
                  id="connection-name"
                  ref={nameInputRef}
                  value={form.name}
                  onChange={(e) => onChange({ ...form, name: e.target.value })}
                  placeholder="My TS Server"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel label="Host" htmlFor="connection-host" help={FIELD_HELP.host} />
                  <Input
                    id="connection-host"
                    value={form.host}
                    onChange={(e) => onChange({ ...form, host: e.target.value })}
                    placeholder="127.0.0.1"
                  />
                </div>
                <div>
                  <FieldLabel label="WebQuery Port" htmlFor="connection-webquery-port" help={FIELD_HELP.webqueryPort} tooltipAlign="end" />
                  <Input
                    type="number"
                    id="connection-webquery-port"
                    value={form.webqueryPort}
                    onChange={(e) => onChange({ ...form, webqueryPort: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <FieldLabel label="API Key" htmlFor="connection-api-key" help={FIELD_HELP.apiKey} />
                <Input
                  id="connection-api-key"
                  value={form.apiKey}
                  onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
                  placeholder={editId ? '(unchanged — enter new key to update)' : 'WebQuery API Key'}
                  type="password"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="connection-use-https"
                  checked={form.useHttps}
                  onCheckedChange={(v) => onChange({ ...form, useHttps: v })}
                />
                <FieldLabel label="Use HTTPS" htmlFor="connection-use-https" help={FIELD_HELP.useHttps} />
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs font-medium text-foreground">SSH (optional)</p>
              <p className="text-[11px] text-muted-foreground -mt-2">
                Required for file browser, bot event triggers, and music bot chat commands.
              </p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <FieldLabel label="SSH Port" htmlFor="connection-ssh-port" help={FIELD_HELP.sshPort} />
                  <Input
                    type="number"
                    id="connection-ssh-port"
                    value={form.sshPort}
                    onChange={(e) => onChange({ ...form, sshPort: e.target.value })}
                  />
                </div>
                <div>
                  <FieldLabel label="SSH User" htmlFor="connection-ssh-user" help={FIELD_HELP.sshUsername} tooltipAlign="center" />
                  <Input
                    id="connection-ssh-user"
                    value={form.sshUsername}
                    onChange={(e) => onChange({ ...form, sshUsername: e.target.value })}
                    placeholder="serveradmin"
                  />
                </div>
                <div>
                  <FieldLabel label="SSH Password" htmlFor="connection-ssh-password" help={FIELD_HELP.sshPassword} tooltipAlign="end" />
                  <Input
                    type="password"
                    id="connection-ssh-password"
                    value={form.sshPassword}
                    onChange={(e) => onChange({ ...form, sshPassword: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs font-medium text-foreground">Native metrics (optional)</p>
              <p className="text-[11px] text-muted-foreground -mt-2">
                Scrapes TeamSpeak’s unauthenticated Prometheus metrics listener server-side.
                Keep port 9187 private — do not expose it to the internet.
              </p>

              <div className="flex items-center gap-2">
                <Switch
                  id="connection-metrics-enabled"
                  checked={form.metricsEnabled}
                  onCheckedChange={(v) => onChange({ ...form, metricsEnabled: v })}
                />
                <FieldLabel label="Enable metrics scrape" htmlFor="connection-metrics-enabled" help={FIELD_HELP.metricsEnabled} />
              </div>

              {form.metricsEnabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel label="Metrics port" htmlFor="connection-metrics-port" help={FIELD_HELP.metricsPort} />
                    <Input
                      type="number"
                      id="connection-metrics-port"
                      value={form.metricsPort}
                      onChange={(e) => onChange({ ...form, metricsPort: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel label="Metrics host (optional)" htmlFor="connection-metrics-host" help={FIELD_HELP.metricsHost} tooltipAlign="end" />
                    <Input
                      id="connection-metrics-host"
                      value={form.metricsHost}
                      onChange={(e) => onChange({ ...form, metricsHost: e.target.value })}
                      placeholder="Same as WebQuery host"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={onSave} disabled={!canSave || saving}>
              {saving ? 'Saving...' : editId ? 'Update' : 'Add'}
            </Button>
          </DialogFooter>
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
}
