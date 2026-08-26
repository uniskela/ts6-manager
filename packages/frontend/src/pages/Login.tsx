import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/hooks/use-auth';
import { useAuthStore } from '@/stores/auth.store';
import { Loader2, AlertCircle } from 'lucide-react';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [checkingSetup, setCheckingSetup] = useState(true);
  const login = useLogin();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());

  useEffect(() => {
    if (isAuthenticated) {
      setCheckingSetup(false);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 20;

    const probe = () => {
      axios
        .get<{ needsSetup: boolean }>('/api/setup/status')
        .then((res) => {
          if (cancelled) return;
          if (res.data.needsSetup) navigate('/setup', { replace: true });
          else setCheckingSetup(false);
        })
        .catch(() => {
          if (cancelled) return;
          attempt += 1;
          // Retry briefly — nginx may be up before the backend finishes prisma/start.
          if (attempt < maxAttempts) {
            window.setTimeout(probe, 1500);
          } else {
            setCheckingSetup(false);
          }
        });
    };

    probe();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, navigate]);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  if (checkingSetup) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate({ username, password });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background grid-bg">
      {/* Ambient glow */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="w-full max-w-sm mx-4 relative">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 border border-primary/20 mb-4">
            <span className="text-primary font-bold text-xl font-mono-data text-glow">TS</span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">TeamSpeak 6 Manager</h1>
          <p className="text-sm text-muted-foreground mt-1">Server Administration Panel</p>
        </div>

        <Card className="border-border/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <h2 className="text-sm font-medium text-center text-muted-foreground">Sign in to continue</h2>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-xs">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-xs">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>

              {login.isError && (
                <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 rounded-md px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>Invalid credentials. Please try again.</span>
                </div>
              )}

              <Button type="submit" className="w-full" disabled={login.isPending || !username || !password}>
                {login.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign In'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-[10px] text-muted-foreground/50 mt-6 font-mono-data">
          TS6 WEBUI v1.0.0
        </p>
      </div>
    </div>
  );
}
