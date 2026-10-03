import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/** Shortcut from a console source tab to the page that manages its media. */
export function AddMediaLink({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="outline" className="min-h-11 shrink-0">
      <Link to={to}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> {label}
      </Link>
    </Button>
  );
}
