import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  icon?: LucideIcon;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  metadata?: ReactNode;
  className?: string;
}

/** A compact page heading for the product's high-traffic operational pages. */
export function PageHeader({
  title,
  icon: Icon,
  description,
  badge,
  actions,
  metadata,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-testid="page-header"
      className={cn('flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:justify-between', className)}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />}
          <h1 className="min-w-0 break-words text-xl font-semibold [overflow-wrap:anywhere]">{title}</h1>
          {badge}
        </div>
        {description && (
          <div className="mt-1 min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </div>
        )}
      </div>
      {(actions || metadata) && (
        <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:shrink-0 sm:items-end lg:flex-row lg:items-center">
          {actions && (
            <div
              data-testid="page-header-actions"
              className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end"
            >
              {actions}
            </div>
          )}
          {metadata}
        </div>
      )}
    </header>
  );
}
