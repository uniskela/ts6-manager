import { useEffect } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { useAuthStore } from '@/stores/auth.store';
import { authApi } from '@/api/auth.api';
import { Toaster } from 'sonner';

export function AppLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  const setUser = useAuthStore((s) => s.setUser);

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (me) {
      setUser({
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        role: me.role,
      });
    }
  }, [me, setUser]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto grid-bg">
          <div className="p-5 fade-in">
            <Outlet />
          </div>
        </main>
      </div>
      <Toaster
        position="top-right"
        toastOptions={{
          className: 'bg-popover text-popover-foreground border-border',
        }}
      />
    </div>
  );
}
