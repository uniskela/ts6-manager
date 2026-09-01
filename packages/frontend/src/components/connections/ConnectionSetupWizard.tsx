import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { serversApi } from '@/api/servers.api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { SetupDocLinks } from '@/components/connections/SetupDocLinks';
import {
  DEFAULT_CONNECTION_FORM,
  DEPLOYMENT_SCENARIOS,
  FIELD_HELP,
  getTsPrepStep,
  type ConnectionFormState,
  type DeploymentScenarioId,
} from '@/content/connection-setup';
import { TS6_SERVER_DOCS } from '@/content/teamspeak-docs';
import { ArrowLeft, ArrowRight, Check, Loader2, Radar, Sparkles, TestTube } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const STEPS = [
  'Where is your TeamSpeak server?',
  'WebQuery connection',
  'SSH (optional)',
  'Review & finish',
] as const;

const REMOTE_SCENARIOS = new Set<DeploymentScenarioId>(['remote-ts', 'manager-docker-remote-ts']);

interface DeploymentCheckResult {
  managerInDocker: boolean;
  probes: Array<{ host: string; port: number; dnsResolved: boolean; reachable: boolean }>;
  suggestedScenarioId: DeploymentScenarioId | null;
  suggestedHost: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
}

interface ConnectionSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

function WizardGuideCallout({
  title,
  docs,
  children,
}: {
  title?: string;
  docs?: readonly { label: string; url: string }[];
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground space-y-1">
      {title && <p className="font-medium text-foreground">{title}</p>}
      {children}
      {docs && docs.length > 0 && <SetupDocLinks docs={docs} className="flex flex-wrap gap-x-3 gap-y-1 pt-1" />}
    </div>
  );
}

