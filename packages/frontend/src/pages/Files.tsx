import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { filesApi } from '@/api/files.api';
import { channelsApi } from '@/api/channels.api';
import { useServerStore } from '@/stores/server.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { EmptyState } from '@/components/shared/EmptyState';
import {
  buildFilePath,
  canConfirmFileAction,
  shouldCloseFileDialog,
  type FileActionTarget,
} from '@/lib/action-ownership';
import {
  channelCoverageKey,
  channelSummaryDisplay,
  channelSummaryLabelText,
  connectionScope,
  consumePageEntryAttempt,
  decidePageEntryScan,
  deferCancelSummaryQuery,
  expensiveDiagnosticQueryOptions,
  hasConsumedPageEntryAttempt,
  markExpensiveDiagnosticStale,
  pageEntryAttemptWasOffline,
  retainSummaryQueryScope,
  type SummaryObservation,
} from '@/lib/demand-driven-query-policy';
import {
  FILE_WRITE_READ_DOES_NOT_AUTHORIZE,
  fileBrowseErrorMessage,
  fileDeleteConfirmDescription,
  fileWriteErrorMessage,
} from '@/lib/action-guidance';
import { cn, formatBytes } from '@/lib/utils';
import {
  isCountedSummary,
  isPartialSummary,
  selectChannelsForSummaryScan,
  type ChannelFileSummaryResult,
} from '@/api/file-summary.types';
import {
  FolderOpen, File, Folder, ArrowLeft, FolderPlus, Trash2, Hash, HardDrive, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

interface FileEntry {
  name: string;
  size: number;
  datetime: number;
  type: number; // 0 = file, 1 = directory
}

type SummaryQueryData = {
  summaries: ChannelFileSummaryResult[];
  observation: SummaryObservation;
};

export default function Files() {
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  const qc = useQueryClient();

  const [selectedCid, setSelectedCid] = useState<number | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [showMkdir, setShowMkdir] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileActionTarget | null>(null);
  const [ownerGeneration, setOwnerGeneration] = useState(0);
  const deleteTargetRef = useRef<FileActionTarget | null>(null);
  deleteTargetRef.current = deleteTarget;

  // Fetch channel list for selector
  const { data: channelData } = useQuery({
    queryKey: ['channels-for-files', c, s],
    queryFn: () => channelsApi.list(c!, s!),
    enabled: !!c && !!s,
  });

  const channels = useMemo(() => {
    if (!channelData || !Array.isArray(channelData)) return [];
    return channelData.map((ch: any) => ({
      cid: Number(ch.cid),
      name: ch.channel_name,
    }));
  }, [channelData]);

  const channelIds = useMemo(() => channels.map((channel) => channel.cid), [channels]);
  const { scanIds, omittedIds } = useMemo(
    () => selectChannelsForSummaryScan(channelIds),
    [channelIds],
  );
  const eligibleChannelKey = useMemo(() => channelCoverageKey(scanIds), [scanIds]);
  const currentChannelKey = useMemo(() => channelCoverageKey(channelIds), [channelIds]);
  const scanIdsRef = useRef(scanIds);
  scanIdsRef.current = scanIds;
  const omittedIdsRef = useRef(omittedIds);
  omittedIdsRef.current = omittedIds;

  const [offlineUnchecked, setOfflineUnchecked] = useState(false);

  const summaryQueryKey = useMemo(() => ['file-summaries', c, s] as const, [c, s]);

  const {
    data: summaryPayload,
    isFetching: fetchingSummaries,
    isError: summaryIsError,
    refetch: refetchSummaries,
  } = useQuery({
    queryKey: summaryQueryKey,
    queryFn: async ({ signal }): Promise<SummaryQueryData> => {
      const ids = scanIdsRef.current;
      const omitted = omittedIdsRef.current;
      const response = await filesApi.summaries(c!, s!, ids, { signal });
      const summaries = Array.isArray(response?.summaries) ? response.summaries : [];
      // Observation covers only the bounded scan set; omitted IDs stay Not scanned.
      return {
        summaries: [
          ...summaries,
          // Ensure omitted channels appear as notScanned even if the server omitted them.
          ...omitted
            .filter((cid) => !summaries.some((row) => row.cid === cid))
            .map((cid) => ({ cid, notScanned: true as const, reason: 'channel-cap' as const })),
        ],
        observation: {
          scannedChannelKey: channelCoverageKey(ids),
          scannedAt: typeof response?.scannedAt === 'number' ? response.scannedAt : Date.now(),
        },
      };
    },
    enabled: false,
    ...expensiveDiagnosticQueryOptions,
  });

  // Disabled observers always report isStale=false; read invalidation from the cache.
  const summaryInvalidated = useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe(onChange),
    () => qc.getQueryState(summaryQueryKey)?.isInvalidated ?? false,
    () => false,
  );

  const summaryData = summaryPayload?.summaries;
  const observation = summaryPayload?.observation ?? null;

  const summariesByChannel = useMemo(() => {
    const map = new Map<number, ChannelFileSummaryResult>();
    if (!Array.isArray(summaryData)) return map;
    for (const summary of summaryData) map.set(Number(summary.cid), summary);
    return map;
  }, [summaryData]);

  // One bounded page-entry attempt per connection scope (survives /files remounts).
  useEffect(() => {
    if (!c || !s) return;
    const scope = connectionScope(c, s);
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    const decision = decidePageEntryScan({
      configId: c,
      sid: s,
      hasChannels: channelIds.length > 0,
      online,
      entryAttemptScope: hasConsumedPageEntryAttempt(scope) ? scope : null,
    });
    if (decision.action === 'skip') {
      if (decision.reason === 'already-attempted') {
        setOfflineUnchecked(pageEntryAttemptWasOffline(scope));
        return;
      }
      if (decision.reason === 'offline') {
        // Consume the page-entry opportunity so reconnect/channel churn cannot defer a scan.
        consumePageEntryAttempt(scope, true);
        setOfflineUnchecked(true);
      } else if (decision.reason === 'missing-context') {
        // Offline with no channels yet still consumes the opportunity — decidePageEntryScan
        // returns missing-context before it checks connectivity.
        if (!online) {
          consumePageEntryAttempt(scope, true);
          setOfflineUnchecked(true);
        } else {
          setOfflineUnchecked(false);
        }
      }
      return;
    }
    consumePageEntryAttempt(decision.scope, false);
    setOfflineUnchecked(false);
    void refetchSummaries();
  }, [c, s, channelIds.length, refetchSummaries]);

  // Connection revision: cancel in-flight summaries when the scope leaves.
  // Defer cancel so StrictMode same-scope remount can retain the initial scan.
  useEffect(() => {
    retainSummaryQueryScope(summaryQueryKey);
    return () => {
      deferCancelSummaryQuery(qc, summaryQueryKey);
    };
  }, [qc, summaryQueryKey]);

  const refreshSummaries = () => {
    if (!c || !s || channelIds.length === 0) return;
    consumePageEntryAttempt(connectionScope(c, s), false);
    setOfflineUnchecked(false);
    // Compatible in-flight work is coalesced by TanStack Query on the same key.
    void refetchSummaries();
  };

  // Fetch files in selected channel + path
  const { data: fileData, isLoading: loadingFiles, error: filesError } = useQuery({
    queryKey: ['files', c, s, selectedCid, currentPath],
    queryFn: () => filesApi.list(c!, s!, selectedCid!, currentPath),
    enabled: !!c && !!s && !!selectedCid,
    retry: false,
  });

  const files: FileEntry[] = useMemo(() => {
    if (!fileData || !Array.isArray(fileData)) return [];
    return fileData.map((f: any) => ({
      name: f.name,
      size: Number(f.size) || 0,
      datetime: Number(f.datetime) || 0,
      type: Number(f.type),
    })).sort((a: FileEntry, b: FileEntry) => {
      // Directories first, then alphabetical
      if (a.type !== b.type) return b.type - a.type;
      return a.name.localeCompare(b.name);
    });
  }, [fileData]);

  useEffect(() => {
    setOwnerGeneration((g) => g + 1);
    setSelectedCid(null);
    setCurrentPath('/');
    setShowMkdir(false);
    setNewDirName('');
    setDeleteTarget(null);
  }, [c, s]);

  useEffect(() => {
    setDeleteTarget(null);
  }, [selectedCid]);

  const mkdirMutation = useMutation({
    mutationFn: (target: FileActionTarget) =>
      filesApi.createDir(target.configId, target.sid, target.cid, target.fullPath),
    onSuccess: async (_data, target) => {
      toast.success('Directory created');
      qc.invalidateQueries({
        queryKey: ['files', target.configId, target.sid, target.cid],
      });
      // Drop an in-flight scan before invalidating so its completion cannot clear
      // isInvalidated and present pre-mutation counts as fresh.
      const summaryKey = ['file-summaries', target.configId, target.sid] as const;
      await qc.cancelQueries({ queryKey: summaryKey });
      await markExpensiveDiagnosticStale(qc, summaryKey);
      // Only dismiss mkdir UI when it still belongs to the submitted scope.
      if (
        c === target.configId
        && s === target.sid
        && selectedCid === target.cid
        && target.ownerGeneration === ownerGeneration
      ) {
        setShowMkdir(false);
        setNewDirName('');
      }
    },
    onError: (error) => toast.error(fileWriteErrorMessage(error, 'create')),
  });

  const deleteMutation = useMutation({
    mutationFn: (target: FileActionTarget) =>
      filesApi.delete(target.configId, target.sid, target.cid, target.fullPath),
    onSuccess: async (_data, target) => {
      toast.success('File deleted');
      qc.invalidateQueries({
        queryKey: ['files', target.configId, target.sid, target.cid],
      });
      const summaryKey = ['file-summaries', target.configId, target.sid] as const;
      await qc.cancelQueries({ queryKey: summaryKey });
      await markExpensiveDiagnosticStale(qc, summaryKey);
      if (shouldCloseFileDialog(deleteTargetRef.current, target)) {
        setDeleteTarget(null);
      }
    },
    onError: (error) => toast.error(fileWriteErrorMessage(error, 'delete')),
  });

  const navigateTo = (entry: FileEntry) => {
    if (entry.type === 1) {
      setCurrentPath(buildFilePath(currentPath, entry.name));
    }
  };

  const goUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.length === 0 ? '/' : '/' + parts.join('/'));
  };

  const openDelete = (entry: FileEntry) => {
    if (!c || !s || selectedCid == null) return;
    setDeleteTarget({
      configId: c,
      sid: s,
      cid: selectedCid,
      fullPath: buildFilePath(currentPath, entry.name),
      ownerGeneration,
      entryName: entry.name,
    });
  };

  const handleMkdir = () => {
    if (!newDirName.trim() || !c || !s || selectedCid == null) return;
    const target: FileActionTarget = {
      configId: c,
      sid: s,
      cid: selectedCid,
      fullPath: buildFilePath(currentPath, newDirName.trim()),
      ownerGeneration,
      entryName: newDirName.trim(),
    };
    mkdirMutation.mutate(target);
  };

  const handleDelete = () => {
    if (!canConfirmFileAction(deleteTarget, { configId: c, sid: s, cid: selectedCid })) {
      // Context switched away from the dialog owner — do not retarget to live B.
      setDeleteTarget(null);
      toast.error('Server context changed — delete cancelled');
      return;
    }
    deleteMutation.mutate(deleteTarget);
  };

  const deleteLoading = Boolean(
    deleteMutation.isPending
    && deleteMutation.variables
    && deleteTarget
    && shouldCloseFileDialog(deleteTarget, deleteMutation.variables),
  );

  const formatDate = (ts: number) => {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleDateString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  // Breadcrumb parts
  const pathParts = currentPath.split('/').filter(Boolean);

  if (!c || !s) return <EmptyState icon={FolderOpen} title="No server selected" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">File Browser</h1>
        {selectedCid && (
          <Button size="sm" onClick={() => setShowMkdir(true)}>
            <FolderPlus className="h-4 w-4 mr-1" /> New Folder
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Channel Selector */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span className="flex items-center gap-1.5"><Hash className="h-3.5 w-3.5" /> Channels</span>
              <span className="flex items-center gap-1">
                {fetchingSummaries && <RefreshCw className="h-3 w-3 animate-spin text-sky-400" aria-label="Scanning storage" />}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={refreshSummaries}
                  disabled={fetchingSummaries || channelIds.length === 0}
                  aria-label="Refresh storage summary"
                  title="Refresh storage summary"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[min(20rem,40dvh)] lg:h-[500px]">
              <div className="p-2 space-y-0.5">
                {channels.map((ch) => {
                  const summary = summariesByChannel.get(ch.cid);
                  const display = channelSummaryDisplay({
                    offlineUnchecked,
                    isFetching: fetchingSummaries,
                    isError: summaryIsError,
                    hasErrorData: summaryIsError,
                    observation,
                    currentChannelKey,
                    eligibleChannelKey,
                    omittedChannelIds: omittedIds,
                    channelId: ch.cid,
                    summary,
                    isQueryInvalidated: summaryInvalidated,
                  });
                  const statusText = channelSummaryLabelText(display);
                  const counted = isCountedSummary(summary);
                  const showPartial = isPartialSummary(summary);
                  return (
                  <button
                    key={ch.cid}
                    onClick={() => { setSelectedCid(ch.cid); setCurrentPath('/'); }}
                    className={cn(
                      'w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      selectedCid === ch.cid
                        ? 'bg-primary/10 text-primary'
                        : 'text-foreground hover:bg-muted/50',
                    )}
                  >
                    <span className="block truncate">{ch.name}</span>
                    <span className="mt-1 flex min-h-3.5 items-center gap-2 font-mono-data text-[9px] text-muted-foreground/80">
                      {statusText && display.kind !== 'partial' && display.kind !== 'stale-cached' ? (
                        <span className={cn(
                          display.kind === 'unavailable' || display.kind === 'error' ? 'text-amber-400/80' : undefined,
                        )}>
                          {statusText}
                        </span>
                      ) : counted ? (
                        <>
                          <span className="flex items-center gap-0.5" title="Files"><File className="h-3 w-3" />{summary.fileCount}</span>
                          <span className="flex items-center gap-0.5" title="Folders"><Folder className="h-3 w-3" />{summary.folderCount}</span>
                          <span className="ml-auto flex items-center gap-0.5" title="Total size"><HardDrive className="h-3 w-3" />{formatBytes(summary.totalSize)}</span>
                          {showPartial && (
                            <span className="text-amber-400/80" title="Scan stopped before the full tree was counted">Partial</span>
                          )}
                          {display.kind === 'stale-cached' && (
                            <span className="text-amber-400/80" title="Summary may be outdated">Stale</span>
                          )}
                        </>
                      ) : statusText ? (
                        <span className={cn(
                          display.kind === 'unavailable' || display.kind === 'error' ? 'text-amber-400/80' : undefined,
                        )}>
                          {statusText}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  );
                })}
                {channels.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No channels</p>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* File List */}
        <Card className="min-w-0 lg:col-span-9">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                {selectedCid && currentPath !== '/' && (
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goUp}>
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </Button>
                )}
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <HardDrive className="h-3.5 w-3.5" />
                  <button onClick={() => setCurrentPath('/')} className="hover:text-foreground transition-colors">/</button>
                  {pathParts.map((part, i) => (
                    <span key={i} className="flex items-center gap-1">
                      <span>/</span>
                      <button
                        onClick={() => setCurrentPath('/' + pathParts.slice(0, i + 1).join('/'))}
                        className="hover:text-foreground transition-colors"
                      >
                        {part}
                      </button>
                    </span>
                  ))}
                </div>
              </div>
              {selectedCid && (
                <Badge variant="secondary" className="text-[10px] font-mono-data">
                  {files.length} item(s)
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {!selectedCid ? (
              <div className="flex h-[min(400px,50dvh)] min-h-64 items-center justify-center">
                <p className="text-sm text-muted-foreground">Select a channel to browse files</p>
              </div>
            ) : loadingFiles ? (
              <div className="flex h-[min(400px,50dvh)] min-h-64 items-center justify-center">
                <PageLoader />
              </div>
            ) : filesError ? (
              <div className="flex h-[min(400px,50dvh)] min-h-64 flex-col items-center justify-center gap-3 px-4 sm:px-8">
                <AlertTriangle className="h-8 w-8 text-amber-400" />
                <p className="text-sm font-medium text-foreground">File Browser Unavailable</p>
                <p className="text-xs text-muted-foreground text-center max-w-md" role="alert">
                  {fileBrowseErrorMessage(filesError)}
                </p>
                {(filesError as any)?.response?.data?.code != null && (
                  <p className="text-[10px] text-muted-foreground/60 mt-1">TS3 error code: {(filesError as any).response.data.code}</p>
                )}
              </div>
            ) : (
              <ScrollArea className="h-[min(460px,55dvh)] min-h-72">
                <div className="min-w-[36rem]">
                {/* File table header */}
                <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border">
                  <div className="col-span-6">Name</div>
                  <div className="col-span-2 text-right">Size</div>
                  <div className="col-span-3">Modified</div>
                  <div className="col-span-1"></div>
                </div>

                {files.length === 0 ? (
                  <div className="flex items-center justify-center h-[350px]">
                    <EmptyState icon={FolderOpen} title="Empty directory" description="No files in this directory." />
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {files.map((file) => (
                      <div
                        key={file.name}
                        className={cn(
                          'grid grid-cols-12 gap-2 px-4 py-2 text-sm items-center group hover:bg-muted/20 transition-colors',
                          file.type === 1 && 'cursor-pointer',
                        )}
                        onClick={() => navigateTo(file)}
                      >
                        <div className="col-span-6 flex items-center gap-2 truncate">
                          {file.type === 1 ? (
                            <Folder className="h-4 w-4 text-primary/70 shrink-0" />
                          ) : (
                            <File className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="truncate">{file.name}</span>
                        </div>
                        <div className="col-span-2 text-right text-xs text-muted-foreground font-mono-data">
                          {file.type === 0 ? formatBytes(file.size) : '-'}
                        </div>
                        <div className="col-span-3 text-xs text-muted-foreground font-mono-data">
                          {formatDate(file.datetime)}
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <button
                            onClick={(e) => { e.stopPropagation(); openDelete(file); }}
                            className="touch-action-reveal flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`Delete ${file.name}`}
                            title={`Delete ${file.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Info notice */}
      <p className="text-xs text-muted-foreground text-center">
        File upload/download is not available via WebQuery API. Use the TS3 client for file transfers.
      </p>

      {/* Create Directory Dialog */}
      <Dialog open={showMkdir} onOpenChange={setShowMkdir}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Directory</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div>
              <Label className="text-xs">Directory Name</Label>
              <Input value={newDirName} onChange={(e) => setNewDirName(e.target.value)} placeholder="New Folder" autoFocus />
            </div>
            <p role="note" className="text-xs text-muted-foreground" data-testid="file-write-read-not-authorize">
              {FILE_WRITE_READ_DOES_NOT_AUTHORIZE}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMkdir(false)}>Cancel</Button>
            <Button onClick={handleMkdir} disabled={mkdirMutation.isPending || !newDirName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm — bound to deleteTarget ownership, not live store */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title="Delete File"
        description={
          deleteTarget
            ? fileDeleteConfirmDescription(deleteTarget.entryName ?? deleteTarget.fullPath, deleteTarget.fullPath)
            : ''
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
        loading={deleteLoading}
      />
    </div>
  );
}
