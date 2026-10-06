import { apiErrorPresentation } from '@/lib/api-error';

/** Title + explanation for a structured API error (not a raw Axios sentence). */
export function ApiErrorAlert({ error, fallback }: { error: unknown; fallback: string }) {
  const p = apiErrorPresentation(error, fallback);
  return (
    <div role="alert" className="space-y-0.5 text-sm text-destructive">
      <p className="font-medium">{p.title}</p>
      {p.message && p.message !== p.title && <p className="text-xs">{p.message}</p>}
      {p.action && <p className="text-xs text-muted-foreground">{p.action}</p>}
    </div>
  );
}
