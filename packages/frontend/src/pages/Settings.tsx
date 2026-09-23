import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi } from '@/api/bots.api';
import { authApi } from '@/api/auth.api';
import { serversApi } from '@/api/servers.api';
import { settingsApi } from '@/api/settings.api';
import { useAuthStore } from '@/stores/auth.store';
import { ACCENTS, BASE_THEMES, useUiStore, type Accent, type BaseTheme } from '@/stores/ui.store';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConnectionSetupGuide } from '@/components/connections/ConnectionSetupGuide';
import { ConnectionSetupHelpDialog } from '@/components/connections/ConnectionSetupHelpDialog';
import { ConnectionSetupWizard } from '@/components/connections/ConnectionSetupWizard';
import { ConnectionFormDialog } from '@/components/connections/ConnectionFormDialog';
import {
  ConnectionDiagnosticStages,
  diagnosticToastMessage,
} from '@/components/connections/ConnectionDiagnosticStages';
import { DEFAULT_CONNECTION_FORM, type ConnectionFormState } from '@/content/connection-setup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { BrandMark } from '@/components/shared/BrandMark';
import { Settings as SettingsIcon, Users, Server, Plus, Trash2, Pencil, TestTube, Check, X, Lock, KeyRound, Youtube, Upload, FileText, Wand2, Info, Github, Palette, Loader2 } from 'lucide-react';
import { APP_REPOSITORY_URL, APP_VERSION, APP_VERSION_LABEL } from '@/lib/app-version';
import { apiErrorMessage } from '@/lib/api-error';
import { toast } from 'sonner';
import type { ConnectionDiagnosticReport } from '@ts6/common';

export default function Settings() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const availableTabs = isAdmin
    ? ['connections', 'account', 'appearance', 'users', 'youtube', 'about']
    : ['account', 'appearance', 'about'];
  const activeTab = tabParam && availableTabs.includes(tabParam) ? tabParam : 'account';

  const handleTabChange = (tab: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    if (tab !== 'connections') next.delete('wizard');
    setSearchParams(next);
  };

  return (
    <div className="min-w-0 space-y-5">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="min-w-0 max-w-full">
        <TabsList className="w-full sm:w-auto">
          {isAdmin && <TabsTrigger value="connections"><Server className="h-3.5 w-3.5 mr-1" /> Connections</TabsTrigger>}
          <TabsTrigger value="account"><Lock className="h-3.5 w-3.5 mr-1" /> Account</TabsTrigger>
          <TabsTrigger value="appearance"><Palette className="h-3.5 w-3.5 mr-1" /> Appearance</TabsTrigger>
          {isAdmin && <TabsTrigger value="users"><Users className="h-3.5 w-3.5 mr-1" /> Users</TabsTrigger>}
          {isAdmin && <TabsTrigger value="youtube"><Youtube className="h-3.5 w-3.5 mr-1" /> YouTube</TabsTrigger>}
          <TabsTrigger value="about"><Info className="h-3.5 w-3.5 mr-1" /> About</TabsTrigger>
        </TabsList>

        {isAdmin && (
          <TabsContent value="connections" className="mt-4">
            <ConnectionsTab />
          </TabsContent>
        )}

        <TabsContent value="account" className="mt-4">
          <AccountTab />
        </TabsContent>

        <TabsContent value="appearance" className="mt-4">
          <AppearanceTab />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="users" className="mt-4">
            <UsersTab />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="youtube" className="mt-4">
            <YouTubeTab />
          </TabsContent>
        )}

        <TabsContent value="about" className="mt-4">
          <AboutTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const BASE_THEME_LABELS: Record<BaseTheme, { label: string; description: string }> = {
  light: { label: 'Light', description: 'Bright neutral surfaces' },
  dark: { label: 'Dark', description: 'Low-glare dark surfaces' },
  black: { label: 'Black', description: 'True-black foundation' },
};

const ACCENT_LABELS: Record<Accent, string> = {
  cyan: 'Cyan',
  violet: 'Violet',
  red: 'Red',
  blue: 'Blue',
  emerald: 'Emerald',
  amber: 'Amber',
};

