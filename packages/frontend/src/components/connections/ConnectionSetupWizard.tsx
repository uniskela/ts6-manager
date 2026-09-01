import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { serversApi } from '@/api/servers.api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  DEFAULT_CONNECTION_FORM,
  DEPLOYMENT_SCENARIOS,
  TS_PREP_STEPS,
  type ConnectionFormState,
  type DeploymentScenarioId,
} from '@/content/connection-setup';
import { ArrowLeft, ArrowRight, Check, Loader2, TestTube } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const STEPS = [
  'Where is your TeamSpeak server?',
  'Prepare WebQuery on TS',
  'Enter WebQuery details',
  'SSH (optional)',
  'Review & finish',
] as const;

interface ConnectionSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

export function ConnectionSetupWizard({ open, onOpenChange, onComplete }: ConnectionSetupWizardProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [scenarioId, setScenarioId] = useState<DeploymentScenarioId>('same-host');
  const [form, setForm] = useState<ConnectionFormState>(DEFAULT_CONNECTION_FORM);
  const [skipSsh, setSkipSsh] = useState(false);
  const [webqueryTestOk, setWebqueryTestOk] = useState<boolean | null>(null);
  const [sshTestOk, setSshTestOk] = useState<boolean | null>(null);

  const scenario = useMemo(
    () => DEPLOYMENT_SCENARIOS.find((s) => s.id === scenarioId) ?? DEPLOYMENT_SCENARIOS[0],
    [scenarioId],
  );

  const createServer = useMutation({
    mutationFn: (data: Record<string, unknown>) => serversApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  });

  const testWebqueryDraft = useMutation({
    mutationFn: () => serversApi.testWebqueryDraft({
      host: form.host,
      webqueryPort: parseInt(form.webqueryPort, 10),
      apiKey: form.apiKey,
      useHttps: form.useHttps,
    }),
  });

  const testSshDraft = useMutation({
    mutationFn: () => serversApi.testSshDraft({
      host: form.host,
      sshPort: parseInt(form.sshPort, 10),
      sshUsername: form.sshUsername,
      sshPassword: form.sshPassword,
    }),
  });

  const reset = () => {
    setStep(0);
    setScenarioId('same-host');
    setForm(DEFAULT_CONNECTION_FORM);
    setSkipSsh(false);
    setWebqueryTestOk(null);
    setSshTestOk(null);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const applyScenario = (id: DeploymentScenarioId) => {
    setScenarioId(id);
    const next = DEPLOYMENT_SCENARIOS.find((s) => s.id === id);
    if (next) {
      setForm((prev) => ({ ...prev, host: next.hostPlaceholder }));
    }
  };

  const canNext = () => {
    if (step === 2) return !!form.name && !!form.host && !!form.apiKey;
    if (step === 3 && !skipSsh) {
      return !!form.sshUsername && !!form.sshPassword;
    }
    return true;
  };

  const handleTestWebquery = () => {
    testWebqueryDraft.mutate(undefined, {
      onSuccess: (data) => {
        setWebqueryTestOk(!!data?.success);
        toast.success(data?.version ? `WebQuery OK (${data.version})` : 'WebQuery connection successful');
      },
      onError: (err: any) => {
        setWebqueryTestOk(false);
        toast.error(err?.response?.data?.error || 'WebQuery test failed');
      },
    });
  };

  const handleTestSsh = () => {
    testSshDraft.mutate(undefined, {
      onSuccess: (data) => {
        setSshTestOk(!!data?.success);
        toast.success('SSH connection successful');
      },
      onError: (err: any) => {
        setSshTestOk(false);
        toast.error(err?.response?.data?.error || 'SSH test failed');
      },
    });
  };

  const handleFinish = () => {
    const payload: Record<string, unknown> = {
      name: form.name,
      host: form.host,
      webqueryPort: parseInt(form.webqueryPort, 10),
      apiKey: form.apiKey,
      useHttps: form.useHttps,
      sshPort: parseInt(form.sshPort, 10),
    };
    if (!skipSsh && form.sshUsername && form.sshPassword) {
      payload.sshUsername = form.sshUsername;
      payload.sshPassword = form.sshPassword;
    }

    createServer.mutate(payload, {
      onSuccess: async (data) => {
        let webqueryOk = false;
        try {
          if (data?.id) {
            const testResult = await serversApi.test(data.id);
            webqueryOk = !!testResult?.success;
          }
        } catch {
          // Connection was created; test can be retried from the card.
        }
        toast.success('Connection created successfully');
        if (webqueryOk) onComplete?.();
        handleClose(false);
      },
      onError: (err: any) => {
        toast.error(err?.response?.data?.error || 'Failed to create connection');
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connection setup wizard</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>
          <div className="flex gap-1 pt-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={cn('h-1 flex-1 rounded-full', i <= step ? 'bg-primary' : 'bg-muted')}
              />
            ))}
          </div>
        </DialogHeader>

        {step === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Choose how your TeamSpeak server is deployed relative to ts6-manager.</p>
            {DEPLOYMENT_SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => applyScenario(s.id)}
                className={cn(
                  'w-full text-left rounded-md border p-3 transition-colors',
                  scenarioId === s.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30',
                )}
              >
                <p className="text-xs font-medium">{s.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.description}</p>
                <p className="text-[11px] mt-1">
                  Suggested host: <code className="font-mono-data">{s.hostPlaceholder}</code>
                </p>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Complete these steps on your TeamSpeak server before entering credentials in the manager.
            </p>
            <ol className="space-y-3 list-decimal list-inside text-xs text-muted-foreground">
              {TS_PREP_STEPS.map((item) => (
                <li key={item.title} className="space-y-1">
                  <span className="font-medium text-foreground">{item.title}</span>
                  <p>{item.body}</p>
                  {'code' in item && item.code && (
                    <pre className="rounded bg-muted px-2 py-1.5 font-mono text-[11px] overflow-x-auto">{item.code}</pre>
                  )}
                </li>
              ))}
            </ol>
            {scenario.notes && (
              <p className="text-[11px] text-muted-foreground rounded-md border border-border p-2">{scenario.notes}</p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{scenario.hostHint}</p>
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My TS Server" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Host</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={scenario.hostPlaceholder} />
              </div>
              <div>
                <Label className="text-xs">WebQuery Port</Label>
                <Input type="number" value={form.webqueryPort} onChange={(e) => setForm({ ...form, webqueryPort: e.target.value })} />
              </div>
            </div>
            <div>
              <Label className="text-xs">API Key</Label>
              <Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="WebQuery API Key" />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.useHttps} onCheckedChange={(v) => setForm({ ...form, useHttps: v })} />
              <Label className="text-xs">Use HTTPS</Label>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              SSH enables the file browser, bot event triggers, and music bot chat commands. You can skip this and add SSH later in connection settings.
            </p>
            <div className="flex gap-2">
              <Button variant={skipSsh ? 'default' : 'outline'} size="sm" onClick={() => setSkipSsh(true)}>Skip for now</Button>
              <Button variant={!skipSsh ? 'default' : 'outline'} size="sm" onClick={() => setSkipSsh(false)}>Configure SSH</Button>
            </div>
            {!skipSsh && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">SSH Port</Label>
                  <Input type="number" value={form.sshPort} onChange={(e) => setForm({ ...form, sshPort: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">SSH User</Label>
                  <Input value={form.sshUsername} onChange={(e) => setForm({ ...form, sshUsername: e.target.value })} placeholder="serveradmin" />
                </div>
                <div>
                  <Label className="text-xs">SSH Password</Label>
                  <Input type="password" value={form.sshPassword} onChange={(e) => setForm({ ...form, sshPassword: e.target.value })} />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-border p-3 space-y-1">
              <p><span className="text-muted-foreground">Name:</span> {form.name}</p>
              <p><span className="text-muted-foreground">Host:</span> {form.host}:{form.webqueryPort}</p>
              <p><span className="text-muted-foreground">HTTPS:</span> {form.useHttps ? 'Yes' : 'No'}</p>
              <p>
                <span className="text-muted-foreground">SSH:</span>{' '}
                {skipSsh || !form.sshUsername ? 'Not configured' : `${form.sshUsername}@${form.host}:${form.sshPort}`}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleTestWebquery} disabled={testWebqueryDraft.isPending}>
                {testWebqueryDraft.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <TestTube className="h-3 w-3 mr-1" />}
                Test WebQuery
              </Button>
              {!skipSsh && form.sshUsername && form.sshPassword && (
                <Button variant="outline" size="sm" onClick={handleTestSsh} disabled={testSshDraft.isPending}>
                  {testSshDraft.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <TestTube className="h-3 w-3 mr-1" />}
                  Test SSH
                </Button>
              )}
              {webqueryTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">WebQuery OK</Badge>}
              {webqueryTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">WebQuery failed</Badge>}
              {sshTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">SSH OK</Badge>}
              {sshTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">SSH failed</Badge>}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
              <ArrowLeft className="h-3 w-3 mr-1" /> Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>
              Next <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          ) : (
            <Button onClick={handleFinish} disabled={createServer.isPending || !form.name || !form.host || !form.apiKey}>
              {createServer.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Creating...</>
              ) : (
                <><Check className="h-3 w-3 mr-1" /> Create connection</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
