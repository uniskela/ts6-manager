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

function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <div className="flex items-center gap-1">
      <Label className="text-xs">{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground hover:text-foreground">
            <HelpCircle className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
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
                <FieldLabel label="Name" help={FIELD_HELP.name} />
                <Input
                  value={form.name}
                  onChange={(e) => onChange({ ...form, name: e.target.value })}
                  placeholder="My TS Server"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel label="Host" help={FIELD_HELP.host} />
                  <Input
                    value={form.host}
                    onChange={(e) => onChange({ ...form, host: e.target.value })}
                    placeholder="127.0.0.1"
                  />
                </div>
                <div>
                  <FieldLabel label="WebQuery Port" help={FIELD_HELP.webqueryPort} />
                  <Input
                    type="number"
                    value={form.webqueryPort}
                    onChange={(e) => onChange({ ...form, webqueryPort: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <FieldLabel label="API Key" help={FIELD_HELP.apiKey} />
                <Input
                  value={form.apiKey}
                  onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
                  placeholder={editId ? '(unchanged — enter new key to update)' : 'WebQuery API Key'}
                  type="password"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={form.useHttps}
                  onCheckedChange={(v) => onChange({ ...form, useHttps: v })}
                />
                <FieldLabel label="Use HTTPS" help={FIELD_HELP.useHttps} />
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs font-medium text-foreground">SSH (optional)</p>
              <p className="text-[11px] text-muted-foreground -mt-2">
                Required for file browser, bot event triggers, and music bot chat commands.
              </p>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <FieldLabel label="SSH Port" help={FIELD_HELP.sshPort} />
                  <Input
                    type="number"
                    value={form.sshPort}
                    onChange={(e) => onChange({ ...form, sshPort: e.target.value })}
                  />
                </div>
                <div>
                  <FieldLabel label="SSH User" help={FIELD_HELP.sshUsername} />
                  <Input
                    value={form.sshUsername}
                    onChange={(e) => onChange({ ...form, sshUsername: e.target.value })}
                    placeholder="serveradmin"
                  />
                </div>
                <div>
                  <FieldLabel label="SSH Password" help={FIELD_HELP.sshPassword} />
                  <Input
                    type="password"
                    value={form.sshPassword}
                    onChange={(e) => onChange({ ...form, sshPassword: e.target.value })}
                  />
                </div>
              </div>
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