const ACCENT_SWATCHES: Record<Accent, string> = {
  cyan: 'hsl(186 72% 45%)',
  violet: 'hsl(267 80% 62%)',
  red: 'hsl(350 78% 56%)',
  blue: 'hsl(217 85% 58%)',
  emerald: 'hsl(160 68% 42%)',
  amber: 'hsl(35 92% 50%)',
};

function AppearanceTab() {
  const { baseTheme, accent, setBaseTheme, setAccent } = useUiStore();

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-base font-medium">
            <BrandMark className="h-8 w-8 text-primary" />
            Appearance
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Appearance is stored only in this browser. Operational status colours keep their meaning in every combination.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Base theme</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {BASE_THEMES.map(value => {
                const selected = value === baseTheme;
                const option = BASE_THEME_LABELS[value];
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`${option.label} base theme`}
                    aria-pressed={selected}
                    onClick={() => setBaseTheme(value)}
                    className={`min-w-0 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent'}`}
                  >
                    <span className="flex items-center justify-between gap-2 text-sm font-medium">
                      {option.label}
                      {selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Accent</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ACCENTS.map(value => {
                const selected = value === accent;
                const label = ACCENT_LABELS[value];
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`${label} accent`}
                    aria-pressed={selected}
                    onClick={() => setAccent(value)}
                    className={`flex min-w-0 items-center gap-2 rounded-md border p-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-accent'}`}
                  >
                    <span className="h-4 w-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: ACCENT_SWATCHES[value] }} aria-hidden="true" />
                    <span className="truncate">{label}</span>
                    {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="space-y-2">
            <p className="text-sm font-medium">Semantic colours</p>
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <span className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">Destructive / error</span>
              <span className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-success">Success</span>
              <span className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning">Warning</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AboutTab() {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base font-medium">
          <BrandMark className="h-8 w-8 text-primary" />
          TS6 Manager
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">Version</span>
          <Badge variant="secondary" className="font-mono-data">{APP_VERSION}</Badge>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Source</span>
          <a
            href={APP_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
          >
            <Github className="h-4 w-4" />
            GitHub Repository
          </a>
        </div>
        <p className="text-xs text-muted-foreground font-mono-data">{APP_VERSION_LABEL}</p>
      </CardContent>
    </Card>
  );
}

function AccountTab() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const changePassword = useMutation({
    mutationFn: () => authApi.changePassword(currentPassword, newPassword),
  });

  const handleSubmit = () => {
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters with upper, lower, and a digit');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    changePassword.mutate(undefined, {
      onSuccess: () => {
        toast.success('Password changed successfully');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      },
      onError: (err: any) => {
        const msg = err?.response?.data?.error || 'Failed to change password';
        toast.error(msg);
      },
    });
  };

  return (
    <div className="max-w-md">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Change Password</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">Current Password</Label>
            <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Enter current password" />
          </div>
          <div>
            <Label className="text-xs">New Password</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min. 8 characters, upper, lower, digit" />
          </div>
          <div>
            <Label className="text-xs">Confirm New Password</Label>
            <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!currentPassword || !newPassword || !confirmPassword || changePassword.isPending}
            className="w-full mt-1"
          >
            {changePassword.isPending ? 'Changing...' : 'Change Password'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionsTab() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: servers, isLoading } = useQuery({ queryKey: ['servers'], queryFn: serversApi.list });
  const createServer = useMutation({ mutationFn: (data: any) => serversApi.create(data), onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }) });
  const updateServer = useMutation({ mutationFn: ({ id, data }: any) => serversApi.update(id, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }) });
  const deleteServer = useMutation({ mutationFn: (id: number) => serversApi.delete(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }) });
  const testServer = useMutation({ mutationFn: (id: number) => serversApi.test(id) });
  const testSshServer = useMutation({ mutationFn: (id: number) => serversApi.testSsh(id) });

  const [showAdd, setShowAdd] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [webqueryTestPassed, setWebqueryTestPassed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [form, setForm] = useState<ConnectionFormState>(DEFAULT_CONNECTION_FORM);
  const [diagnosticByServer, setDiagnosticByServer] = useState<Record<number, ConnectionDiagnosticReport>>({});
  const [testingServerId, setTestingServerId] = useState<number | null>(null);

  const serverList = useMemo(() => (Array.isArray(servers) ? servers : []), [servers]);
  const hasSshOnAnyConnection = serverList.some((s: any) => s.hasSshCredentials);

  useEffect(() => {
    if (searchParams.get('wizard') !== '1' || isLoading) return;
    const next = new URLSearchParams(searchParams);
    next.delete('wizard');
    setSearchParams(next, { replace: true });
    if (serverList.length === 0) {
      setShowWizard(true);
    }
  }, [searchParams, setSearchParams, isLoading, serverList.length]);

  if (isLoading) return <PageLoader />;

  const resetForm = () => setForm(DEFAULT_CONNECTION_FORM);

  const handleSave = () => {
    const payload: Record<string, unknown> = {
      name: form.name,
      host: form.host,
      webqueryPort: parseInt(form.webqueryPort, 10),
      useHttps: form.useHttps,
      sshPort: parseInt(form.sshPort, 10),
    };
    if (form.apiKey) payload.apiKey = form.apiKey;
    if (form.sshUsername) payload.sshUsername = form.sshUsername;
    if (form.sshPassword) payload.sshPassword = form.sshPassword;

    if (editId) {
      updateServer.mutate({ id: editId, data: payload }, {
        onSuccess: () => { toast.success('Connection updated'); setEditId(null); setShowAdd(false); resetForm(); },
        onError: () => toast.error('Failed to update'),
      });
    } else {
      if (!form.apiKey) {
        toast.error('API key is required');
        return;
      }
      payload.apiKey = form.apiKey;
      createServer.mutate(payload, {
        onSuccess: () => { toast.success('Connection added'); setShowAdd(false); resetForm(); },
        onError: () => toast.error('Failed to create'),
      });
    }
  };

  const openEdit = (server: any) => {
    setForm({
      name: server.name || '',
      host: server.host || '',
      webqueryPort: String(server.webqueryPort || 10080),
      apiKey: '',
      useHttps: server.useHttps || false,
      sshPort: String(server.sshPort || 10022),
      sshUsername: '',
      sshPassword: '',
    });
    setEditId(server.id);
    setShowAdd(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setShowAdd(false);
      setEditId(null);
      resetForm();
    } else {
      setShowAdd(true);
    }
  };

  return (
    <div className="space-y-4">
      <ConnectionSetupGuide
        hasConnections={serverList.length > 0}
        hasSshOnAnyConnection={hasSshOnAnyConnection}
        webqueryTestPassed={webqueryTestPassed}
        onStartWizard={() => setShowWizard(true)}
      />

      {serverList.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Manage TeamSpeak server connections</p>
          <Button size="sm" onClick={() => { resetForm(); setEditId(null); setShowAdd(true); }}>
            <Plus className="h-4 w-4 mr-1" /> Add connection
          </Button>
        </div>
      )}

      {serverList.length === 0 ? (
        <EmptyState
          icon={Server}
          title="Connect your TeamSpeak server"
          description="The setup wizard walks you through WebQuery and optional SSH step by step."
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={() => setShowWizard(true)}>
              <Wand2 className="h-4 w-4 mr-1" /> Start setup wizard
            </Button>
            <Button variant="outline" size="sm" onClick={() => { resetForm(); setEditId(null); setShowAdd(true); }}>
              Add manually
            </Button>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setHelpOpen(true)}>
              Need help?
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {serverList.map((server: any) => (
            <Card key={server.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <CardTitle className="min-w-0 break-words text-sm font-medium">{server.name}</CardTitle>
                  <div className="flex flex-wrap items-center gap-1">
                    {server.isDemo ? (
                      <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">Demo data</Badge>
                    ) : (
                      <>
                        <Badge variant="outline" className="text-[10px]">WebQuery</Badge>
                        <Badge variant={server.hasSshCredentials ? 'default' : 'secondary'} className="text-[10px]">
                          {server.hasSshCredentials ? 'SSH configured' : 'SSH not configured'}
                        </Badge>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <span className="text-muted-foreground">{server.isDemo ? 'Source' : 'Host'}</span>
                  <span className={server.isDemo ? 'text-right' : 'break-all font-mono-data text-right'}>
                    {server.isDemo ? 'Synthetic local fixtures' : `${server.host}:${server.webqueryPort}`}
                  </span>
                  <span className="text-muted-foreground">Protocol</span>
                  <span>{server.isDemo ? 'Simulated' : (server.useHttps ? 'HTTPS' : 'HTTP')}</span>
                  <span className="text-muted-foreground">SSH</span>
                  <span className={server.isDemo ? '' : 'font-mono-data'}>{server.isDemo ? 'Not used' : (server.sshPort || '-')}</span>
                  <span className="text-muted-foreground">Status</span>
                  <span>
                    <Badge variant={server.enabled ? 'default' : 'secondary'} className="text-[10px]">
                      {server.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 pt-2">
                  {server.isDemo ? (
                    <span className="mr-auto text-[11px] text-muted-foreground">
                      No real TeamSpeak connection is used.
                    </span>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={testingServerId === server.id || testServer.isPending}
                        onClick={() => {
                          setTestingServerId(server.id);
                          testServer.mutate(server.id, {
                            onSuccess: (data: ConnectionDiagnosticReport) => {
                              setDiagnosticByServer((prev) => ({ ...prev, [server.id]: data }));
                              if (data?.success === true) {
                                setWebqueryTestPassed(true);
                                toast.success(diagnosticToastMessage(data));
                              } else if (data?.partial) {
                                toast.message(diagnosticToastMessage(data));
                              } else {
                                toast.error(diagnosticToastMessage(data));
                              }
                            },
                            onError: (err: any) => toast.error(apiErrorMessage(err, 'WebQuery test failed')),
                            onSettled: () => setTestingServerId((current) => (current === server.id ? null : current)),
                          });
                        }}
                      >
                        {testingServerId === server.id
                          ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          : <TestTube className="h-3 w-3 mr-1" />}
                        Test WebQuery
                      </Button>
                      {server.hasSshCredentials && (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => testSshServer.mutate(server.id, {
                          onSuccess: () => toast.success('SSH connection successful'),
                          onError: (err: any) => toast.error(apiErrorMessage(err, 'SSH test failed')),
                        })}>
                          <TestTube className="h-3 w-3 mr-1" /> Test SSH
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEdit(server)}>
                        <Pencil className="h-3 w-3 mr-1" /> Edit
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(server.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {(diagnosticByServer[server.id] || testingServerId === server.id) && (
                  <ConnectionDiagnosticStages
                    className="pt-1"
                    compact
                    pending={testingServerId === server.id}
                    report={diagnosticByServer[server.id]}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConnectionFormDialog
        open={showAdd}
        editId={editId}
        form={form}
        saving={createServer.isPending || updateServer.isPending}
        onOpenChange={handleDialogOpenChange}
        onChange={setForm}
        onSave={handleSave}
      />

      <ConnectionSetupWizard
        open={showWizard}
        onOpenChange={setShowWizard}
        onComplete={() => setWebqueryTestPassed(true)}
      />

      <ConnectionSetupHelpDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        hasConnections={serverList.length > 0}
        hasSshOnAnyConnection={hasSshOnAnyConnection}
        webqueryTestPassed={webqueryTestPassed}
        onStartWizard={() => { setHelpOpen(false); setShowWizard(true); }}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete Connection?"
        description="This will remove the server connection. Bots linked to this server will stop working."
        onConfirm={() => { if (deleteId) deleteServer.mutate(deleteId, { onSuccess: () => { toast.success('Connection deleted'); setDeleteId(null); } }); }}
        destructive
      />
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { data: users, isLoading } = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const createUser = useMutation({ mutationFn: (data: any) => usersApi.create(data), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const updateUser = useMutation({ mutationFn: ({ id, data }: { id: number; data: any }) => usersApi.update(id, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });
  const deleteUser = useMutation({ mutationFn: (id: number) => usersApi.delete(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }) });

  const [showAdd, setShowAdd] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'viewer' });

  const userList = useMemo(() => (Array.isArray(users) ? users : []), [users]);

  if (isLoading) return <PageLoader />;

  const handleCreate = () => {
    createUser.mutate(form, {
      onSuccess: () => { toast.success('User created'); setShowAdd(false); setForm({ username: '', password: '', displayName: '', role: 'viewer' }); },
      onError: () => toast.error('Failed to create user'),
    });
  };

  const handleRoleChange = (userId: number, role: string) => {
    updateUser.mutate({ id: userId, data: { role } }, {
      onSuccess: () => toast.success('Role updated'),
      onError: () => toast.error('Failed to update role'),
    });
  };

  const handleToggleEnabled = (userId: number, enabled: boolean) => {
    updateUser.mutate({ id: userId, data: { enabled } }, {
      onSuccess: () => toast.success(enabled ? 'User enabled' : 'User disabled'),
      onError: () => toast.error('Failed to update status'),
    });
  };

  const handleResetPassword = () => {
    if (!resetPwUserId || resetPwValue.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    updateUser.mutate({ id: resetPwUserId, data: { password: resetPwValue } }, {
      onSuccess: () => { toast.success('Password reset successfully'); setResetPwUserId(null); setResetPwValue(''); },
      onError: () => toast.error('Failed to reset password'),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Manage webapp users and roles</p>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-1" /> Add User</Button>
      </div>

      <div className="max-w-full overflow-x-auto rounded-md border border-border" tabIndex={0} role="region" aria-label="Scrollable users table">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">Username</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">Display Name</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">Role</th>
              <th className="h-10 px-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="h-10 px-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {userList.map((u: any) => {
              const isProtected = u.username === 'admin';
              return (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 font-mono-data text-xs">{u.username}</td>
                  <td className="px-3 py-2.5">{u.displayName}</td>
                  <td className="px-3 py-2.5">
                    {isProtected ? (
                      <Badge variant="default" className="text-[10px] capitalize">{u.role}</Badge>
                    ) : (
                      <Select value={u.role} onValueChange={(v) => handleRoleChange(u.id, v)}>
                        <SelectTrigger className="h-7 w-[110px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {isProtected ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                        <Check className="h-3 w-3" /> Active
                      </span>
                    ) : (
                      <Switch
                        checked={u.enabled}
                        onCheckedChange={(v) => handleToggleEnabled(u.id, v)}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="inline-flex items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Reset Password" onClick={() => { setResetPwUserId(u.id); setResetPwValue(''); }}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteId(u.id)} disabled={isProtected}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add User Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Username</Label><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="johndoe" /></div>
            <div><Label className="text-xs">Display Name</Label><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="John Doe" /></div>
            <div><Label className="text-xs">Password</Label><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="********" /></div>
            <div>
              <Label className="text-xs">Role</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!form.username || !form.password}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetPwUserId !== null} onOpenChange={(v) => { if (!v) { setResetPwUserId(null); setResetPwValue(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Reset Password</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Set a new password for <span className="font-medium text-foreground">{userList.find((u: any) => u.id === resetPwUserId)?.username}</span>
            </p>
            <div>
              <Label className="text-xs">New Password</Label>
              <Input type="password" value={resetPwValue} onChange={(e) => setResetPwValue(e.target.value)} placeholder="Min. 8 characters, upper, lower, digit" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResetPwUserId(null); setResetPwValue(''); }}>Cancel</Button>
            <Button onClick={handleResetPassword} disabled={resetPwValue.length < 6 || updateUser.isPending}>
              {updateUser.isPending ? 'Resetting...' : 'Reset Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={() => setDeleteId(null)}
        title="Delete User?"
        description="This user will be permanently deleted."
        onConfirm={() => { if (deleteId) deleteUser.mutate(deleteId, { onSuccess: () => { toast.success('User deleted'); setDeleteId(null); } }); }}
        destructive
      />
    </div>
  );
}

function YouTubeTab() {
  const qc = useQueryClient();
  const [pasteMode, setPasteMode] = useState(false);
  const [cookieText, setCookieText] = useState('');

  const { data: status, isLoading } = useQuery({
    queryKey: ['yt-cookie-status'],
    queryFn: settingsApi.getYtCookieStatus,
  });

  const uploadFile = useMutation({
    mutationFn: (file: File) => settingsApi.uploadYtCookieFile(file),
    onSuccess: () => {
      toast.success('Cookie file uploaded');
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error('Failed to upload cookie file'),
  });

  const uploadText = useMutation({
    mutationFn: (text: string) => settingsApi.uploadYtCookieText(text),
    onSuccess: () => {
      toast.success('Cookies saved');
      setCookieText('');
      setPasteMode(false);
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error('Failed to save cookies'),
  });

  const deleteCookies = useMutation({
    mutationFn: () => settingsApi.deleteYtCookies(),
    onSuccess: () => {
      toast.success('Cookie file removed');
      qc.invalidateQueries({ queryKey: ['yt-cookie-status'] });
    },
    onError: () => toast.error('Failed to remove cookies'),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile.mutate(file);
    e.target.value = '';
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">YouTube Cookies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Upload a cookies.txt file to access age-restricted or member-only YouTube content.
            You can export cookies from your browser using extensions like
            {' '}<span className="font-medium">Get cookies.txt LOCALLY</span> (Chrome/Firefox).
          </p>

          {/* Status */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.active ? 'bg-green-500' : 'bg-zinc-500'}`} />
            <span className="text-sm">
              {isLoading ? 'Loading...' : status?.active
                ? `Cookies active (${formatSize(status.size)})`
                : 'No cookies configured'}
            </span>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            <input
              type="file"
              accept=".txt,.cookies"
              className="hidden"
              id="cookie-file-input"
              onChange={handleFileSelect}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => document.getElementById('cookie-file-input')?.click()}
              disabled={uploadFile.isPending}
            >
              <Upload className="h-3.5 w-3.5 mr-1" />
              {uploadFile.isPending ? 'Uploading...' : 'Upload cookies.txt'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPasteMode(!pasteMode)}
            >
              <FileText className="h-3.5 w-3.5 mr-1" />
              Paste cookies
            </Button>
            {status?.active && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => deleteCookies.mutate()}
                disabled={deleteCookies.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Remove
              </Button>
            )}
          </div>

          {/* Paste mode */}
          {pasteMode && (
            <div className="space-y-2">
              <textarea
                className="w-full h-32 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;0&#9;COOKIE_NAME&#9;COOKIE_VALUE"
                value={cookieText}
                onChange={(e) => setCookieText(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => uploadText.mutate(cookieText)}
                  disabled={!cookieText.trim() || uploadText.isPending}
                >
                  {uploadText.isPending ? 'Saving...' : 'Save'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { setPasteMode(false); setCookieText(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <LimitsCard />
    </div>
  );
}

function LimitsCard() {
  const qc = useQueryClient();
  const { data: limits, isLoading } = useQuery({
    queryKey: ['settings-limits'],
    queryFn: settingsApi.getLimits,
  });
  const [maxVideoDuration, setMaxVideoDuration] = useState('');
  const [maxPlaylistImport, setMaxPlaylistImport] = useState('');

  useEffect(() => {
    if (limits) {
      setMaxVideoDuration(String(limits.maxVideoDuration ?? 900));
      setMaxPlaylistImport(String(limits.maxPlaylistImport ?? 250));
    }
  }, [limits]);

  const saveLimits = useMutation({
    mutationFn: () => settingsApi.updateLimits({
      maxVideoDuration: parseInt(maxVideoDuration, 10),
      maxPlaylistImport: parseInt(maxPlaylistImport, 10),
    }),
    onSuccess: () => {
      toast.success('Limits saved');
      qc.invalidateQueries({ queryKey: ['settings-limits'] });
    },
    onError: () => toast.error('Failed to save limits'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Download &amp; Stream Limits</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Cap YouTube and Apple Music playlist imports (stream register or download). For large
          playlists (e.g. 250+ tracks), raise the import cap below (max 500).
        </p>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : (
          <>
            <div>
              <Label className="text-xs">Max video duration (seconds, 0 = unlimited)</Label>
              <Input
                type="number"
                min={0}
                value={maxVideoDuration}
                onChange={(e) => setMaxVideoDuration(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Max playlist import tracks (1–500)</Label>
              <Input
                type="number"
                min={1}
                max={500}
                value={maxPlaylistImport}
                onChange={(e) => setMaxPlaylistImport(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              onClick={() => saveLimits.mutate()}
              disabled={saveLimits.isPending}
            >
              {saveLimits.isPending ? 'Saving...' : 'Save Limits'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
