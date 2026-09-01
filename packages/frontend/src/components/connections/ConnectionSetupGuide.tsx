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
import { BookOpen, Check, ChevronDown, ChevronUp, Circle, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConnectionSetupGuideProps {
  hasConnections: boolean;
  hasSshOnAnyConnection: boolean;
  webqueryTestPassed?: boolean;
  onStartWizard: () => void;
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

export function ConnectionSetupGuide({
  hasConnections,
  hasSshOnAnyConnection,
  webqueryTestPassed,
  onStartWizard,
}: ConnectionSetupGuideProps) {
  const [collapsed, setCollapsed] = useState(hasConnections);
  const [checklist, setChecklist] = useState<ChecklistState>(loadChecklist);

  useEffect(() => {
    setCollapsed(hasConnections);
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

  if (collapsed) {
    return (
      <Card>
        <CardContent className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="h-4 w-4" />
            <span>Connection setup guide ({completedCount}/{CHECKLIST_ITEMS.length} complete)</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onStartWizard}>
              <Wand2 className="h-3 w-3 mr-1" /> Setup wizard
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCollapsed(false)}>
              Show guide <ChevronDown className="h-3 w-3 ml-1" />
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
              Connection setup guide
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Connect your TeamSpeak server using WebQuery (required) and SSH (optional for files, bot events, and music commands).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" className="h-7 text-xs" onClick={onStartWizard}>
              <Wand2 className="h-3.5 w-3.5 mr-1" /> Start setup wizard
            </Button>
            {hasConnections && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCollapsed(true)}>
                Collapse <ChevronUp className="h-3 w-3 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-border p-3 space-y-2">
          <p className="text-xs font-medium">Setup checklist</p>
          <ul className="space-y-1.5">
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
        </div>

        <Accordion type="multiple" defaultValue={hasConnections ? [] : ['what-you-need', 'network']}>
          <AccordionItem value="what-you-need">
            <AccordionTrigger className="text-xs py-2">What you need</AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">WebQuery HTTP</span> is required for dashboard, channels, clients, permissions, and most bot actions.
                </p>
                <p>
                  <span className="font-medium text-foreground">SSH ServerQuery</span> is optional but needed for the file browser, bot event triggers, and music bot chat commands.
                </p>
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
            <AccordionTrigger className="text-xs py-2">Choose your network setup</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-2">
                {DEPLOYMENT_SCENARIOS.map((scenario) => (
                  <div key={scenario.id} className="rounded-md border border-border p-2.5 space-y-1">
                    <p className="text-xs font-medium">{scenario.label}</p>
                    <p className="text-xs text-muted-foreground">{scenario.description}</p>
                    <p className="text-xs">
                      <span className="text-muted-foreground">Host: </span>
                      <code className="font-mono-data">{scenario.hostPlaceholder}</code>
                      <span className="text-muted-foreground"> — {scenario.hostHint}</span>
                    </p>
                    {scenario.notes && (
                      <p className="text-[11px] text-muted-foreground">{scenario.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="form-fields">
            <AccordionTrigger className="text-xs py-2">Fill in the form</AccordionTrigger>
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

          <AccordionItem value="test-select">
            <AccordionTrigger className="text-xs py-2">Test &amp; select</AccordionTrigger>
            <AccordionContent>
              <ol className="space-y-2 text-xs text-muted-foreground list-decimal list-inside">
                <li>Click <span className="font-medium text-foreground">Test</span> on your connection card to verify WebQuery.</li>
                <li>If SSH is configured, use the SSH test button to verify ServerQuery access.</li>
                <li>Select your connection from the server dropdown in the header to use the dashboard and other pages.</li>
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}
