import { useRef, useState } from 'react';
import type { ServerIcon } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useDeleteServerIcon, useServerIconImage, useServerIcons, useUploadServerIcon } from '@/hooks/use-server-icons';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { Ban, ImageOff, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

function IconImage({ id }: Readonly<{ id: number }>) {
  const { url, failed } = useServerIconImage(id);
  if (url) return <img src={url} alt="" className="h-6 w-6 object-contain" />;
  if (failed) return <ImageOff className="h-4 w-4 text-muted-foreground" />;
  return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
}

/**
 * Icons stored on the TeamSpeak server: upload one, pick one, or remove one.
 * `value` is the icon id (0 = no icon) the channel stores.
 */
export function ServerIconPicker({ value, onSelect }: Readonly<{ value: number; onSelect: (id: number) => void }>) {
  const input = useRef<HTMLInputElement>(null);
  const icons = useServerIcons(true);
  const upload = useUploadServerIcon();
  const remove = useDeleteServerIcon();
  const [deleteTarget, setDeleteTarget] = useState<ServerIcon | null>(null);

  const data = icons.data;
  const maxKb = data ? Math.round(data.maxBytes / 1024) : 256;
  const known = !!data?.icons.some((icon) => icon.id === value);

  return (
    <section aria-label="Server icons" className="mt-2 space-y-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium">Server icons</p>
          <p className="text-[10px] text-muted-foreground">Icons stored on this TeamSpeak server. Click one to use it for this channel.</p>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" aria-label="Upload icon"
          className="hidden" disabled={upload.isPending} onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            upload.mutate(file, {
              onSuccess: (icon) => { onSelect(icon.id); toast.success('Icon uploaded and selected'); },
            });
          }} />
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={upload.isPending || !data}
          onClick={() => input.current?.click()}>
          {upload.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
          Upload
        </Button>
      </div>

      {icons.isLoading && <p className="text-[10px] text-muted-foreground">Loading server icons…</p>}
      {icons.error && <p role="alert" className="text-[10px] text-destructive">{apiErrorMessage(icons.error, 'Could not load server icons')}</p>}

      {data && (
        <ul className="flex flex-wrap gap-1.5">
          <li>
            <button type="button" aria-pressed={value === 0} aria-label="No icon" title="No icon" onClick={() => onSelect(0)}
              className={cn('flex h-10 w-10 items-center justify-center rounded border bg-muted/40',
                value === 0 ? 'ring-2 ring-primary' : 'hover:border-primary/60')}>
              <Ban className="h-4 w-4 text-muted-foreground" />
            </button>
          </li>
          {data.icons.map((icon) => {
            const selected = icon.id === value;
            return (
              <li key={icon.id} className="relative">
                <button type="button" aria-pressed={selected} aria-label={`${selected ? 'Selected icon' : 'Use icon'} ${icon.id}`}
                  title={`Icon ${icon.id}`} onClick={() => onSelect(icon.id)}
                  className={cn('flex h-10 w-10 items-center justify-center rounded border bg-muted/40',
                    selected ? 'ring-2 ring-primary' : 'hover:border-primary/60')}>
                  <IconImage id={icon.id} />
                </button>
                <button type="button" aria-label={`Delete icon ${icon.id}`} title="Delete icon"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => { remove.reset(); setDeleteTarget(icon); }}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {data && value !== 0 && !known && (
        <p className="text-[10px] text-muted-foreground">Icon {value} is not in this server's icon list{data.truncated ? ' shown here' : ''}.</p>
      )}
      {data?.truncated && <p className="text-[10px] text-muted-foreground">Showing the newest {data.icons.length} icons.</p>}

      <p className="text-[10px] text-muted-foreground">PNG, JPEG or GIF, at most {maxKb} KB. TeamSpeak shows icons at 16×16.</p>
      {upload.error && <p role="alert" className="text-[10px] text-destructive">{apiErrorMessage(upload.error, 'Could not upload icon')}</p>}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete server icon"
        description="Channels and groups still using this icon will stop showing it."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        error={remove.error ? apiErrorMessage(remove.error, 'Could not delete icon') : undefined}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          remove.mutate(target.id, {
            onSuccess: () => {
              if (target.id === value) onSelect(0);
              setDeleteTarget(null);
              toast.success('Icon deleted');
            },
          });
        }}
      />
    </section>
  );
}
