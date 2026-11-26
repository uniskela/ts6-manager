/**
 * Admin allowlist of LAN hosts for one kind of admin-configured source (IPTV
 * playlists, radio stations). Each source keeps its own list and wording; this
 * is the shared trigger button and editing dialog.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api-error';
import { parseHostLines } from '@/lib/iptv-network';

export type LocalHostsSettings = { allowedLocalHosts: string[] };
export type LocalHostsQuery = UseQueryResult<LocalHostsSettings>;
export type LocalHostsUpdate = UseMutationResult<LocalHostsSettings, unknown, string[]>;

/** Wording for one source's allowlist. */
export interface LocalHostsCopy {
  tooltip: string;
  title: string;
  description: ReactNode;
  label: string;
  inputId: string;
  placeholder: string;
  hint: ReactNode;
  savedToast: string;
  clearedToast: string;
  failedToast: string;
}

interface LocalHostsTriggerProps {
  readonly query: LocalHostsQuery;
  readonly tooltip: string;
  readonly onClick: () => void;
}

/** Header control that opens the allowlist dialog, with a count of allowed hosts. */
export function LocalHostsTrigger({ query, tooltip, onClick }: LocalHostsTriggerProps) {
  const count = query.data?.allowedLocalHosts.length ?? 0;

  return (
    <Button type="button" variant="outline" onClick={onClick} title={tooltip}>
      <Network className="h-4 w-4 mr-1.5" aria-hidden="true" />
      Local hosts
      {count > 0 && (
        <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]" aria-label={`${count} allowed hosts`}>
          {count}
        </Badge>
      )}
    </Button>
  );
}

interface LocalHostsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly query: LocalHostsQuery;
  readonly update: LocalHostsUpdate;
  readonly copy: LocalHostsCopy;
}

export function LocalHostsDialog({ open, onOpenChange, query, update, copy }: LocalHostsDialogProps) {
  const saved = query.data?.allowedLocalHosts ?? [];
  /** null = not loaded for this open cycle (avoids refetch clobbering dirty edits). */
  const [draft, setDraft] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      return;
    }
    // Capture the control that opened the dialog (header button or empty-state hint).
    if (document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.data || draft !== null) return;
    setDraft(query.data.allowedLocalHosts.join('\n'));
  }, [open, query.data, draft]);

  const draftText = draft ?? '';
  const hosts = parseHostLines(draftText);
  const dirty = draft !== null && hosts.join('\n') !== saved.join('\n');

  const save = () => {
    update.mutate(hosts, {
      onSuccess: (data) => {
        setDraft(data.allowedLocalHosts.join('\n'));
        toast.success(data.allowedLocalHosts.length ? copy.savedToast : copy.clearedToast);
      },
      onError: (e) => toast.error(apiErrorMessage(e, copy.failedToast)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" aria-hidden="true" /> {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <Label htmlFor={copy.inputId}>{copy.label}</Label>
          <Textarea
            id={copy.inputId}
            rows={5}
            spellCheck={false}
            placeholder={copy.placeholder}
            value={draftText}
            onChange={(e) => setDraft(e.target.value)}
            disabled={draft === null || !query.data}
          />
          <p className="text-xs text-muted-foreground">{copy.hint}</p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setDraft(saved.join('\n'))}>
              Reset
            </Button>
          )}
          <Button type="button" onClick={save} disabled={draft === null || !query.data || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save hosts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
