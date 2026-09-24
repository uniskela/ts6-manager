import { useEffect, useId, useRef, useState } from 'react';
import { FileUp, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  CUSTOM_CSS_MAX_BYTES,
  SAFE_UI_RECOVERY_PATH,
  isCustomCssWithinLimit,
  utf8ByteLength,
} from '@/lib/custom-css';
import { isSafeUiActive } from '@/lib/safe-ui';
import { useUiStore } from '@/stores/ui.store';
import { toast } from 'sonner';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

export function CustomCssSection({ forceAdvancedOpen = false }: { forceAdvancedOpen?: boolean }) {
  const customCssText = useUiStore((s) => s.customCssText);
  const customCssEnabled = useUiStore((s) => s.customCssEnabled);
  const setCustomCssText = useUiStore((s) => s.setCustomCssText);
  const setCustomCssEnabled = useUiStore((s) => s.setCustomCssEnabled);
  const resetCustomCss = useUiStore((s) => s.resetCustomCss);

  const [draft, setDraft] = useState(customCssText);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [accordionValue, setAccordionValue] = useState<string | undefined>(
    forceAdvancedOpen || customCssEnabled ? 'custom-css' : undefined,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enableId = useId();
  const safeUi = isSafeUiActive();

  useEffect(() => {
    setDraft(customCssText);
    setDraftError(null);
  }, [customCssText]);

  useEffect(() => {
    if (forceAdvancedOpen || safeUi) {
      setAccordionValue('custom-css');
    }
  }, [forceAdvancedOpen, safeUi]);

  const draftDirty = draft !== customCssText;
  const draftBytes = utf8ByteLength(draft);
  const limitLabel = formatBytes(CUSTOM_CSS_MAX_BYTES);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!isCustomCssWithinLimit(value)) {
      setDraftError(`Custom CSS must be ${limitLabel} or smaller (UTF-8). Current size: ${formatBytes(utf8ByteLength(value))}.`);
    } else {
      setDraftError(null);
    }
  };

  const handleSave = () => {
    if (!isCustomCssWithinLimit(draft)) {
      setDraftError(`Custom CSS must be ${limitLabel} or smaller (UTF-8). Current size: ${formatBytes(utf8ByteLength(draft))}.`);
      toast.error(`Custom CSS exceeds the ${limitLabel} limit`);
      return;
    }
    const result = setCustomCssText(draft);
    if (!result.ok) {
      setDraftError(`Custom CSS must be ${limitLabel} or smaller (UTF-8).`);
      toast.error(`Custom CSS exceeds the ${limitLabel} limit`);
      return;
    }
    setDraftError(null);
    toast.success(customCssEnabled ? 'Custom CSS saved and applied' : 'Custom CSS saved');
  };

  const handleEnableChange = (next: boolean) => {
    if (next && safeUi) {
      toast.error('Safe UI mode is active. Reload without ?safe-ui=1 before enabling custom CSS.');
      return;
    }
    if (next && customCssText.length === 0) {
      toast.error('Save some CSS before enabling');
      return;
    }
    setCustomCssEnabled(next);
    toast.success(next ? 'Custom CSS enabled' : 'Custom CSS disabled (text kept)');
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.css') && file.type !== 'text/css') {
      toast.error('Choose a local .css file');
      return;
    }
    try {
      const text = await file.text();
      if (!isCustomCssWithinLimit(text)) {
        setDraftError(`Imported file is ${formatBytes(utf8ByteLength(text))}; limit is ${limitLabel}.`);
        toast.error(`Imported CSS exceeds the ${limitLabel} limit`);
        return;
      }
      handleDraftChange(text);
      toast.success('Imported into the editor draft — Save to commit');
    } catch {
      toast.error('Could not read that file');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleResetConfirm = () => {
    resetCustomCss();
    setDraft('');
    setDraftError(null);
    setResetOpen(false);
    toast.success('Custom CSS cleared');
  };

  return (
    <>
      <Accordion
        type="single"
        collapsible
        value={accordionValue}
        onValueChange={(v) => setAccordionValue(v || undefined)}
        className="w-full rounded-md border border-border px-3"
      >
        <AccordionItem value="custom-css" className="border-0">
          <AccordionTrigger className="text-sm font-medium hover:no-underline">
            Advanced — Custom CSS
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-4">
            {safeUi && (
              <div
                role="status"
                className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-medium">Safe UI mode is active for this page load</p>
                  <p className="text-warning/90">
                    Stored custom CSS is not applied. Disable or Reset below, then reload without{' '}
                    <span className="font-mono-data">?safe-ui=1</span> to use custom CSS again.
                    Safe mode does not erase your saved CSS.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                Custom CSS is stored only in this browser. It is injected after application styles
                when enabled, and only inside the signed-in management UI.
              </p>
              <p>
                Custom CSS can hide controls, override accessibility, and cause the browser to
                request external resources via constructs such as <span className="font-mono-data">@import</span>{' '}
                and <span className="font-mono-data">url(...)</span>. There is no sanitizer — treat
                pasted/imported CSS as trusted local customization.
              </p>
              <p>
                Before enabling, copy a recovery URL you can type if the UI becomes unusable:{' '}
                <span className="break-all font-mono-data text-foreground">{SAFE_UI_RECOVERY_PATH}</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id={enableId}
                  checked={customCssEnabled}
                  disabled={!customCssEnabled && (safeUi || customCssText.length === 0)}
                  onCheckedChange={handleEnableChange}
                  aria-label="Enable custom CSS"
                />
                <Label htmlFor={enableId} className="text-sm font-medium">
                  Enable custom CSS
                </Label>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {formatBytes(draftBytes)} / {limitLabel}
                {draftDirty ? ' · unsaved draft' : ''}
              </span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="custom-css-editor" className="text-xs">
                CSS editor
              </Label>
              <Textarea
                id="custom-css-editor"
                aria-label="Custom CSS editor"
                spellCheck={false}
                className="min-h-[10rem] font-mono text-xs leading-relaxed"
                value={draft}
                onChange={(e) => handleDraftChange(e.target.value)}
                placeholder={':root {\n  /* your overrides */\n}'}
              />
              {draftError && (
                <p role="alert" className="text-xs text-destructive">{draftError}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Typing and importing update the draft only. Save commits; Enable applies the saved text.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={handleSave} disabled={!draftDirty && !draftError}>
                Save CSS
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".css,text/css"
                className="hidden"
                aria-hidden="true"
                onChange={(e) => void handleImport(e.target.files?.[0])}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Import .css
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!customCssEnabled}
                onClick={() => handleEnableChange(false)}
              >
                Disable
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={customCssText.length === 0 && !customCssEnabled && draft.length === 0}
                onClick={() => setResetOpen(true)}
              >
                Reset
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset custom CSS?"
        description="This disables custom CSS and permanently clears the saved text in this browser. Base theme, accent, background, and motion preferences are kept."
        confirmLabel="Reset custom CSS"
        onConfirm={handleResetConfirm}
        destructive
      />
    </>
  );
}
