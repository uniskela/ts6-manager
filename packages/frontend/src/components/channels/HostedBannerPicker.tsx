import { useRef, useState } from 'react';
import type { HostedChannelBanner } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { useChannelBanners, useDeleteChannelBanner, useUpdatePublicUrl, useUploadChannelBanner } from '@/hooks/use-channel-banners';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/utils';
import { Check, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api/client';

/**
 * Where this browser reaches the manager: the address the API client uses,
 * minus its `/api` suffix, so a path prefix in front of the API is kept.
 */
function suggestedPublicUrl(): string {
  if (typeof window === 'undefined') return '';
  const apiBase = new URL(api.defaults.baseURL ?? '/api', window.location.href);
  return `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
}

/**
 * Upload channel banners to this manager and pick one; the chosen banner's
 * public link becomes the channel's banner image URL.
 */
export function HostedBannerPicker({ value, onSelect }: { value: string; onSelect: (url: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const banners = useChannelBanners(true);
  const upload = useUploadChannelBanner();
  const remove = useDeleteChannelBanner();
  const savePublicUrl = useUpdatePublicUrl();
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HostedChannelBanner | null>(null);

  const data = banners.data;
  const publicUrl = data?.publicUrl ?? null;
  const showUrlForm = !!data && (editingUrl !== null || !publicUrl);
  const urlDraft = editingUrl ?? suggestedPublicUrl();
  const maxMb = data ? Math.round(data.maxBytes / (1024 * 1024)) : 5;

  const handleSaveUrl = () => {
    // Keep a selected hosted banner pointing at the new address; leave other URLs alone.
    const selected = data?.banners.find((banner) => !!banner.url && banner.url === value);
    savePublicUrl.mutate(urlDraft, {
      onSuccess: (settings) => {
        if (selected && settings.effective && valueRef.current === selected.url) onSelect(`${settings.effective}${selected.path}`);
        setEditingUrl(null);
        toast.success('Public URL saved');
      },
    });
  };

  return (
    <section aria-label="Hosted banners" className="mt-2 space-y-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Hosted banners</p>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Upload banner"
          className="hidden" disabled={upload.isPending} onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            upload.mutate(file, {
              onSuccess: (banner) => {
                if (banner.url) onSelect(banner.url);
                toast.success(banner.url ? 'Banner uploaded and selected' : 'Banner uploaded');
              },
            });
          }} />
        <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={upload.isPending || !data}
          onClick={() => input.current?.click()}>
          {upload.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
          Upload
        </Button>
      </div>

      {banners.isLoading && <p className="text-[10px] text-muted-foreground">Loading hosted banners…</p>}
      {banners.error && <p role="alert" className="text-[10px] text-destructive">{apiErrorMessage(banners.error, 'Could not load hosted banners')}</p>}

      {data && showUrlForm && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            Public URL TeamSpeak clients use to reach this manager. Links to hosted banners start with it.
          </p>
          <div className="flex gap-2">
            <Input aria-label="Public URL" className="h-8 text-xs" value={urlDraft} placeholder="https://ts6.example.com"
              onChange={(e) => setEditingUrl(e.target.value)} />
            <Button type="button" size="sm" className="h-8 text-xs" disabled={savePublicUrl.isPending || !urlDraft.trim()} onClick={handleSaveUrl}>Save</Button>
            {publicUrl && <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditingUrl(null)}>Cancel</Button>}
          </div>
          {savePublicUrl.error && <p role="alert" className="text-[10px] text-destructive">{apiErrorMessage(savePublicUrl.error, 'Could not save public URL')}</p>}
        </div>
      )}
      {data && !showUrlForm && publicUrl && (
        <p className="text-[10px] text-muted-foreground">
          Links use <span className="font-mono break-all">{publicUrl}</span>
          {data.publicUrlSource === 'env' && ' (PUBLIC_URL)'}.{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => setEditingUrl(publicUrl)}>Change</button>
        </p>
      )}

      {data && data.banners.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.banners.map((banner) => {
            const selected = !!banner.url && banner.url === value;
            return (
              <li key={banner.name} className="relative">
                <button type="button" disabled={!banner.url} aria-pressed={selected}
                  aria-label={selected ? 'Selected hosted banner' : 'Use this hosted banner'}
                  title={banner.url ? 'Use this banner' : 'Save a public URL first'}
                  onClick={() => banner.url && onSelect(banner.url)}
                  className={cn('block w-full overflow-hidden rounded border bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60',
                    selected ? 'ring-2 ring-primary' : 'hover:border-primary/60')}>
                  <img src={banner.path} alt="" loading="lazy" className="h-14 w-full object-cover" />
                  {selected && <Check className="absolute left-1 top-1 h-4 w-4 rounded-full bg-primary p-0.5 text-primary-foreground" />}
                </button>
                <Button type="button" size="icon" variant="ghost" aria-label="Delete hosted banner" title="Delete hosted banner"
                  className="absolute right-0.5 top-0.5 h-6 w-6 bg-background/80 hover:bg-background"
                  onClick={() => { remove.reset(); setDeleteTarget(banner); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[10px] text-muted-foreground">PNG, JPEG, GIF or WebP, at most {maxMb} MB.</p>
      {upload.error && <p role="alert" className="text-[10px] text-destructive">{apiErrorMessage(upload.error, 'Could not upload banner')}</p>}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete hosted banner"
        description="Channels still using this banner will stop showing it."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        error={remove.error ? apiErrorMessage(remove.error, 'Could not delete banner') : undefined}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          remove.mutate(target.name, {
            onSuccess: () => {
              if (target.url && target.url === value) onSelect('');
              setDeleteTarget(null);
              toast.success('Banner deleted');
            },
          });
        }}
      />
    </section>
  );
}