export function ConnectionSetupWizard({ open, onOpenChange, onComplete }: ConnectionSetupWizardProps) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [scenarioId, setScenarioId] = useState<DeploymentScenarioId>('same-host');
  const [form, setForm] = useState<ConnectionFormState>(DEFAULT_CONNECTION_FORM);
  const [skipSsh, setSkipSsh] = useState(false);
  const [webqueryTestOk, setWebqueryTestOk] = useState<boolean | null>(null);
  const [sshTestOk, setSshTestOk] = useState<boolean | null>(null);
  const [detection, setDetection] = useState<DeploymentCheckResult | null>(null);
  const [detectionApplied, setDetectionApplied] = useState(false);
  const [hostSuggestionApplied, setHostSuggestionApplied] = useState(false);
  const [autoCheckStarted, setAutoCheckStarted] = useState(false);

  const scenario = useMemo(
    () => DEPLOYMENT_SCENARIOS.find((s) => s.id === scenarioId) ?? DEPLOYMENT_SCENARIOS[0],
    [scenarioId],
  );

  const webqueryPortGuide = getTsPrepStep('webquery-port');
  const apiKeyGuide = getTsPrepStep('api-key');
  const sshGuide = getTsPrepStep('ssh');
  const firewallGuide = getTsPrepStep('firewall');

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

  const runDetection = useMutation({
    mutationFn: () => serversApi.detectDeployment() as Promise<DeploymentCheckResult>,
    onSuccess: (data) => {
      setDetection(data);
      setDetectionApplied(false);
      setHostSuggestionApplied(false);
    },
    onError: (err: any) => {
      setDetection({
        managerInDocker: false,
        probes: [],
        suggestedScenarioId: null,
        suggestedHost: null,
        confidence: 'none',
        reason: err?.response?.data?.error || 'Self-check could not run. Choose your deployment manually.',
      });
      toast.error(err?.response?.data?.error || 'Self-check failed');
    },
  });

  const reset = () => {
    setStep(0);
    setScenarioId('same-host');
    setForm(DEFAULT_CONNECTION_FORM);
    setSkipSsh(false);
    setWebqueryTestOk(null);
    setSshTestOk(null);
    setDetection(null);
    setDetectionApplied(false);
    setHostSuggestionApplied(false);
    setAutoCheckStarted(false);
    runDetection.reset();
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  useEffect(() => {
    if (open && step === 0 && !autoCheckStarted && !runDetection.isPending) {
      setAutoCheckStarted(true);
      runDetection.mutate();
    }
  }, [open, step, autoCheckStarted, runDetection.isPending]);

  const applyScenario = (id: DeploymentScenarioId, hostOverride?: string) => {
    setScenarioId(id);
    const next = DEPLOYMENT_SCENARIOS.find((s) => s.id === id);
    if (!next) return;
    if (hostOverride !== undefined) {
      setForm((prev) => ({ ...prev, host: hostOverride }));
      setHostSuggestionApplied(true);
      return;
    }
    setForm((prev) => ({ ...prev, host: next.hostPlaceholder }));
    setHostSuggestionApplied(false);
  };

  const applyDetection = () => {
    if (!detection) return;
    if (detection.suggestedScenarioId) {
      applyScenario(
        detection.suggestedScenarioId,
        detection.suggestedHost ?? undefined,
      );
      setDetectionApplied(true);
      setHostSuggestionApplied(!!detection.suggestedHost);
    } else if (detection.suggestedHost) {
      setForm((prev) => ({ ...prev, host: detection.suggestedHost! }));
      setHostSuggestionApplied(true);
      toast.message('Suggested host applied — pick the scenario below that best matches your setup.');
    }
  };

  const suggestedScenario = detection?.suggestedScenarioId
    ? DEPLOYMENT_SCENARIOS.find((s) => s.id === detection.suggestedScenarioId)
    : null;

  const canNext = () => {
    if (step === 1) return !!form.name && !!form.host && !!form.apiKey;
    if (step === 2 && !skipSsh) {
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
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Choose how your TeamSpeak server is deployed relative to ts6-manager.
            </p>

            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <Radar className="h-3.5 w-3.5" /> Deployment self-check
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => runDetection.mutate()}
                  disabled={runDetection.isPending}
                >
                  {runDetection.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Checking…</>
                  ) : (
                    'Run again'
                  )}
                </Button>
              </div>

              {runDetection.isPending && !detection && (
                <p className="text-[11px] text-muted-foreground">
                  Probing localhost, Docker host, and common service names from the manager…
                </p>
              )}

              {detection && (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">{detection.reason}</p>
                  <div className="flex flex-wrap gap-1">
                    {detection.probes.map((probe) => (
                      <Badge
                        key={probe.host}
                        variant="outline"
                        className={cn(
                          'text-[10px]',
                          probe.reachable
                            ? 'text-emerald-400 border-emerald-500/30'
                            : 'text-muted-foreground',
                        )}
                      >
                        {probe.host}:{probe.port} {probe.reachable ? '✓' : '—'}
                      </Badge>
                    ))}
                    <Badge variant="secondary" className="text-[10px]">
                      Manager {detection.managerInDocker ? 'in Docker' : 'on host'}
                    </Badge>
                  </div>

                  {(detection.suggestedScenarioId || detection.suggestedHost) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {suggestedScenario && (
                        <span className="text-[11px] text-muted-foreground">
                          Suggested: <span className="text-foreground">{suggestedScenario.label}</span>
                        </span>
                      )}
                      {detection.suggestedHost && !suggestedScenario && (
                        <span className="text-[11px] text-muted-foreground">
                          Suggested host: <code className="font-mono-data">{detection.suggestedHost}</code>
                        </span>
                      )}
                      {detection.confidence !== 'none' && (
                        <Badge variant="outline" className="text-[10px] capitalize">{detection.confidence} confidence</Badge>
                      )}
                      {!(detectionApplied || hostSuggestionApplied) && (
                        <Button size="sm" className="h-7 text-xs" onClick={applyDetection}>
                          <Sparkles className="h-3 w-3 mr-1" /> Apply suggestion
                        </Button>
                      )}
                      {detectionApplied && (
                        <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30">Applied</Badge>
                      )}
                      {hostSuggestionApplied && !detectionApplied && (
                        <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30">Host applied</Badge>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {DEPLOYMENT_SCENARIOS.map((s) => {
              const isSuggested = detection?.suggestedScenarioId === s.id && !detectionApplied;
              const isSelected = scenarioId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => applyScenario(
                    s.id,
                    detection?.suggestedScenarioId === s.id && detection.suggestedHost ? detection.suggestedHost : undefined,
                  )}
                  className={cn(
                    'w-full text-left rounded-md border p-3 transition-colors',
                    isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30',
                    isSuggested && !isSelected && 'border-primary/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium">{s.label}</p>
                    {isSuggested && (
                      <Badge variant="secondary" className="text-[10px]">Suggested</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{s.description}</p>
                  <p className="text-[11px] mt-1">
                    Suggested host: <code className="font-mono-data">{s.hostPlaceholder}</code>
                  </p>
                  {s.docs && s.docs.length > 0 && (
                    <SetupDocLinks docs={s.docs} className="flex flex-wrap gap-x-3 gap-y-1 mt-2" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <WizardGuideCallout title="Network host" docs={scenario.docs}>
              <p>{scenario.hostHint}</p>
              {scenario.notes && <p className="mt-1">{scenario.notes}</p>}
              {REMOTE_SCENARIOS.has(scenarioId) && (
                <p className="mt-1">{firewallGuide.body}</p>
              )}
            </WizardGuideCallout>

            <div className="space-y-3">
              <div>
                <Label className="text-xs">Name</Label>
                <p className="text-[11px] text-muted-foreground mb-1">{FIELD_HELP.name}</p>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My TS Server" />
              </div>

              <div>
                <Label className="text-xs">Host</Label>
                <p className="text-[11px] text-muted-foreground mb-1">{FIELD_HELP.host}</p>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder={scenario.hostPlaceholder} />
              </div>

              <div>
                <Label className="text-xs">WebQuery Port</Label>
                <WizardGuideCallout title={webqueryPortGuide.title} docs={webqueryPortGuide.docs}>
                  <p>{webqueryPortGuide.body}</p>
                </WizardGuideCallout>
                <Input
                  className="mt-2"
                  type="number"
                  value={form.webqueryPort}
                  onChange={(e) => setForm({ ...form, webqueryPort: e.target.value })}
                />
              </div>

              <div>
                <Label className="text-xs">API Key</Label>
                <WizardGuideCallout title={apiKeyGuide.title} docs={apiKeyGuide.docs}>
                  <p>{apiKeyGuide.body}</p>
                  {'code' in apiKeyGuide && apiKeyGuide.code && (
                    <pre className="rounded bg-muted px-2 py-1.5 font-mono text-[11px] overflow-x-auto mt-1 whitespace-pre-wrap">{apiKeyGuide.code}</pre>
                  )}
                </WizardGuideCallout>
                <Input
                  className="mt-2"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder="WebQuery API Key"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch checked={form.useHttps} onCheckedChange={(v) => setForm({ ...form, useHttps: v })} />
                <Label className="text-xs">{FIELD_HELP.useHttps}</Label>
              </div>
              <SetupDocLinks
                docs={[{ label: 'HTTPS WebQuery setup (TS6 docs)', url: TS6_SERVER_DOCS.httpQuery }]}
                className="flex flex-wrap gap-x-3 gap-y-1"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestWebquery}
                disabled={testWebqueryDraft.isPending || !form.host || !form.apiKey}
              >
                {testWebqueryDraft.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <TestTube className="h-3 w-3 mr-1" />}
                Test WebQuery
              </Button>
              {webqueryTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">WebQuery OK</Badge>}
              {webqueryTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">WebQuery failed</Badge>}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <WizardGuideCallout title="Optional — SSH ServerQuery" docs={sshGuide.docs}>
              <p>{sshGuide.body}</p>
              <p className="mt-1 text-[10px]">Enables file browser, bot event triggers, and music bot !commands.</p>
            </WizardGuideCallout>

            <div className="flex gap-2">
              <Button variant={skipSsh ? 'default' : 'outline'} size="sm" onClick={() => setSkipSsh(true)}>Skip for now</Button>
              <Button variant={!skipSsh ? 'default' : 'outline'} size="sm" onClick={() => setSkipSsh(false)}>Configure SSH</Button>
            </div>

            {!skipSsh && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">SSH Port</Label>
                    <p className="text-[11px] text-muted-foreground mb-1">{FIELD_HELP.sshPort}</p>
                    <Input type="number" value={form.sshPort} onChange={(e) => setForm({ ...form, sshPort: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">SSH User</Label>
                    <p className="text-[11px] text-muted-foreground mb-1">{FIELD_HELP.sshUsername}</p>
                    <Input value={form.sshUsername} onChange={(e) => setForm({ ...form, sshUsername: e.target.value })} placeholder="serveradmin" />
                  </div>
                  <div>
                    <Label className="text-xs">SSH Password</Label>
                    <p className="text-[11px] text-muted-foreground mb-1">{FIELD_HELP.sshPassword}</p>
                    <Input type="password" value={form.sshPassword} onChange={(e) => setForm({ ...form, sshPassword: e.target.value })} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTestSsh}
                    disabled={testSshDraft.isPending || !form.host || !form.sshUsername || !form.sshPassword}
                  >
                    {testSshDraft.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <TestTube className="h-3 w-3 mr-1" />}
                    Test SSH
                  </Button>
                  {sshTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">SSH OK</Badge>}
                  {sshTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">SSH failed</Badge>}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-border p-3 space-y-1">
              <p><span className="text-muted-foreground">Deployment:</span> {scenario.label}</p>
              <p><span className="text-muted-foreground">Name:</span> {form.name}</p>
              <p><span className="text-muted-foreground">Host:</span> {form.host}:{form.webqueryPort}</p>
              <p><span className="text-muted-foreground">HTTPS:</span> {form.useHttps ? 'Yes' : 'No'}</p>
              <p>
                <span className="text-muted-foreground">SSH:</span>{' '}
                {skipSsh || !form.sshUsername ? 'Not configured' : `${form.sshUsername}@${form.host}:${form.sshPort}`}
              </p>
            </div>

            {(webqueryTestOk !== null || sshTestOk !== null) && (
              <div className="flex flex-wrap gap-2">
                {webqueryTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">WebQuery tested</Badge>}
                {webqueryTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">WebQuery test failed</Badge>}
                {sshTestOk === true && <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">SSH tested</Badge>}
                {sshTestOk === false && <Badge variant="outline" className="text-destructive border-destructive/30">SSH test failed</Badge>}
              </div>
            )}
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
