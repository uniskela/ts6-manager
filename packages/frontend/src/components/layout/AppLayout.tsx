import { useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useAuthStore } from '@/stores/auth.store';
import { useUiStore } from '@/stores/ui.store';
import { useResolvedBackgroundMotion } from '@/hooks/use-resolved-background-motion';
import { useCustomCssInjection } from '@/hooks/use-custom-css-injection';
import { authApi } from '@/api/auth.api';
import { Toaster } from 'sonner';

export function AppLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const setUser = useAuthStore((s) => s.setUser);
  const background = useUiStore((s) => s.background);
  const backgroundMotion = useUiStore((s) => s.backgroundMotion);
  const backgroundIntensity = useUiStore((s) => s.backgroundIntensity);
  const resolvedMotion = useResolvedBackgroundMotion(backgroundMotion);
  useCustomCssInjection(isAuthenticated);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  useEffect(() => {
    const user = me?.user ?? me;
    if (user?.id != null) {
      setUser({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      });
    }
  }, [me, setUser]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-viewport flex h-screen h-dvh min-w-0 overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main
          className="app-background-surface min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
          data-background={background}
          data-intensity={backgroundIntensity}
          data-motion-resolved={resolvedMotion}
        >
          <div className="fade-in min-w-0 p-3 sm:p-4 lg:p-5" style={{ paddingBottom: 'calc(var(--pwa-status-height, 0px) + max(1.25rem, env(safe-area-inset-bottom)))' }}>
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster
        position="top-right"
        mobileOffset={{ top: 'calc(3.5rem + env(safe-area-inset-top))', left: 12, right: 12 }}
        toastOptions={{
          className: 'bg-popover text-popover-foreground border-border max-w-[calc(100vw-1.5rem)]',
        }}
      />
    </div>
  );
}
