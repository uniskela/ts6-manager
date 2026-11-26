import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Product mark rendered from the canonical public SVG through a CSS mask.
 * The mask keeps one source of geometry while allowing the WebUI to apply its
 * current accent colour, blended into the brand violet (see globals.css).
 */
export function BrandMark({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      data-brand-mark
      className={cn('brand-mark inline-block shrink-0', className)}
      {...props}
    />
  );
}
