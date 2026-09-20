import { LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { ServerSelector } from './ServerSelector';
import { useAuthStore } from '@/stores/auth.store';
import { useLogout } from '@/hooks/use-auth';
import { MobileNavigation } from './Sidebar';

export function Header() {
  const { user } = useAuthStore();
  const logout = useLogout();

  return (
    <header className="grid min-h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 border-b border-border bg-card/50 px-2 py-2 backdrop-blur-sm sm:gap-3 sm:px-4 md:flex md:h-14 md:justify-between md:px-5 md:py-0 md:pt-0">
      <MobileNavigation />
      <ServerSelector />

      <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
        <ThemeToggle />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-10 gap-2 px-2 sm:h-8 sm:px-3" aria-label="Open account menu" title="Account menu">
              <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center">
                <User className="h-3 w-3 text-primary" />
              </div>
              <span className="hidden max-w-32 truncate text-xs sm:inline">{user?.displayName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{user?.displayName}</p>
              <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
