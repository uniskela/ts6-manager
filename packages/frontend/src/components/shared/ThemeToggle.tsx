import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/ui.store';

export function ThemeToggle() {
  const { theme, toggleTheme } = useUiStore();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className="h-10 w-10 sm:h-8 sm:w-8"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
