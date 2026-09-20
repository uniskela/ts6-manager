import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { permissionsApi } from '@/api/permissions.api';
import { useServerStore } from '@/stores/server.store';
import { useUiStore } from '@/stores/ui.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { cn } from '@/lib/utils';
import {
  Lock, Search, ChevronRight, ChevronDown, Shield, Users, Hash, User, Save,
  X, Check, Minus, Columns3, AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';

// Permission categories based on TS3 naming convention
const PERM_CATEGORIES: Record<string, string> = {
  b_virtualserver: 'Virtual Server',
  b_serverinstance: 'Server Instance',
  b_serverquery: 'Server Query',
  b_channel: 'Channel',
  b_client: 'Client',
  b_group: 'Group',
  b_ft: 'File Transfer',
  i_channel: 'Channel (Values)',
  i_group: 'Group (Values)',
  i_client: 'Client (Values)',
  i_ft: 'File Transfer (Values)',
  i_max: 'Limits',
  i_needed: 'Needed Powers',
};

function getCategoryKey(permsid: string): string {
  // Match longest prefix first
  const prefixes = Object.keys(PERM_CATEGORIES).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (permsid.startsWith(prefix)) return prefix;
  }
  return 'other';
}

function getSimplePermissionLabel(permission: PermDef): string {
  const description = permission.permdesc.trim();
  if (description.length >= 3 && description.toLowerCase() !== permission.permsid.toLowerCase()) {
    return description;
  }
  const readable = permission.permsid.replace(/^[bi]_/, '').replace(/_/g, ' ').trim();
  return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : permission.permsid;
}

type PermLayer = 'server-group' | 'channel-group' | 'channel' | 'client';

interface PermDef {
  permid: number;
  permsid: string;
  permdesc: string;
}

interface PermValue {
  permsid: string;
  permvalue: number;
  permnegated: number;
  permskip: number;
}

interface PendingChange {
  permsid: string;
  permvalue: number;
  permnegated: number;
  permskip: number;
  action: 'set' | 'remove';
}

interface DraftOwner {
  configId: number;
  sid: number;
  layer: PermLayer;
  entityId: number;
}

interface PermissionDraft {
  owner: DraftOwner;
  changes: Map<string, PendingChange>;
}

interface PendingTransition {
  description: string;
  apply: () => void;
}

interface SaveSnapshot {
  owner: DraftOwner;
  mutations: PendingChange[];
}

class PermissionSaveError extends Error {
  constructor(
    readonly snapshot: SaveSnapshot,
    readonly completed: PendingChange[],
    readonly cause: unknown,
  ) {
    super('Permission save stopped after a sequential write failed');
  }
}

const EMPTY_CHANGES = new Map<string, PendingChange>();

function sameContext(left: DraftOwner, right: DraftOwner): boolean {
  return left.configId === right.configId
    && left.sid === right.sid
    && left.layer === right.layer
    && left.entityId === right.entityId;
}

function sameChange(left: PendingChange, right: PendingChange): boolean {
  return left.permsid === right.permsid
    && left.permvalue === right.permvalue
    && left.permnegated === right.permnegated
    && left.permskip === right.permskip
    && left.action === right.action;
}

async function writePermissionChange(owner: DraftOwner, change: PendingChange) {
  const setData = {
    permsid: change.permsid,
    permvalue: change.permvalue,
    permnegated: change.permnegated,
    permskip: change.permskip,
  };
  const removeData = { permsid: change.permsid };
  if (change.action === 'set') {
    switch (owner.layer) {
      case 'server-group': return permissionsApi.addServerGroupPerm(owner.configId, owner.sid, owner.entityId, setData);
      case 'channel-group': return permissionsApi.addChannelGroupPerm(owner.configId, owner.sid, owner.entityId, setData);
      case 'channel': return permissionsApi.addChannelPerm(owner.configId, owner.sid, owner.entityId, setData);
      case 'client': return permissionsApi.addClientPerm(owner.configId, owner.sid, owner.entityId, setData);
    }
  }
  switch (owner.layer) {
    case 'server-group': return permissionsApi.delServerGroupPerm(owner.configId, owner.sid, owner.entityId, removeData);
    case 'channel-group': return permissionsApi.delChannelGroupPerm(owner.configId, owner.sid, owner.entityId, removeData);
    case 'channel': return permissionsApi.delChannelPerm(owner.configId, owner.sid, owner.entityId, removeData);
    case 'client': return permissionsApi.delClientPerm(owner.configId, owner.sid, owner.entityId, removeData);
  }
}

