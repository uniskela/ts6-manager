import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import {
  CHECKLIST_ITEMS,
  CHECKLIST_STORAGE_KEY,
  DEPLOYMENT_SCENARIOS,
  FEATURE_MATRIX,
  FIELD_HELP,
  TS_PREP_STEPS,
  type ChecklistItemId,
} from '@/content/connection-setup';
import { BookOpen, Check, ChevronUp, Circle, HelpCircle, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConnectionSetupGuideProps {
  hasConnections: boolean;
  hasSshOnAnyConnection: boolean;
  webqueryTestPassed?: boolean;
  onStartWizard: () => void;
  onAddManually?: () => void;
}

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

/** Shown first in the network section — wizard covers the rest. */
const QUICK_NETWORK_TIPS: Array<{ label: string; host: string; note?: string }> = [
  { label: 'TS on this machine', host: '127.0.0.1' },
  { label: 'TS in Docker, manager in Docker', host: 'teamspeak', note: 'use your TS service/container name' },
  { label: 'TS on Windows/WSL host, manager in Docker', host: 'host.docker.internal' },
];

export function ConnectionSetupGuide({
  hasConnections,
  hasSshOnAnyConnection,
  webqueryTestPassed,
  onStartWizard,
  onAddManually,
}: ConnectionSetupGuideProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistState>(loadChecklist);

  useEffect(() => {
    if (hasConnections) setShowDetails(false);
  }, [hasConnections]);

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

  // Minimal bar once the user already has a connection configured.
  if (hasConnections && !showDetails) {
    return (
      <Card>
        <CardContent className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="h-4 w-4 shrink-0" />
            <span>Connection help ({completedCount}/{CHECKLIST_ITEMS.length} checklist items)</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowDetails(true)}>
            <HelpCircle className="h-3 w-3 mr-1" /> Help
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Default: short intro + wizard CTA. Details are opt-in.
  if (!showDetails) {
    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-4 space-y-3">
          <div>
            <p className="text-sm font-medium">Connect your TeamSpeak server</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xl">
              You need a WebQuery API key to get started. SSH is optional and only required for the file browser, bot events, and music bot commands.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onStartWizard}>
              <Wand2 className="h-3.5 w-3.5 mr-1" /> Start setup wizard
            </Button>
            {onAddManually && (
              <Button variant="outline" size="sm" onClick={onAddManually}>
                Add manually
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setShowDetails(true)}>
              <HelpCircle className="h-3.5 w-3.5 mr-1" /> Need help?
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              Connection help
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Reference material — the setup wizard walks you through this step by step.
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setShowDetails(false)}>
            Hide <ChevronUp className="h-3 w-3 ml-1" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="h-7 text-xs" onClick={onStartWizard}>
            <Wand2 className="h-3.5 w-3.5 mr-1" /> Start setup wizard
          </Button>
        </div>

        <details className="rounded-md border border-border p-3 group">
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
                  <li key={step.title} className="space-y-1">
                    <span className="font-medium text-foreground">{step.title}</span>
                    <p>{step.body}</p>
                    {'code' in step && step.code && (
                      <pre className="rounded bg-muted px-2 py-1.5 font-mono text-[11px] overflow-x-auto">{step.code}</pre>
                    )}
                  </li>
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="network">
            <AccordionTrigger className="text-xs py-2">Network / host hints</AccordionTrigger>
            <AccordionContent>
              <p className="text-xs text-muted-foreground mb-2">
                Common cases — the setup wizard asks which applies to you.
              </p>
              <ul className="space-y-2 text-xs">
                {QUICK_NETWORK_TIPS.map((tip) => (
                  <li key={tip.label} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    <span className="text-muted-foreground shrink-0">{tip.label}:</span>
                    <code className="font-mono-data">{tip.host}</code>
                    {tip.note && <span className="text-muted-foreground">({tip.note})</span>}
                  </li>
                ))}
              </ul>
              <details className="mt-3">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  All deployment scenarios
                </summary>
                <div className="grid gap-2 mt-2">
                  {DEPLOYMENT_SCENARIOS.map((scenario) => (
                    <div key={scenario.id} className="rounded-md border border-border p-2 space-y-0.5">
                      <p className="text-xs font-medium">{scenario.label}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Host: <code className="font-mono-data">{scenario.hostPlaceholder}</code>
                      </p>
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
      </CardContent>
    </Card>
  );
}
