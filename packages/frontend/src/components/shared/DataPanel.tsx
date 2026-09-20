import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface DataPanelProps {
  title: string;
  description?: string;
  status?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/** A restrained section container for dense operational data. */
export function DataPanel({
  title,
  description,
  status,
  action,
  children,
  className,
  contentClassName,
}: DataPanelProps) {
  return (
    <Card className={cn('min-w-0 overflow-hidden', className)}>
      <CardHeader className="gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold leading-none tracking-tight">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {(status || action) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {status}
            {action}
          </div>
        )}
      </CardHeader>
      <CardContent className={cn('min-w-0', contentClassName)}>{children}</CardContent>
    </Card>
  );
}