function readEntityPermissions(owner: DraftOwner) {
  switch (owner.layer) {
    case 'server-group': return permissionsApi.serverGroupPerms(owner.configId, owner.sid, owner.entityId);
    case 'channel-group': return permissionsApi.channelGroupPerms(owner.configId, owner.sid, owner.entityId);
    case 'channel': return permissionsApi.channelPerms(owner.configId, owner.sid, owner.entityId);
    case 'client': return permissionsApi.clientPerms(owner.configId, owner.sid, owner.entityId);
  }
}

function normalizePermissionValues(values: unknown, permIdToName: Map<number, string>): Map<string, PermValue> {
  const normalized = new Map<string, PermValue>();
  if (!Array.isArray(values)) return normalized;
  for (const value of values) {
    const name = value.permsid || value.permname || permIdToName.get(Number(value.permid)) || `permid_${value.permid}`;
    normalized.set(name, {
      permsid: name,
      permvalue: Number(value.permvalue) || 0,
      permnegated: Number(value.permnegated) || 0,
      permskip: Number(value.permskip) || 0,
    });
  }
  return normalized;
}

const LAYERS: { key: PermLayer; label: string; icon: React.ElementType }[] = [
  { key: 'server-group', label: 'Server Groups', icon: Shield },
  { key: 'channel-group', label: 'Channel Groups', icon: Users },
  { key: 'channel', label: 'Channel', icon: Hash },
  { key: 'client', label: 'Client', icon: User },
];

interface CompareColumn {
  id: number;
  name: string;
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  errorStatus?: number;
}

function describePermissionValue(value: PermValue | undefined): string {
  if (!value) return 'Unset';
  const parts = [`Value ${value.permvalue}`];
  if (value.permskip) parts.push('Skip');
  if (value.permnegated) parts.push('Negate');
  return parts.join(', ');
}

