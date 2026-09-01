import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { SetupDocLinks } from '@/components/connections/SetupDocLinks';
import {
  CHECKLIST_ITEMS,
  CHECKLIST_STORAGE_KEY,
  DEPLOYMENT_SCENARIOS,
  FEATURE_MATRIX,
  FIELD_HELP,
  TS_PREP_STEPS,
  type ChecklistItemId,
} from '@/content/connection-setup';
import { TS6_SERVER_DOCS } from '@/content/teamspeak-docs';
import { Check, Circle, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type ChecklistState = Partial<Record<ChecklistItemId, boolean>>;

function loadChecklist(): ChecklistState {
  try {
    const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveChecklist(state: ChecklistState) {
  localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(state));
}

const QUICK_NETWORK_TIPS: Array<{ label: string; host: string; note?: string }> = [
  { label: 'TS on this machine', host: '127.0.0.1' },
  { label: 'TS in Docker, manager in Docker', host: 'teamspeak', note: 'use your TS service/container name' },
  { label: 'TS on Windows/WSL host, manager in Docker', host: 'host.docker.internal' },
];

interface ConnectionSetupHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasConnections: boolean;
  hasSshOnAnyConnection: boolean;
  webqueryTestPassed?: boolean;
  onStartWizard?: () => void;
}

export function ConnectionSetupHelpDialog({
  open,
  onOpenChange,
  hasConnections,
  hasSshOnAnyConnection,
  webqueryTestPassed,
  onStartWizard,
}: ConnectionSetupHelpDialogProps) {
  const [checklist, setChecklist] = useState<ChecklistState>(loadChecklist);

  const autoChecklist = useMemo<ChecklistState>(() => ({
    'connection-added': hasConnections,
    'webquery-tested': !!webqueryTestPassed,
    'ssh-configured': hasSshOnAnyConnection,
  }), [hasConnections, hasSshOnAnyConnection, webqueryTestPassed]);

  const mergedChecklist = useMemo(
    () => ({ ...checklist, ...autoChecklist }),
    [checklist, autoChecklist],
  );

  const toggleManual = (id: ChecklistItemId) => {
    const item = CHECKLIST_ITEMS.find((i) => i.id === id);
    if (!item?.manual) return;
    setChecklist((prev) => {
      const next = { ...prev, [id]: !mergedChecklist[id] };
      saveChecklist(next);
      return next;
    });
  };

  const completedCount = CHECKLIST_ITEMS.filter((item) => mergedChecklist[item.id]).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Connection help</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Reference only — the setup wizard is the easiest way to connect.
          </p>
          <SetupDocLinks
            docs={[{ label: 'TeamSpeak 6 Server docs', url: TS6_SERVER_DOCS.home }]}
            className="flex flex-wrap gap-x-3 gap-y-1"
          />
        </DialogHeader>

        <div className="space-y-4">
          {onStartWizard && (
            <Button size="sm" className="h-7 text-xs" onClick={() => { onOpenChange(false); onStartWizard(); }}>
              <Wand2 className="h-3.5 w-3.5 mr-1" /> Start setup wizard
            </Button>
          )}

          <details className="rounded-md border border-border p-3">
            <summary className="text-xs font-medium cursor-pointer list-none flex items-center justify-between">
              Setup checklist
              <span className="text-muted-foreground font-normal">{completedCount}/{CHECKLIST_ITEMS.length}</span>
            </summary>
            <ul className="space-y-1.5 mt-3">
              {CHECKLIST_ITEMS.map((item) => {
                const done = !!mergedChecklist[item.id];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-2 text-xs w-full text-left',
                        item.manual ? 'hover:text-foreground cursor-pointer' : 'cursor-default',
                      )}
                      onClick={() => toggleManual(item.id)}
                      disabled={!item.manual}
                    >
                      {done ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className={done ? 'text-muted-foreground line-through' : ''}>{item.label}</span>
                      {item.id === 'ssh-configured' && (
                        <Badge variant="secondary" className="text-[10px] ml-1">optional</Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>

          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="what-you-need">
              <AccordionTrigger className="text-xs py-2">What you need</AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p><span className="font-medium text-foreground">WebQuery</span> — dashboard, channels, clients, permissions, most bots.</p>
                  <p><span className="font-medium text-foreground">SSH</span> — optional: file browser, bot events, music !commands.</p>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="prepare-ts">
              <AccordionTrigger className="text-xs py-2">Prepare TeamSpeak</AccordionTrigger>
              <AccordionContent>
                <ol className="space-y-3 text-xs text-muted-foreground list-decimal list-inside">
                  {TS_PREP_STEPS.map((step) => (
                    <li key={step.id} className="space-y-1">
                      <span className="font-medium text-foreground">{step.title}</span>
                      <p>{step.body}</p>
                      {'code' in step && step.code && (
                        <pre className="rounded bg-muted px-2 py-1.5 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">{step.code}</pre>
                      )}
                      {'docs' in step && step.docs && (
                        <SetupDocLinks docs={step.docs} className="flex flex-wrap gap-x-3 gap-y-1 pt-1" />
                      )}
                    </li>
                  ))}
                </ol>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="network">
              <AccordionTrigger className="text-xs py-2">Network / host hints</AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-2 text-xs mb-3">
                  {QUICK_NETWORK_TIPS.map((tip) => (
                    <li key={tip.label} className="flex flex-wrap gap-x-2 gap-y-0.5">
                      <span className="text-muted-foreground shrink-0">{tip.label}:</span>
                      <code className="font-mono-data">{tip.host}</code>
                      {tip.note && <span className="text-muted-foreground">({tip.note})</span>}
                    </li>
                  ))}
                </ul>
                <details>
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                    All deployment scenarios
                  </summary>
                  <div className="grid gap-2 mt-2">
                    {DEPLOYMENT_SCENARIOS.map((scenario) => (
                      <div key={scenario.id} className="rounded-md border border-border p-2 space-y-1">
                        <p className="text-xs font-medium">{scenario.label}</p>
                        <p className="text-[11px] text-muted-foreground">
                          Host: <code className="font-mono-data">{scenario.hostPlaceholder}</code>
                        </p>
                        {scenario.docs && (
                          <SetupDocLinks docs={scenario.docs} className="flex flex-wrap gap-x-3 gap-y-1" />
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="form-fields">
              <AccordionTrigger className="text-xs py-2">Form field reference</AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-2 text-xs text-muted-foreground">
                  {Object.entries(FIELD_HELP).map(([field, help]) => (
                    <li key={field}>
                      <span className="font-medium text-foreground capitalize">{field.replace(/([A-Z])/g, ' $1')}: </span>
                      {help}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="features">
              <AccordionTrigger className="text-xs py-2">Feature / transport matrix</AccordionTrigger>
              <AccordionContent>
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="px-2 py-1.5 text-left font-medium">Feature</th>
                        <th className="px-2 py-1.5 text-left font-medium">Transport</th>
                      </tr>
                    </thead>
                    <tbody>
                      {FEATURE_MATRIX.map((row) => (
                        <tr key={row.feature} className="border-b border-border last:border-0">
                          <td className="px-2 py-1.5">{row.feature}</td>
                          <td className="px-2 py-1.5">
                            <Badge variant="outline" className="text-[10px]">{row.transport}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </DialogContent>
    </Dialog>
  );
}