function PermissionCompare({
  permissions,
  columns,
  labelMode,
}: {
  permissions: PermDef[];
  columns: CompareColumn[];
  labelMode: 'simple' | 'technical';
}) {
  const [search, setSearch] = useState('');
  const [setOnAny, setSetOnAny] = useState(false);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const permIdToName = useMemo(() => new Map(permissions.map(permission => [permission.permid, permission.permsid])), [permissions]);
  const normalizedColumns = useMemo(() => columns.map(column => ({
    ...column,
    permissions: normalizePermissionValues(column.data, permIdToName),
  })), [columns, permIdToName]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return permissions.filter((permission) => {
      if (needle && !permission.permsid.toLowerCase().includes(needle) && !permission.permdesc.toLowerCase().includes(needle)) return false;
      const successful = normalizedColumns.filter(column => !column.isError && !column.isLoading);
      const values = successful.map(column => column.permissions.get(permission.permsid));
      if (setOnAny && !values.some(Boolean)) return false;
      if (differencesOnly) {
        const states = new Set(values.map(value => value
          ? `${value.permvalue}:${value.permskip}:${value.permnegated}`
          : 'unset'));
        if (states.size < 2) return false;
      }
      return true;
    });
  }, [differencesOnly, normalizedColumns, permissions, search, setOnAny]);

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={setOnAny} onChange={event => setSetOnAny(event.target.checked)} />
          Set on any
        </label>
        <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={differencesOnly} onChange={event => setDifferencesOnly(event.target.checked)} />
          Differences only
        </label>
        <div className="relative min-w-0 flex-1 sm:min-w-64">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search compared permissions..."
            className="h-9 pl-7 text-xs"
          />
        </div>
      </div>
      <div data-testid="permissions-compare" className="max-w-full overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs" style={{ minWidth: `${Math.max(720, 260 + columns.length * 180)}px` }}>
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className="sticky left-0 z-10 w-64 border-b border-r border-border bg-muted px-3 py-2">Permission</th>
              {normalizedColumns.map(column => (
                <th key={column.id} scope="col" className="min-w-44 border-b border-border px-3 py-2 align-top">
                  <span className="block font-semibold text-foreground">{column.name}</span>
                  <span className="font-mono-data text-[10px] text-muted-foreground">#{column.id}</span>
                  {column.isError && (
                    <span className="mt-1 flex items-center gap-1 text-destructive" role="status">
                      <AlertTriangle className="h-3 w-3" />
                      {column.errorStatus === 429 ? 'Query cooldown active' : 'Failed to load'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(permission => (
              <tr key={permission.permsid} className="border-b border-border/60 last:border-b-0">
                <th scope="row" className="sticky left-0 z-[1] border-r border-border bg-card px-3 py-2 font-normal">
                  {labelMode === 'simple' ? (
                    <>
                      <span className="block font-medium text-foreground">{getSimplePermissionLabel(permission)}</span>
                      <span className="block font-mono-data text-[10px] text-muted-foreground">{permission.permsid}</span>
                    </>
                  ) : (
                    <span className="font-mono-data text-foreground">{permission.permsid}</span>
                  )}
                </th>
                {normalizedColumns.map(column => {
                  const value = column.permissions.get(permission.permsid);
                  const failureDescription = column.errorStatus === 429 ? 'Query cooldown active' : 'Failed to load';
                  const description = column.isError ? failureDescription : column.isLoading ? 'Loading' : describePermissionValue(value);
                  return (
                    <td key={column.id} aria-label={`${column.name}: ${description}`} className="px-3 py-2 align-top">
                      {column.isError ? (
                        <span className="font-medium text-destructive">{failureDescription}</span>
                      ) : column.isLoading ? (
                        <span className="text-muted-foreground">Loading…</span>
                      ) : !value ? (
                        <Badge variant="outline">Unset</Badge>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono-data font-medium">{value.permvalue}</span>
                          {!!value.permskip && <Badge variant="secondary">Skip</Badge>}
                          {!!value.permnegated && <Badge variant="destructive">Negate</Badge>}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">No permissions match the Compare filters</p>
        )}
      </div>
    </div>
  );
}

export default function Permissions() {
  const { selectedConfigId: c, selectedSid: s, setServer } = useServerStore();
  const { permissionLabelMode, setPermissionLabelMode } = useUiStore();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [layer, setLayer] = useState<PermLayer>('server-group');
  const [entityId, setEntityId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<PermissionDraft | null>(null);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null);
  const [compareSelection, setCompareSelection] = useState<number[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const acceptedServerContext = useRef<{ configId: number; sid: number } | null>(null);
  const saveLock = useRef(false);

  const editorContext = useMemo<DraftOwner | null>(() => (
    c && s && entityId ? { configId: c, sid: s, layer, entityId } : null
  ), [c, s, layer, entityId]);
  const changes = draft && editorContext && sameContext(draft.owner, editorContext)
    ? draft.changes
    : EMPTY_CHANGES;
  const isDirty = !!draft?.changes.size;
  const resetCompare = useCallback(() => {
    setCompareSelection([]);
    setShowCompare(false);
  }, []);

  useEffect(() => {
    if (!c || !s) return;
    const requested = { configId: c, sid: s };
    const accepted = acceptedServerContext.current;
    if (!accepted) {
      acceptedServerContext.current = requested;
      return;
    }
    if (accepted.configId === requested.configId && accepted.sid === requested.sid) return;

    if (isDirty && draft) {
      setServer(draft.owner.configId, draft.owner.sid);
      setPendingTransition({
        description: 'Discard the draft before switching the TeamSpeak connection or virtual server?',
        apply: () => {
          acceptedServerContext.current = requested;
          setEntityId(null);
          resetCompare();
          setServer(requested.configId, requested.sid);
        },
      });
      return;
    }

    acceptedServerContext.current = requested;
    setEntityId(null);
    resetCompare();
  }, [c, s, draft, isDirty, resetCompare, setServer]);

  useEffect(() => {
    if (!isDirty) return;

    const protectInAppNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute('download')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      const destinationPath = `${destination.pathname}${destination.search}${destination.hash}`;
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (destinationPath === currentPath) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingTransition({
        description: 'Discard the draft before leaving Permissions?',
        apply: () => navigate(destinationPath),
      });
    };

    document.addEventListener('click', protectInAppNavigation, true);
    return () => document.removeEventListener('click', protectInAppNavigation, true);
  }, [isDirty, navigate]);

  useEffect(() => {
    if (!isDirty) return;

    const protectUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', protectUnload);
    return () => {
      window.removeEventListener('beforeunload', protectUnload);
    };
  }, [isDirty]);

  // Fetch all permission definitions
  const { data: permDefs, isLoading: loadingDefs } = useQuery({
    queryKey: ['perm-defs', c, s],
    queryFn: () => permissionsApi.list(c!, s!),
    enabled: !!c && !!s,
  });

  // Fetch entity lists for selectors
  const { data: serverGroups } = useQuery({
    queryKey: ['server-groups', c, s],
    queryFn: () => permissionsApi.serverGroups(c!, s!),
    enabled: !!c && !!s && layer === 'server-group',
  });
  const { data: channelGroups } = useQuery({
    queryKey: ['channel-groups', c, s],
    queryFn: () => permissionsApi.channelGroups(c!, s!),
    enabled: !!c && !!s && layer === 'channel-group',
  });
  const { data: channels } = useQuery({
    queryKey: ['channels-for-perms', c, s],
    queryFn: () => permissionsApi.channels(c!, s!),
    enabled: !!c && !!s && layer === 'channel',
  });
  const { data: clients } = useQuery({
    queryKey: ['clients-for-perms', c, s],
    queryFn: () => permissionsApi.clients(c!, s!),
    enabled: !!c && !!s && layer === 'client',
  });
  const { data: dbClients } = useQuery({
    queryKey: ['db-clients-for-perms', c, s],
    queryFn: () => permissionsApi.clientDatabase(c!, s!),
    enabled: !!c && !!s && layer === 'client',
  });

  const [showSetOnly, setShowSetOnly] = useState(false);
  const [clientSearch, setClientSearch] = useState('');

  // Fetch current entity permissions
  const { data: entityPerms, isLoading: loadingPerms } = useQuery({
    queryKey: ['entity-perms', c, s, layer, entityId],
    queryFn: () => editorContext ? readEntityPermissions(editorContext) : [],
    enabled: !!c && !!s && !!entityId,
  });

  // Parse permission definitions into categorized structure
  // TS WebQuery returns { permid, permname, permdesc } — NOT permsid
  const allPerms: PermDef[] = useMemo(() => {
    if (!permDefs || !Array.isArray(permDefs)) return [];
    return permDefs.map((p: any) => ({
      permid: Number(p.permid),
      permsid: p.permname || p.permsid || `permid_${p.permid}`,
      permdesc: p.permdesc || '',
    }));
  }, [permDefs]);

  // Build permid → permname lookup (entity perms only return numeric permid)
  const permIdToName = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of allPerms) {
      map.set(p.permid, p.permsid);
    }
    return map;
  }, [allPerms]);

  const compareResults = useQueries({
    queries: compareSelection.map((selectedEntityId) => ({
      queryKey: ['entity-perms', c, s, layer, selectedEntityId],
      queryFn: () => readEntityPermissions({
        configId: c!,
        sid: s!,
        layer,
        entityId: selectedEntityId,
      }),
      enabled: showCompare && compareSelection.length >= 2 && !!c && !!s,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchInterval: false as const,
      retry: (failureCount: number, error: any) => error?.response?.status !== 429 && failureCount < 1,
      retryDelay: (attempt: number) => Math.min(1500, 300 * 2 ** attempt),
    })),
  });

  // Current perm values as map (keyed by permname/permsid)
  const currentPerms = useMemo(
    () => normalizePermissionValues(entityPerms, permIdToName),
    [entityPerms, permIdToName],
  );

  // Categorize permissions
  const categories = useMemo(() => {
    const catMap = new Map<string, PermDef[]>();
    let filtered = search
      ? allPerms.filter((p) => p.permsid.toLowerCase().includes(search.toLowerCase()) || p.permdesc.toLowerCase().includes(search.toLowerCase()))
      : allPerms;

    if (showSetOnly) {
      filtered = filtered.filter((p) => currentPerms.has(p.permsid) || changes.has(p.permsid));
    }

    for (const perm of filtered) {
      const cat = getCategoryKey(perm.permsid);
      if (!catMap.has(cat)) catMap.set(cat, []);
      catMap.get(cat)!.push(perm);
    }
    return catMap;
  }, [allPerms, search, showSetOnly, currentPerms, changes]);

  const toggleCat = useCallback((cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const getEffectiveValue = useCallback((permsid: string): PendingChange | null => {
    if (changes.has(permsid)) return changes.get(permsid)!;
    const current = currentPerms.get(permsid);
    if (current) return { ...current, action: 'set' };
    return null;
  }, [changes, currentPerms]);

  const setPermValue = useCallback((permsid: string, value: number, negated: number, skip: number) => {
    if (!editorContext) return;
    setDraft((prev) => {
      const next = new Map(prev && sameContext(prev.owner, editorContext) ? prev.changes : EMPTY_CHANGES);
      next.set(permsid, { permsid, permvalue: value, permnegated: negated, permskip: skip, action: 'set' });
      return { owner: editorContext, changes: next };
    });
  }, [editorContext]);

  const removePerm = useCallback((permsid: string) => {
    if (!editorContext) return;
    setDraft((prev) => {
      const next = new Map(prev && sameContext(prev.owner, editorContext) ? prev.changes : EMPTY_CHANGES);
      if (currentPerms.has(permsid)) {
        next.set(permsid, { permsid, permvalue: 0, permnegated: 0, permskip: 0, action: 'remove' });
      } else {
        next.delete(permsid);
      }
      return next.size > 0 ? { owner: editorContext, changes: next } : null;
    });
  }, [currentPerms, editorContext]);

  const requestTransition = useCallback((description: string, apply: () => void) => {
    if (isDirty) {
      setPendingTransition({ description, apply });
      return;
    }
    apply();
  }, [isDirty]);

  const changeLayer = useCallback((nextLayer: PermLayer) => {
    if (nextLayer === layer) return;
    requestTransition(`Discard the draft before switching to ${LAYERS.find((item) => item.key === nextLayer)?.label}?`, () => {
      setLayer(nextLayer);
      setEntityId(null);
      resetCompare();
    });
  }, [layer, requestTransition, resetCompare]);

  const changeEntity = useCallback((nextEntityId: number, name: string) => {
    if (nextEntityId === entityId) return;
    requestTransition(`Discard the draft before editing ${name}?`, () => setEntityId(nextEntityId));
  }, [entityId, requestTransition]);

  const toggleCompareEntity = useCallback((selectedEntityId: number) => {
    setCompareSelection((current) => {
      if (current.includes(selectedEntityId)) {
        const next = current.filter(id => id !== selectedEntityId);
        if (next.length < 2) setShowCompare(false);
        return next;
      }
      if (current.length >= 4) {
        toast.warning('Compare is limited to 4 entities');
        return current;
      }
      return [...current, selectedEntityId];
    });
  }, []);

  const clearCompletedChanges = useCallback((snapshot: SaveSnapshot, completed: PendingChange[]) => {
    setDraft((current) => {
      if (!current || !sameContext(current.owner, snapshot.owner)) return current;
      const next = new Map(current.changes);
      for (const saved of completed) {
        const live = next.get(saved.permsid);
        if (live && sameChange(live, saved)) next.delete(saved.permsid);
      }
      return next.size > 0 ? { owner: current.owner, changes: next } : null;
    });
  }, []);

  const invalidateSavedContext = useCallback((owner: DraftOwner) => (
    qc.invalidateQueries({ queryKey: ['entity-perms', owner.configId, owner.sid, owner.layer, owner.entityId] })
  ), [qc]);

  const saveMutation = useMutation({
    mutationFn: async (snapshot: SaveSnapshot) => {
      const completed: PendingChange[] = [];
      for (const mutation of snapshot.mutations) {
        try {
          await writePermissionChange(snapshot.owner, mutation);
          completed.push(mutation);
        } catch (error) {
          throw new PermissionSaveError(snapshot, completed, error);
        }
      }
      return { snapshot, completed };
    },
    onSuccess: ({ snapshot, completed }) => {
      clearCompletedChanges(snapshot, completed);
      void invalidateSavedContext(snapshot.owner);
      toast.success('Permissions saved to the original draft context');
    },
    onError: (error) => {
      if (!(error instanceof PermissionSaveError)) {
        toast.error('Permission save failed. The draft was retained.');
        return;
      }
      clearCompletedChanges(error.snapshot, error.completed);
      void invalidateSavedContext(error.snapshot.owner);
      const remaining = error.snapshot.mutations.length - error.completed.length;
      if (error.completed.length === 0) {
        toast.error(`No permission changes were saved. ${remaining} ${remaining === 1 ? 'change remains' : 'changes remain'}.`);
      } else {
        toast.error(`${error.completed.length} of ${error.snapshot.mutations.length} permission changes saved. ${remaining} ${remaining === 1 ? 'change remains' : 'changes remain'}.`);
      }
    },
    onSettled: () => { saveLock.current = false; },
  });

  const saveDraft = useCallback(() => {
    if (saveLock.current || !draft || draft.changes.size === 0) return;
    saveLock.current = true;
    saveMutation.mutate({
      owner: { ...draft.owner },
      mutations: [...draft.changes.values()].map((change) => ({ ...change })),
    });
  }, [draft, saveMutation]);

  if (!c || !s) return <EmptyState icon={Lock} title="No server selected" />;
  if (loadingDefs) return <PageLoader />;

  const entities = (() => {
    switch (layer) {
      case 'server-group':
        return (Array.isArray(serverGroups) ? serverGroups : []).map((g: any) => ({
          id: Number(g.sgid), name: g.name, type: Number(g.type),
        }));
      case 'channel-group':
        return (Array.isArray(channelGroups) ? channelGroups : []).map((g: any) => ({
          id: Number(g.cgid), name: g.name, type: Number(g.type),
        }));
      case 'channel':
        return (Array.isArray(channels) ? channels : []).map((ch: any) => ({
          id: Number(ch.cid), name: ch.channel_name, type: 0,
        }));
      case 'client': {
        const online = (Array.isArray(clients) ? clients : [])
          .filter((cl: any) => String(cl.client_type) === '0')
          .map((cl: any) => ({
            id: Number(cl.client_database_id), name: cl.client_nickname, type: 0, online: true,
          }));
        const onlineIds = new Set(online.map((o) => o.id));
        const offline = (Array.isArray(dbClients) ? dbClients : [])
          .map((cl: any) => ({
            id: Number(cl.cldbid || cl.client_database_id),
            name: cl.client_nickname || `DBID ${cl.cldbid || cl.client_database_id}`,
            type: 0,
            online: false,
          }))
          .filter((cl: any) => cl.id && !onlineIds.has(cl.id));
        const merged = [...online, ...offline];
        if (!clientSearch.trim()) return merged;
        const q = clientSearch.toLowerCase();
        return merged.filter((cl) => cl.name.toLowerCase().includes(q) || String(cl.id).includes(q));
      }
      default: return [];
    }
  })();
  const compareColumns: CompareColumn[] = compareSelection.map((selectedEntityId, index) => ({
    id: selectedEntityId,
    name: entities.find(entity => entity.id === selectedEntityId)?.name || `Entity ${selectedEntityId}`,
    data: compareResults[index]?.data,
    isLoading: compareResults[index]?.isLoading ?? false,
    isError: compareResults[index]?.isError ?? false,
    errorStatus: (compareResults[index]?.error as any)?.response?.status,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">Permissions</h1>
          <Button
            variant={showCompare ? 'default' : 'outline'}
            size="sm"
            className="min-h-10 sm:min-h-8"
            disabled={compareSelection.length < 2}
            aria-label={`Compare ${compareSelection.length} selected entities`}
            onClick={() => setShowCompare(true)}
          >
            <Columns3 className="mr-1 h-3.5 w-3.5" /> Compare ({compareSelection.length})
          </Button>
          {showCompare && (
            <Button variant="ghost" size="sm" className="min-h-10 sm:min-h-8" onClick={() => setShowCompare(false)}>
              Return to editor
            </Button>
          )}
        </div>
        {isDirty && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-mono-data" role="status">
              {changes.size} unsaved {changes.size === 1 ? 'change' : 'changes'}
            </Badge>
            <Button variant="outline" size="sm" className="min-h-10 sm:min-h-8" onClick={() => setDraft(null)}>
              <X className="h-3.5 w-3.5 mr-1" /> Discard
            </Button>
            <Button size="sm" className="min-h-10 sm:min-h-8" onClick={saveDraft} disabled={saveMutation.isPending}>
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </Button>
          </div>
        )}
      </div>

      {/* Layer Tabs */}
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/30 p-1">
        {LAYERS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => changeLayer(key)}
            aria-pressed={layer === key}
            className={cn(
              'flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors md:min-h-8',
              layer === key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Entity Selector */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Select {LAYERS.find((l) => l.key === layer)?.label.replace(/s$/, '')}
            </CardTitle>
            {layer === 'client' && (
              <Input
                placeholder="Search online/offline clients..."
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="h-8 text-xs mt-2"
              />
            )}
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[min(20rem,40dvh)] lg:h-[500px]">
              <div className="p-2 space-y-0.5">
                {entities.map((ent: any) => (
                  <div
                    key={ent.id}
                    className={cn(
                      'flex min-w-0 items-stretch gap-1 rounded-md border p-0.5 transition-colors',
                      entityId === ent.id ? 'border-primary/50 bg-primary/10' : 'border-transparent hover:bg-muted/50',
                    )}
                  >
                    <button
                      onClick={() => changeEntity(ent.id, ent.name)}
                      aria-current={entityId === ent.id ? 'true' : undefined}
                      className={cn(
                        'flex min-h-10 min-w-0 flex-1 items-center gap-1 rounded px-2 text-left text-sm',
                        entityId === ent.id ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{ent.name}</span>
                      {entityId === ent.id && <Badge variant="secondary" className="h-5 text-[9px]">Editing</Badge>}
                      <span className="shrink-0 font-mono-data text-[10px] text-muted-foreground">#{ent.id}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Select ${ent.name} for Compare`}
                      aria-pressed={compareSelection.includes(ent.id)}
                      onClick={() => toggleCompareEntity(ent.id)}
                      className={cn(
                        'min-h-10 shrink-0 rounded border px-2 text-[10px] font-medium',
                        compareSelection.includes(ent.id)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      Compare
                    </button>
                  </div>
                ))}
                {entities.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No entities found</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Permission Editor */}
        <Card className="min-w-0 lg:col-span-9">
          <CardHeader className="pb-2">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {showCompare ? 'Permissions Compare — read only' : entityId ? 'Permissions' : 'Select an entity'}
              </CardTitle>
              {(entityId || showCompare) && (
                <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                  <div className="flex rounded-md border border-border p-0.5" aria-label="Permission label style">
                    <button
                      type="button"
                      aria-label="Simple labels"
                      aria-pressed={permissionLabelMode === 'simple'}
                      onClick={() => setPermissionLabelMode('simple')}
                      className={cn(
                        'min-h-10 min-w-10 rounded px-2 text-[11px] font-medium sm:min-h-8',
                        permissionLabelMode === 'simple' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                      )}
                    >
                      Simple
                    </button>
                    <button
                      type="button"
                      aria-label="Technical labels"
                      aria-pressed={permissionLabelMode === 'technical'}
                      onClick={() => setPermissionLabelMode('technical')}
                      className={cn(
                        'min-h-10 min-w-10 rounded px-2 text-[11px] font-medium sm:min-h-8',
                        permissionLabelMode === 'technical' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                      )}
                    >
                      Technical
                    </button>
                  </div>
                  {!showCompare && (
                    <>
                      <label className="flex min-h-10 items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none sm:min-h-8">
                        <input
                          type="checkbox"
                          checked={showSetOnly}
                          onChange={(e) => setShowSetOnly(e.target.checked)}
                          title="Show currently set permissions and staged changes"
                          className="rounded border-border"
                        />
                        Set only
                      </label>
                      <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                        <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                        <Input
                          placeholder="Search permissions..."
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="pl-7 h-8 text-xs"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {showCompare ? (
              <PermissionCompare permissions={allPerms} columns={compareColumns} labelMode={permissionLabelMode} />
            ) : (
              <ScrollArea className="h-[min(500px,60dvh)] min-h-72">
              {!entityId ? (
                <div className="flex h-[min(400px,50dvh)] min-h-64 items-center justify-center">
                  <p className="text-sm text-muted-foreground">Select an entity from the left panel</p>
                </div>
              ) : loadingPerms ? (
                <div className="flex h-[min(400px,50dvh)] min-h-64 items-center justify-center">
                  <PageLoader />
                </div>
              ) : (
                <div className="min-w-[42rem] px-3 pb-3">
                  {[...categories.entries()].map(([catKey, perms]) => (
                    <div key={catKey} className="mb-1">
                      <button
                        onClick={() => toggleCat(catKey)}
                        aria-expanded={expandedCats.has(catKey)}
                        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors rounded"
                      >
                        {expandedCats.has(catKey) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {PERM_CATEGORIES[catKey] || catKey}
                        <Badge variant="secondary" className="text-[9px] h-4 ml-1">{perms.length}</Badge>
                      </button>
                      {expandedCats.has(catKey) && (
                        <div className="ml-4 border-l border-border/50 pl-2">
                          {/* Header */}
                          <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                            <div className="col-span-5">Permission</div>
                            <div className="col-span-2 text-center">Value</div>
                            <div className="col-span-1 text-center">Skip</div>
                            <div className="col-span-1 text-center">Negate</div>
                            <div className="col-span-3"></div>
                          </div>
                          {perms.map((perm) => {
                            const effective = getEffectiveValue(perm.permsid);
                            const isSet = effective !== null && effective.action !== 'remove';
                            const isChanged = changes.has(perm.permsid);
                            const isBoolean = perm.permsid.startsWith('b_');

                            return (
                              <div
                                key={perm.permsid}
                                className={cn(
                                  'grid grid-cols-12 gap-2 px-2 py-1 rounded text-xs items-center group',
                                  isChanged && 'bg-primary/5',
                                  isSet ? 'text-foreground' : 'text-muted-foreground',
                                )}
                              >
                                <div className="col-span-5 min-w-0" title={`${getSimplePermissionLabel(perm)} (${perm.permsid})`}>
                                  {permissionLabelMode === 'simple' ? (
                                    <>
                                      <span className="block truncate text-[11px] font-medium">{getSimplePermissionLabel(perm)}</span>
                                      <span className="block truncate font-mono-data text-[9px] text-muted-foreground">{perm.permsid}</span>
                                    </>
                                  ) : (
                                    <span className="block truncate font-mono-data text-[11px]">{perm.permsid}</span>
                                  )}
                                </div>
                                <div className="col-span-2 flex justify-center">
                                  {isBoolean ? (
                                    <button
                                      aria-label={`${getSimplePermissionLabel(perm)} permission`}
                                      aria-pressed={isSet}
                                      onClick={() => {
                                        if (isSet) removePerm(perm.permsid);
                                        else setPermValue(perm.permsid, 1, 0, 0);
                                      }}
                                      className={cn(
                                        'flex h-10 w-10 items-center justify-center rounded border transition-colors sm:h-7 sm:w-7',
                                        isSet
                                          ? 'bg-primary border-primary text-primary-foreground'
                                          : 'border-border hover:border-primary/50',
                                      )}
                                    >
                                      {isSet && <Check className="h-3 w-3" />}
                                    </button>
                                  ) : (
                                    <Input
                                      type="number"
                                      aria-label={`${getSimplePermissionLabel(perm)} value`}
                                      className="h-6 w-20 text-xs text-center font-mono-data px-1"
                                      value={effective?.permvalue ?? ''}
                                      placeholder="—"
                                      onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        if (!isNaN(val)) {
                                          setPermValue(perm.permsid, val, effective?.permnegated || 0, effective?.permskip || 0);
                                        } else if (e.target.value === '') {
                                          removePerm(perm.permsid);
                                        }
                                      }}
                                    />
                                  )}
                                </div>
                                <div className="col-span-1 flex justify-center">
                                  {!isBoolean && (
                                    <button
                                      aria-label={`${getSimplePermissionLabel(perm)} Skip`}
                                      aria-pressed={!!(isSet && effective?.permskip)}
                                      disabled={!isSet}
                                      onClick={() => {
                                        if (!isSet) return;
                                        const newSkip = (effective?.permskip || 0) ? 0 : 1;
                                        setPermValue(perm.permsid, effective?.permvalue || 0, effective?.permnegated || 0, newSkip);
                                      }}
                                      className={cn(
                                        'flex h-10 w-10 items-center justify-center rounded border text-[9px] transition-colors sm:h-7 sm:w-7',
                                        isSet && effective?.permskip
                                          ? 'border-warning bg-warning/20 text-warning'
                                          : 'border-border/50',
                                      )}
                                      title="Skip"
                                    >
                                      {isSet && effective?.permskip ? 'S' : ''}
                                    </button>
                                  )}
                                </div>
                                <div className="col-span-1 flex justify-center">
                                  {!isBoolean && (
                                    <button
                                      aria-label={`${getSimplePermissionLabel(perm)} Negate`}
                                      aria-pressed={!!(isSet && effective?.permnegated)}
                                      disabled={!isSet}
                                      onClick={() => {
                                        if (!isSet) return;
                                        const newNeg = (effective?.permnegated || 0) ? 0 : 1;
                                        setPermValue(perm.permsid, effective?.permvalue || 0, newNeg, effective?.permskip || 0);
                                      }}
                                      className={cn(
                                        'flex h-10 w-10 items-center justify-center rounded border text-[9px] transition-colors sm:h-7 sm:w-7',
                                        isSet && effective?.permnegated
                                          ? 'bg-destructive/20 border-destructive text-destructive'
                                          : 'border-border/50',
                                      )}
                                      title="Negate"
                                    >
                                      {isSet && effective?.permnegated ? 'N' : ''}
                                    </button>
                                  )}
                                </div>
                                <div className="touch-action-reveal col-span-3 flex items-center justify-end gap-1 transition-opacity">
                                  {isSet && (
                                    <button
                                      onClick={() => removePerm(perm.permsid)}
                                      aria-label={`Remove ${getSimplePermissionLabel(perm)}`}
                                      className="flex h-10 w-10 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:w-7"
                                      title="Remove permission"
                                    >
                                      <Minus className="h-3 w-3" />
                                    </button>
                                  )}
                                  {isChanged && (
                                    <span className="text-[9px] text-primary font-mono-data">Staged</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  {categories.size === 0 && (
                    <div className="flex items-center justify-center h-[300px]">
                      <p className="text-sm text-muted-foreground">No permissions match your search</p>
                    </div>
                  )}
                </div>
              )}
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={!!pendingTransition}
        onOpenChange={(open) => {
          if (!open) setPendingTransition(null);
        }}
        title="Unsaved permission changes"
        description={pendingTransition?.description || 'Discard this permission draft?'}
        cancelLabel="Stay"
        confirmLabel="Discard & continue"
        destructive
        onConfirm={() => {
          const transition = pendingTransition;
          setDraft(null);
          setPendingTransition(null);
          transition?.apply();
        }}
      />
    </div>
  );
}
