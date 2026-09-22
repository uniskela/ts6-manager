import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useBot, useUpdateBot } from '@/hooks/use-bots';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft, Save, HelpCircle, Zap, MessageSquare, Ban, UserX, ArrowRightLeft,
  Clock, GitBranch, Variable, FileText, Webhook, Terminal, Plus, Trash2,
  Bell, PenLine, FolderPlus, FolderMinus, Users, Globe, Send,
  Moon, Timer, Megaphone, Award, Shield,
  Music, Volume2, LogIn, LogOut, Pause, SkipForward, Navigation, Mic, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PlaceholderReference } from '@/components/bots/PlaceholderReference';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  buildOrthogonalRoute,
  computeCanvasExtent,
  createFlowSnapshot,
  flowSnapshotsEqual,
  NODE_HEIGHT,
  NODE_WIDTH,
  type FlowEdge,
  type FlowNode,
  type FlowSnapshot,
} from '@/lib/bot-flow';

// --- Node type definitions ---
type HandleConfig = {
  inputs: string[];   // named input ports
  outputs: string[];  // named output ports
};

interface NodeTypeDef {
  type: string;
  label: string;
  icon: React.ElementType;
  color: string;
  handles: HandleConfig;
}

const TRIGGER_NODES: NodeTypeDef[] = [
  { type: 'trigger_event', label: 'TS Event', icon: Zap, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', handles: { inputs: [], outputs: ['out'] } },
  { type: 'trigger_cron', label: 'Cron Timer', icon: Clock, color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', handles: { inputs: [], outputs: ['out'] } },
  { type: 'trigger_webhook', label: 'Webhook', icon: Webhook, color: 'bg-violet-500/20 text-violet-400 border-violet-500/30', handles: { inputs: [], outputs: ['out'] } },
  { type: 'trigger_command', label: 'Chat Command', icon: Terminal, color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30', handles: { inputs: [], outputs: ['out'] } },
];

const ACTION_NODES: NodeTypeDef[] = [
  { type: 'action_message', label: 'Send Message', icon: MessageSquare, color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_poke', label: 'Poke Client', icon: Bell, color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_kick', label: 'Kick Client', icon: UserX, color: 'bg-red-500/20 text-red-400 border-red-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_ban', label: 'Ban Client', icon: Ban, color: 'bg-red-500/20 text-red-400 border-red-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_move', label: 'Move Client', icon: ArrowRightLeft, color: 'bg-orange-500/20 text-orange-400 border-orange-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_channelCreate', label: 'Create Channel', icon: FolderPlus, color: 'bg-green-500/20 text-green-400 border-green-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_channelEdit', label: 'Edit Channel', icon: PenLine, color: 'bg-green-500/20 text-green-400 border-green-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_channelDelete', label: 'Delete Channel', icon: FolderMinus, color: 'bg-red-500/20 text-red-400 border-red-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_groupAdd', label: 'Add to Group', icon: Users, color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_groupRemove', label: 'Remove from Group', icon: Users, color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_webquery', label: 'WebQuery', icon: Terminal, color: 'bg-sky-500/20 text-sky-400 border-sky-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_webhook', label: 'Webhook', icon: Send, color: 'bg-sky-500/20 text-sky-400 border-sky-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_httpRequest', label: 'HTTP Request', icon: Globe, color: 'bg-sky-500/20 text-sky-400 border-sky-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
];

const VOICE_ACTION_NODES: NodeTypeDef[] = [
  { type: 'action_voicePlay', label: 'Voice Play', icon: Music, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceStop', label: 'Voice Stop', icon: Music, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceJoinChannel', label: 'Voice Join', icon: LogIn, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceLeaveChannel', label: 'Voice Leave', icon: LogOut, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceVolume', label: 'Voice Volume', icon: Volume2, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voicePauseResume', label: 'Voice Pause/Resume', icon: Pause, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceSkip', label: 'Voice Skip', icon: SkipForward, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceSeek', label: 'Voice Seek', icon: Navigation, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_voiceTts', label: 'Voice TTS', icon: Mic, color: 'bg-pink-500/20 text-pink-400 border-pink-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
];

const SMART_ACTION_NODES: NodeTypeDef[] = [
  { type: 'action_afkMover', label: 'AFK Mover', icon: Moon, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_idleKicker', label: 'Idle Kicker', icon: Timer, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_pokeGroup', label: 'Poke Group', icon: Megaphone, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_rankCheck', label: 'Rank Check', icon: Award, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_tempChannelCleanup', label: 'Temp Cleanup', icon: Trash2, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_animatedChannel', label: 'Animated Channel', icon: Sparkles, color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', handles: { inputs: [], outputs: [] } },
];

const LOGIC_NODES: NodeTypeDef[] = [
  { type: 'condition', label: 'Condition', icon: GitBranch, color: 'bg-purple-500/20 text-purple-400 border-purple-500/30', handles: { inputs: ['in'], outputs: ['true', 'false'] } },
  { type: 'delay', label: 'Delay', icon: Clock, color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'variable', label: 'Set Variable', icon: Variable, color: 'bg-teal-500/20 text-teal-400 border-teal-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'log', label: 'Log', icon: FileText, color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
  { type: 'action_generateCode', label: 'Generate Code', icon: Sparkles, color: 'bg-teal-500/20 text-teal-400 border-teal-500/30', handles: { inputs: ['in'], outputs: ['out'] } },
];

const ALL_NODE_TYPES: NodeTypeDef[] = [...TRIGGER_NODES, ...ACTION_NODES, ...VOICE_ACTION_NODES, ...SMART_ACTION_NODES, ...LOGIC_NODES];

const NODE_CATEGORIES = [
  { label: 'Triggers', nodes: TRIGGER_NODES },
  { label: 'Actions', nodes: ACTION_NODES },
  { label: 'Voice', nodes: VOICE_ACTION_NODES },
  { label: 'Smart Actions', nodes: SMART_ACTION_NODES },
  { label: 'Logic', nodes: LOGIC_NODES },
];

function getNodeMeta(type: string): NodeTypeDef | undefined {
  return ALL_NODE_TYPES.find((n) => n.type === type);
}

// --- Constants ---
const NODE_W = NODE_WIDTH;
const NODE_H = NODE_HEIGHT;
const HANDLE_R = 6;

// Calculate handle positions (absolute coords on canvas)
function getOutputHandlePos(node: FlowNode, portIndex: number, portCount: number) {
  const spacing = NODE_H / (portCount + 1);
  return { x: node.x + NODE_W, y: node.y + spacing * (portIndex + 1) };
}

function getInputHandlePos(node: FlowNode, portIndex: number, portCount: number) {
  const spacing = NODE_H / (portCount + 1);
  return { x: node.x, y: node.y + spacing * (portIndex + 1) };
}

// --- Types ---
export default function BotEditor() {
  const { botId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: bot, isLoading } = useBot(botId ? parseInt(botId) : null);
  const updateBot = useUpdateBot();

  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [botName, setBotName] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [savedBaseline, setSavedBaseline] = useState<FlowSnapshot | null>(null);
  const savedBaselineRef = useRef<FlowSnapshot | null>(null);
  const acceptedServerSnapshotRef = useRef<FlowSnapshot | null>(null);
  const saveInFlightRef = useRef(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [canvasViewport, setCanvasViewport] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Drag state
  const [dragging, setDragging] = useState<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const didDragRef = useRef(false);

  // Connection state
  const [connectFrom, setConnectFrom] = useState<{ nodeId: string; port: string } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const currentSnapshot = useMemo(() => botId
    ? createFlowSnapshot(parseInt(botId), botName, nodes, edges)
    : null, [botId, botName, nodes, edges]);
  const isDirty = Boolean(currentSnapshot && savedBaseline && !flowSnapshotsEqual(currentSnapshot, savedBaseline));

  const requestNavigation = useCallback((to: string) => {
    if (!isDirty) {
      navigate(to);
      return;
    }
    setPendingNavigation(to);
    setShowDiscardDialog(true);
  }, [isDirty, navigate]);

  // BrowserRouter does not expose a supported history blocker. Capture normal
  // internal links and use the shared confirmation UI; browser Back remains a
  // documented limitation until a data-router migration is justified.
  useEffect(() => {
    const handleInternalLink = (event: MouseEvent) => {
      if (!isDirty) return;
      const target = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!target || target.target === '_blank' || target.hasAttribute('download')) return;
      const href = new URL(target.href, window.location.href);
      if (href.origin !== window.location.origin) return;
      const destination = `${href.pathname}${href.search}${href.hash}`;
      const current = `${location.pathname}${location.search}${location.hash}`;
      if (destination === current) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingNavigation(destination);
      setShowDiscardDialog(true);
    };
    document.addEventListener('click', handleInternalLink, true);
    return () => document.removeEventListener('click', handleInternalLink, true);
  }, [isDirty, location]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateViewport = () => setCanvasViewport({ width: canvas.clientWidth, height: canvas.clientHeight });
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Load only clean editors. A refetch is allowed to refresh a clean baseline,
  // but never replaces an in-progress draft.
  useEffect(() => {
    if (!bot || !botId || saveInFlightRef.current) return;
    const id = parseInt(botId);
    let flow: { nodes?: FlowNode[]; edges?: FlowEdge[] } = {};
    try { flow = typeof bot.flowData === 'string' ? JSON.parse(bot.flowData) : bot.flowData; } catch { /* legacy malformed data becomes an empty flow */ }
    const serverSnapshot = createFlowSnapshot(
      id,
      bot.name || '',
      flow.nodes || [],
      (flow.edges || []).map((edge: any) => ({ ...edge, sourcePort: edge.sourcePort || 'out', targetPort: edge.targetPort || 'in' })),
    );
    const baseline = savedBaselineRef.current;
    const current = currentSnapshot;
    if (!baseline || baseline.botId !== id) {
      savedBaselineRef.current = serverSnapshot;
      setSavedBaseline(serverSnapshot);
      acceptedServerSnapshotRef.current = null;
      setBotName(serverSnapshot.name);
      setNodes(serverSnapshot.nodes);
      setEdges(serverSnapshot.edges);
      return;
    }
    if (acceptedServerSnapshotRef.current && flowSnapshotsEqual(serverSnapshot, acceptedServerSnapshotRef.current)) {
      acceptedServerSnapshotRef.current = null;
    } else if (acceptedServerSnapshotRef.current) {
      return;
    }
    if (current && !flowSnapshotsEqual(current, baseline)) return;
    if (!flowSnapshotsEqual(serverSnapshot, baseline)) {
      savedBaselineRef.current = serverSnapshot;
      setSavedBaseline(serverSnapshot);
      setBotName(serverSnapshot.name);
      setNodes(serverSnapshot.nodes);
      setEdges(serverSnapshot.edges);
    }
  }, [bot, botId, currentSnapshot]);

  const handleSave = useCallback(() => {
    if (!botId || !currentSnapshot || saveInFlightRef.current) return;
    const snapshot = createFlowSnapshot(currentSnapshot.botId, currentSnapshot.name, currentSnapshot.nodes, currentSnapshot.edges);
    saveInFlightRef.current = true;
    setSaveInFlight(true);
    updateBot.mutate({
      id: snapshot.botId,
      data: { name: snapshot.name, flowData: { nodes: snapshot.nodes, edges: snapshot.edges } },
    }, {
      onSuccess: () => {
        savedBaselineRef.current = snapshot;
        setSavedBaseline(snapshot);
        acceptedServerSnapshotRef.current = snapshot;
        toast.success('Flow saved');
      },
      onError: () => toast.error('Failed to save flow; your edits are still here'),
      onSettled: () => {
        saveInFlightRef.current = false;
        setSaveInFlight(false);
      },
    });
  }, [botId, currentSnapshot, updateBot]);

  const addNode = (type: string, label: string) => {
    const id = `node_${Date.now()}`;
    setNodes((prev) => [...prev, { id, type, label, config: {}, x: 220 + Math.random() * 200, y: 80 + prev.length * 90 }]);
    setSelectedNode(id);
  };

  const deleteNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    if (selectedNode === id) setSelectedNode(null);
  };

  const deleteEdge = (id: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== id));
  };

  // Pointer events preserve desktop drag behavior and allow touch editing.
  const handleCanvasMouseMove = useCallback((e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
    const y = e.clientY - rect.top + e.currentTarget.scrollTop;

    if (connectFrom) {
      setMousePos({ x, y });
    }

    if (dragging) {
      didDragRef.current = true;
      setNodes((prev) => prev.map((n) =>
        n.id === dragging
          ? { ...n, x: Math.max(0, x - dragOffsetRef.current.x), y: Math.max(0, y - dragOffsetRef.current.y) }
          : n
      ));
    }
  }, [dragging, connectFrom]);

  const handleCanvasMouseUp = useCallback((e: React.PointerEvent) => {
    setDragging(null);

    // If connecting: check if we released on a valid target
    if (connectFrom) {
      const target = (e.target as HTMLElement).closest('[data-input-port]') as HTMLElement | null;
      const targetNode = (e.target as HTMLElement).closest('.flow-node') as HTMLElement | null;

      if (target) {
        // Released on an input handle
        const nodeId = target.getAttribute('data-node-id')!;
        const port = target.getAttribute('data-input-port')!;
        if (connectFrom.nodeId !== nodeId) {
          const exists = edges.some((ed) => ed.source === connectFrom.nodeId && ed.sourcePort === connectFrom.port && ed.target === nodeId);
          if (!exists) {
            setEdges((prev) => [...prev, {
              id: `edge_${Date.now()}`,
              source: connectFrom.nodeId,
              sourcePort: connectFrom.port,
              target: nodeId,
              targetPort: port,
            }]);
          }
        }
        setConnectFrom(null);
      } else if (targetNode) {
        // Released on a node body — connect to first input if available
        const nodeId = targetNode.getAttribute('data-node-id');
        if (nodeId && connectFrom.nodeId !== nodeId) {
          const targetMeta = getNodeMeta(nodes.find((n) => n.id === nodeId)?.type || '');
          if (targetMeta && targetMeta.handles.inputs.length > 0) {
            const targetPort = targetMeta.handles.inputs[0];
            const exists = edges.some((ed) => ed.source === connectFrom.nodeId && ed.sourcePort === connectFrom.port && ed.target === nodeId);
            if (!exists) {
              setEdges((prev) => [...prev, {
                id: `edge_${Date.now()}`,
                source: connectFrom.nodeId,
                sourcePort: connectFrom.port,
                target: nodeId,
                targetPort,
              }]);
            }
          }
        }
        setConnectFrom(null);
      } else {
        // Released on empty canvas — cancel
        setConnectFrom(null);
      }
    }
  }, [connectFrom, nodes, edges]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    // Only deselect if we clicked directly on the canvas (not on a node)
    if ((e.target as HTMLElement).closest('.flow-node')) return;
    setSelectedNode(null);
    setConnectFrom(null); // Cancel active connection on empty canvas click
  }, []);

  const handleNodeMouseDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (connectFrom) return; // Don't start drag while connecting

    const canvas = (e.currentTarget as HTMLElement).closest('.flow-canvas')!;
    const rect = canvas.getBoundingClientRect();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const mx = e.clientX - rect.left + canvas.scrollLeft;
    const my = e.clientY - rect.top + canvas.scrollTop;

    dragOffsetRef.current = { x: mx - node.x, y: my - node.y };
    didDragRef.current = false;
    setDragging(nodeId);
  }, [nodes, connectFrom]);

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();

    // If connecting, complete the connection to this node's input
    if (connectFrom) {
      const targetMeta = getNodeMeta(nodes.find((n) => n.id === nodeId)?.type || '');
      if (connectFrom.nodeId !== nodeId && targetMeta && targetMeta.handles.inputs.length > 0) {
        const targetPort = targetMeta.handles.inputs[0];
        // Don't allow duplicate edges
        const exists = edges.some((e) => e.source === connectFrom.nodeId && e.sourcePort === connectFrom.port && e.target === nodeId);
        if (!exists) {
          setEdges((prev) => [...prev, {
            id: `edge_${Date.now()}`,
            source: connectFrom.nodeId,
            sourcePort: connectFrom.port,
            target: nodeId,
            targetPort,
          }]);
        }
      }
      setConnectFrom(null);
      return;
    }

    // Select (only if not finishing a drag)
    if (!didDragRef.current) {
      setSelectedNode(nodeId);
    }
  }, [connectFrom, nodes, edges]);

  // --- Output handle press: start connection ---
  const handleOutputPointerDown = useCallback((e: React.PointerEvent, nodeId: string, port: string) => {
    e.stopPropagation();
    e.preventDefault();
    const canvas = (e.currentTarget as HTMLElement).closest('.flow-canvas')!;
    const rect = canvas.getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left + canvas.scrollLeft,
      y: e.clientY - rect.top + canvas.scrollTop,
    });
    setConnectFrom({ nodeId, port });
  }, []);

  // --- Input handle click: complete connection ---
  const handleInputClick = useCallback((e: React.MouseEvent, nodeId: string, port: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (connectFrom && connectFrom.nodeId !== nodeId) {
      const exists = edges.some((ed) => ed.source === connectFrom.nodeId && ed.sourcePort === connectFrom.port && ed.target === nodeId);
      if (!exists) {
        setEdges((prev) => [...prev, {
          id: `edge_${Date.now()}`,
          source: connectFrom.nodeId,
          sourcePort: connectFrom.port,
          target: nodeId,
          targetPort: port,
        }]);
      }
      setConnectFrom(null);
    }
  }, [connectFrom, edges]);

  const selectedNodeData = useMemo(() => nodes.find((n) => n.id === selectedNode), [nodes, selectedNode]);
  const nodeTypeMeta = useMemo(() => getNodeMeta(selectedNodeData?.type || ''), [selectedNodeData]);
  const edgeRoutes = useMemo(() => edges.flatMap((edge) => {
    const srcNode = nodes.find((node) => node.id === edge.source);
    const tgtNode = nodes.find((node) => node.id === edge.target);
    if (!srcNode || !tgtNode) return [];
    const srcMeta = getNodeMeta(srcNode.type);
    const tgtMeta = getNodeMeta(tgtNode.type);
    if (!srcMeta || !tgtMeta) return [];
    const srcPortIndex = srcMeta.handles.outputs.indexOf(edge.sourcePort);
    const tgtPortIndex = tgtMeta.handles.inputs.indexOf(edge.targetPort);
    if (srcPortIndex < 0 || tgtPortIndex < 0) return [];
    const source = getOutputHandlePos(srcNode, srcPortIndex, srcMeta.handles.outputs.length);
    const target = getInputHandlePos(tgtNode, tgtPortIndex, tgtMeta.handles.inputs.length);
    const obstacles = nodes
      .filter((node) => node.id !== srcNode.id && node.id !== tgtNode.id)
      .map((node) => ({ x: node.x, y: node.y, width: NODE_W, height: NODE_H }));
    return [{ edge, source, target, route: buildOrthogonalRoute(source, target, obstacles) }];
  }), [edges, nodes]);
  const canvasExtent = useMemo(() => computeCanvasExtent({
    nodes,
    routeBounds: edgeRoutes.map(({ route }) => route.bounds),
    viewportWidth: canvasViewport.width,
    viewportHeight: canvasViewport.height,
  }), [canvasViewport, edgeRoutes, nodes]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[34rem] flex-col md:h-[calc(100dvh-8rem)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => requestNavigation('/bots')} aria-label="Back to bot flows" title="Back to bot flows">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input value={botName} onChange={(e) => setBotName(e.target.value)} className="h-9 min-w-0 flex-1 text-sm font-medium sm:h-8 sm:w-60 sm:flex-none" aria-label="Bot flow name" />
          <Badge variant={isDirty ? 'default' : 'outline'} className="hidden text-[10px] sm:inline-flex">{isDirty ? 'Unsaved changes' : 'Saved'}</Badge>
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">{nodes.length} nodes</Badge>
          <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">{edges.length} edges</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowHelp(true)} aria-label="Open placeholder reference" title="Placeholder reference">
            <HelpCircle className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={handleSave} disabled={saveInFlight}>
            <Save className="h-4 w-4 mr-1" /> Save
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border md:flex-row">
        {/* Node Palette */}
        <div className="h-28 w-full shrink-0 border-b border-border bg-card/50 md:h-auto md:w-52 md:border-b-0 md:border-r">
          <ScrollArea className="h-full">
            <div className="flex w-max gap-4 p-2 md:block md:w-auto md:space-y-4 md:p-3">
              {NODE_CATEGORIES.map((cat) => (
                <div key={cat.label}>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">{cat.label}</p>
                  <div className="flex gap-1 md:block md:space-y-1">
                    {cat.nodes.map((node) => (
                      <button
                        key={node.type}
                        className={cn('flex min-h-10 w-36 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors hover:opacity-80 md:min-h-0 md:w-full', node.color)}
                        onClick={() => addNode(node.type, node.label)}
                      >
                        <node.icon className="h-3.5 w-3.5 shrink-0" />
                        <span>{node.label}</span>
                        <Plus className="h-3 w-3 ml-auto opacity-50" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="flow-canvas relative min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto bg-zinc-950/30"
          style={{
            cursor: connectFrom ? 'crosshair' : 'default',
            backgroundImage: 'radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
          onPointerMove={handleCanvasMouseMove}
          onPointerUp={handleCanvasMouseUp}
          onClick={handleCanvasClick}
        >
          <div className="relative" style={{ width: canvasExtent.width, height: canvasExtent.height }}>
          <svg className="absolute inset-0 pointer-events-none" width={canvasExtent.width} height={canvasExtent.height} viewBox={`0 0 ${canvasExtent.width} ${canvasExtent.height}`}>
            {/* Edges */}
            {edgeRoutes.map(({ edge, source: src, target: tgt, route }) => {
              const isConditionTrue = edge.sourcePort === 'true';
              const isConditionFalse = edge.sourcePort === 'false';

              return (
                <g key={edge.id} className="pointer-events-auto cursor-pointer" aria-label={`${isConditionTrue ? 'True' : isConditionFalse ? 'False' : 'Flow'} connection`} onClick={(ev) => { ev.stopPropagation(); deleteEdge(edge.id); }}>
                  <path
                    d={route.path}
                    fill="none"
                    stroke={isConditionTrue ? 'hsl(var(--success))' : isConditionFalse ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                    strokeWidth={2}
                    strokeOpacity={0.5}
                  />
                  {/* Invisible wider path for easier click */}
                  <path
                    d={route.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                  />
                  {/* Arrow at target */}
                  <circle cx={tgt.x} cy={tgt.y} r={3}
                    fill={isConditionTrue ? 'hsl(var(--success))' : isConditionFalse ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                    fillOpacity={0.8}
                  />
                  {(isConditionTrue || isConditionFalse) && (
                    <text x={src.x + 12} y={src.y - 8} className="text-[10px]" fill={isConditionTrue ? 'hsl(var(--success))' : 'hsl(var(--destructive))'}>{isConditionTrue ? 'True' : 'False'}</text>
                  )}
                </g>
              );
            })}

            {/* Connection drag preview */}
            {connectFrom && (() => {
              const srcNode = nodes.find((n) => n.id === connectFrom.nodeId);
              const srcMeta = srcNode ? getNodeMeta(srcNode.type) : null;
              if (!srcNode || !srcMeta) return null;
              const idx = srcMeta.handles.outputs.indexOf(connectFrom.port);
              if (idx < 0) return null;
              const src = getOutputHandlePos(srcNode, idx, srcMeta.handles.outputs.length);
              const previewRoute = buildOrthogonalRoute(src, mousePos, []);
              return (
                <path
                  d={previewRoute.path}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  strokeOpacity={0.7}
                />
              );
            })()}
          </svg>

          {/* Nodes */}
          {nodes.map((node) => {
            const meta = getNodeMeta(node.type);
            if (!meta) return null;
            const Icon = meta.icon;
            const hasInputs = meta.handles.inputs.length > 0;
            const outputs = meta.handles.outputs;

            return (
              <div
                key={node.id}
                data-node-id={node.id}
                className={cn(
                  'flow-node absolute touch-none select-none rounded-lg border bg-card/95 backdrop-blur-sm shadow-sm transition-shadow',
                  selectedNode === node.id ? 'border-primary ring-1 ring-primary/30 shadow-md' : 'border-border hover:border-muted-foreground/30',
                  dragging === node.id ? 'cursor-grabbing shadow-lg z-20' : 'cursor-grab z-10',
                )}
                style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
                onPointerDown={(e) => handleNodeMouseDown(e, node.id)}
                onClick={(e) => handleNodeClick(e, node.id)}
              >
                {/* Header */}
                <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded-t-lg border-b border-border', meta.color)}>
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-xs font-medium truncate">{node.label}</span>
                </div>
                {/* Body */}
                <div className="px-3 py-1.5">
                  <p className="text-[10px] text-muted-foreground truncate">{node.type.replace(/_/g, ' ')}</p>
                </div>

                {/* Input handle(s) - left side */}
                {hasInputs && meta.handles.inputs.map((port, i) => {
                  const pos = getInputHandlePos(node, i, meta.handles.inputs.length);
                  return (
                    <button
                      type="button"
                      key={`in-${port}`}
                      data-input-port={port}
                      data-node-id={node.id}
                      className={cn(
                        "absolute z-30 rounded-full border-2 border-card transition-colors after:absolute after:-inset-3 after:content-['']",
                        connectFrom ? 'bg-primary hover:bg-primary scale-125' : 'bg-muted-foreground/50 hover:bg-primary',
                      )}
                      style={{
                        left: -HANDLE_R,
                        top: (pos.y - node.y) - HANDLE_R,
                        width: HANDLE_R * 2,
                        height: HANDLE_R * 2,
                      }}
                      onClick={(e) => handleInputClick(e, node.id, port)}
                      title={`Input: ${port}`}
                      aria-label={`Connect to ${node.label} input ${port}`}
                    />
                  );
                })}

                {/* Output handle(s) - right side */}
                {outputs.map((port, i) => {
                  const pos = getOutputHandlePos(node, i, outputs.length);
                  const isTrue = port === 'true';
                  const isFalse = port === 'false';
                  return (
                    <div
                      key={`out-${port}`}
                      className="absolute z-30 flex items-center gap-1"
                      style={{
                        left: NODE_W - HANDLE_R,
                        top: (pos.y - node.y) - HANDLE_R,
                      }}
                    >
                      <button
                        type="button"
                        className={cn(
                          "relative cursor-crosshair rounded-full border-2 border-card transition-colors after:absolute after:-inset-3 after:content-['']",
                          isTrue ? 'bg-green-500 hover:bg-green-400' :
                          isFalse ? 'bg-red-500 hover:bg-red-400' :
                          'bg-primary/60 hover:bg-primary',
                        )}
                        style={{ width: HANDLE_R * 2, height: HANDLE_R * 2 }}
                        onPointerDown={(e) => handleOutputPointerDown(e, node.id, port)}
                        title={`Output: ${port}`}
                        aria-label={`Start connection from ${node.label} output ${port}`}
                      />
                      {outputs.length > 1 && (
                        <span className={cn(
                          'text-[8px] font-mono-data ml-1 select-none pointer-events-none',
                          isTrue ? 'text-green-400' : isFalse ? 'text-red-400' : 'text-muted-foreground',
                        )}>
                          {port}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          </div>

          {/* Connection hint */}
          {connectFrom && (
            <div className="fixed top-[calc(1rem+env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-50 bg-primary/20 border border-primary/30 text-primary text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
              Click an input port or node to connect — ESC to cancel
            </div>
          )}
        </div>

        {/* Properties Panel */}
        {selectedNodeData && (
          <div className="absolute inset-x-0 bottom-0 z-40 max-h-[55%] w-full shrink-0 border-t border-border bg-card/95 shadow-2xl backdrop-blur-sm md:static md:max-h-none md:w-64 md:border-l md:border-t-0 md:bg-card/50 md:shadow-none">
            <ScrollArea className="h-full">
              <div className="p-3 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold">Node Properties</p>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteNode(selectedNodeData.id)} aria-label={`Delete ${selectedNodeData.label}`} title={`Delete ${selectedNodeData.label}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <Separator />

                <div>
                  <Label className="text-[10px] text-muted-foreground">Label</Label>
                  <Input
                    className="h-7 text-xs mt-1"
                    value={selectedNodeData.label}
                    onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, label: e.target.value } : n))}
                  />
                </div>

                <div>
                  <Label className="text-[10px] text-muted-foreground">Type</Label>
                  <div className={cn('mt-1 text-xs px-2 py-1 rounded border', nodeTypeMeta?.color || 'bg-muted/30')}>
                    {selectedNodeData.type.replace(/_/g, ' ')}
                  </div>
                </div>

                {/* Ports info */}
                {nodeTypeMeta && (
                  <div className="flex gap-2 text-[10px]">
                    {nodeTypeMeta.handles.inputs.length > 0 && (
                      <Badge variant="secondary" className="text-[9px]">IN: {nodeTypeMeta.handles.inputs.join(', ')}</Badge>
                    )}
                    <Badge variant="secondary" className="text-[9px]">OUT: {nodeTypeMeta.handles.outputs.join(', ')}</Badge>
                  </div>
                )}

                <Separator />

                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground mb-2">CONFIGURATION</p>

                  {selectedNodeData.type === 'trigger_event' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Event Name</Label>
                      <Select
                        value={selectedNodeData.config.eventName || ''}
                        onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, eventName: v } } : n))}
                      >
                        <SelectTrigger className="h-7 text-xs mt-1"><SelectValue placeholder="Select event..." /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="notifycliententerview">Client Enter</SelectItem>
                          <SelectItem value="notifyclientleftview">Client Leave</SelectItem>
                          <SelectItem value="notifytextmessage">Text Message</SelectItem>
                          <SelectItem value="notifyclientmoved">Client Moved</SelectItem>
                          <SelectItem value="notifyserveredited">Server Edited</SelectItem>
                          <SelectItem value="notifychanneldescriptionchanged">Channel Desc Changed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {selectedNodeData.type === 'trigger_cron' && (
                    <>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Cron Expression</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="*/5 * * * *"
                          value={selectedNodeData.config.cron || ''}
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, cron: e.target.value } } : n))}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Timezone</Label>
                        <Select
                          value={selectedNodeData.config.timezone || 'UTC'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, timezone: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Europe/Berlin">Europe/Berlin</SelectItem>
                            <SelectItem value="Europe/London">Europe/London</SelectItem>
                            <SelectItem value="Europe/Paris">Europe/Paris</SelectItem>
                            <SelectItem value="Europe/Moscow">Europe/Moscow</SelectItem>
                            <SelectItem value="America/New_York">America/New_York</SelectItem>
                            <SelectItem value="America/Chicago">America/Chicago</SelectItem>
                            <SelectItem value="America/Los_Angeles">America/Los_Angeles</SelectItem>
                            <SelectItem value="Asia/Tokyo">Asia/Tokyo</SelectItem>
                            <SelectItem value="UTC">UTC</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  {selectedNodeData.type === 'trigger_webhook' && (
                    <>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Webhook Path</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="my-hook"
                          value={selectedNodeData.config.path || ''}
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, path: e.target.value } } : n))}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">HTTP Method</Label>
                        <Select
                          value={selectedNodeData.config.method || 'POST'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, method: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="POST">POST</SelectItem>
                            <SelectItem value="GET">GET</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Secret (optional)</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="Leave empty for no auth"
                          type="password"
                          value={selectedNodeData.config.secret || ''}
                          onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, secret: e.target.value } } : n))}
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">Validated via X-Webhook-Secret header or ?secret= query param</p>
                      </div>
                    </>
                  )}

                  {selectedNodeData.type === 'trigger_command' && (
                  <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Command</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="!help"
                          value={selectedNodeData.config.command || ''}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, command: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                      </div>

                      <div>
                        <Label className="text-[10px] text-muted-foreground">Listen Channel ID (optional)</Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="42"
                          value={selectedNodeData.config.channelId || ''}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, channelId: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                          Commands are only received while a ServerQuery client is in that channel.
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_message' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Target Mode</Label>
                        <Select
                          value={selectedNodeData.config.targetMode || 'client'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, targetMode: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="client">Client</SelectItem>
                            <SelectItem value="channel">Channel</SelectItem>
                            <SelectItem value="server">Server</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedNodeData.config.targetMode !== 'server' && (
                        <div>
                          <Label className="text-[10px] text-muted-foreground">
                            {selectedNodeData.config.targetMode === 'channel' ? 'Channel ID' : 'Client ID'}
                          </Label>
                          <Input
                            className="h-7 text-xs mt-1 font-mono-data"
                            placeholder={selectedNodeData.config.targetMode === 'channel' ? 'Channel ID or {{event.ctid}}' : 'Client ID or {{event.clid}}'}
                            value={selectedNodeData.config.target || ''}
                            onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, target: e.target.value } } : n))}
                          />
                        </div>
                      )}
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Message</Label>
                        <Textarea
                          className="min-h-[120px] text-xs mt-1 resize-y font-mono-data"
                          placeholder={"Dies ist die HelpList:\n\n!create - erstellt einen Channel\n!delete - löscht deinen Channel\n!help - zeigt diese Liste"}
                          value={selectedNodeData.config.message || ''}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, message: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                          Tipp: Zeilenumbrüche werden übernommen.
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_kick' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Kick From</Label>
                        <Select
                          value={selectedNodeData.config.reasonid || '5'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, reasonid: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="4">Channel</SelectItem>
                            <SelectItem value="5">Server</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Reason</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Kicked by bot" value={selectedNodeData.config.reason || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, reason: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_ban' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Duration (seconds, 0=permanent)</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="3600" value={selectedNodeData.config.time || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, time: parseInt(e.target.value) || 0 } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Reason</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Banned by bot" value={selectedNodeData.config.reason || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, reason: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_move' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Target Channel ID (or template)</Label>
                      <Input
                        className="h-7 text-xs mt-1 font-mono-data"
                        placeholder="94  or  {{temp.lastCreatedChannelId}}"
                        value={selectedNodeData.config.cid ?? ''}
                        onChange={(e) =>
                          setNodes((prev) =>
                            prev.map((n) =>
                              n.id === selectedNode
                                ? { ...n, config: { ...n.config, cid: e.target.value } }
                                : n
                            )
                          )
                        }
                      />
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                        Example: 94 or {"{{temp.lastCreatedChannelId}}"}
                      </p>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_poke' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Message</Label>
                      <Input className="h-7 text-xs mt-1" placeholder="Hey {{event.client_nickname}}!" value={selectedNodeData.config.message || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, message: e.target.value } } : n))} />
                    </div>
                  )}

                  {selectedNodeData.type === 'action_channelCreate' && (
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={!!selectedNodeData.config.trackTempChannel}
                          disabled={selectedNodeData.config.channel_flag_semi_permanent !== '1' || !selectedNodeData.config.cpid || selectedNodeData.config.cpid === '0'}
                          onChange={(e) => setNodes(prev => prev.map(n => n.id === selectedNode ? { ...n, config: { ...n.config, trackTempChannel: e.target.checked } } : n))}
                        />
                        Track for this flow’s temporary-channel cleanup (requires a parent and semi-permanent lifetime)
                      </label>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Name</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="[cspacer]Info" value={selectedNodeData.config.channel_name || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channel_name: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Parent Channel ID</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="0" value={selectedNodeData.config.cpid || ''} onChange={(e) => setNodes((prev) => prev.map((n) => {
                          if (n.id !== selectedNode) return n;
                          const cfg: any = { ...n.config, cpid: e.target.value };
                          if (!e.target.value || e.target.value === '0') cfg.trackTempChannel = false;
                          return { ...n, config: cfg };
                        }))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Password (optional)</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="secret or {{temp.channelPassword}}"
                          value={selectedNodeData.config.channel_password || ''}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, channel_password: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel lifetime</Label>
                        <Select value={selectedNodeData.config.channel_flag_temporary || '0'} onValueChange={(v) => setNodes((prev) => prev.map((n) => { if (n.id !== selectedNode) return n; const cfg: any = { ...n.config }; if (v === '1') { cfg.channel_flag_temporary = '1'; delete cfg.channel_flag_semi_permanent; cfg.trackTempChannel = false; } else { cfg.channel_flag_temporary = '0'; cfg.channel_flag_semi_permanent = '1'; } return { ...n, config: cfg }; }) ) }>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="0">Semi-permanent</SelectItem>
                            <SelectItem value="1">Temporary</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_channelEdit' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="42" value={selectedNodeData.config.channelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Name</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="[cspacer]{{time.time}}" value={selectedNodeData.config.channel_name || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channel_name: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Topic</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Optional" value={selectedNodeData.config.channel_topic || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channel_topic: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Description</Label>
                        <Textarea className="text-xs mt-1 min-h-[60px] font-mono-data" placeholder="{{temp.apiResult}}" value={selectedNodeData.config.channel_description || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channel_description: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Password (optional)</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="secret or {{temp.channelPassword}}"
                          value={selectedNodeData.config.channel_password || ''}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, channel_password: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                          Leave empty to keep unchanged.
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_channelDelete' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="42" value={selectedNodeData.config.channelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Force Delete</Label>
                        <Select value={selectedNodeData.config.force ? '1' : '0'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, force: v === '1' } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="0">No</SelectItem>
                            <SelectItem value="1">Yes (delete sub-channels)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {(selectedNodeData.type === 'action_groupAdd' || selectedNodeData.type === 'action_groupRemove') && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Server Group ID</Label>
                      <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="6" value={selectedNodeData.config.groupId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, groupId: e.target.value } } : n))} />
                    </div>
                  )}

                  {selectedNodeData.type === 'action_webquery' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Command</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="serverinfo" value={selectedNodeData.config.command || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, command: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Store As (temp variable)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="server" value={selectedNodeData.config.storeAs || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, storeAs: e.target.value } } : n))} />
                        <p className="text-[9px] text-muted-foreground mt-1">Access via {'{{temp.server.virtualserver_name}}'}</p>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_webhook' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">URL</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="https://example.com/hook" value={selectedNodeData.config.url || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, url: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Method</Label>
                        <Select value={selectedNodeData.config.method || 'POST'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, method: v } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="GET">GET</SelectItem>
                            <SelectItem value="POST">POST</SelectItem>
                            <SelectItem value="PUT">PUT</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Body (JSON)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder='{"key":"value"}' value={selectedNodeData.config.body || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, body: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Store As (temp variable)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="response" value={selectedNodeData.config.storeAs || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, storeAs: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_httpRequest' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">URL</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="https://api.example.com/check" value={selectedNodeData.config.url || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, url: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Method</Label>
                        <Select value={selectedNodeData.config.method || 'GET'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, method: v } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="GET">GET</SelectItem>
                            <SelectItem value="POST">POST</SelectItem>
                            <SelectItem value="PUT">PUT</SelectItem>
                            <SelectItem value="DELETE">DELETE</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Headers (JSON)</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder='{"Authorization":"Bearer xxx"}'
                          value={selectedNodeData.config.headersRaw ?? (selectedNodeData.config.headers ? JSON.stringify(selectedNodeData.config.headers) : '')}
                          onChange={(e) => {
                            const raw = e.target.value;
                            let parsed: Record<string, string> | undefined;
                            try { parsed = JSON.parse(raw); } catch { /* user still typing */ }
                            setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, headersRaw: raw, headers: parsed ?? n.config.headers } } : n));
                          }}
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">Key-value pairs as JSON object. Supports {'{{placeholders}}'}.</p>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Body (JSON)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder='{"ip":"{{event.connection_client_ip}}"}' value={selectedNodeData.config.body || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, body: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Store As (temp variable)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="apiResult" value={selectedNodeData.config.storeAs || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, storeAs: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_afkMover' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">AFK Channel ID</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="10" value={selectedNodeData.config.afkChannelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, afkChannelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Idle Threshold (seconds)</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="300" value={selectedNodeData.config.idleThresholdSeconds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, idleThresholdSeconds: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Exempt Group IDs (comma-separated)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="6,7" value={selectedNodeData.config.exemptGroupIds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, exemptGroupIds: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Exempt Channel IDs (comma-separated)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="12,15" value={selectedNodeData.config.exemptChannelIds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, exemptChannelIds: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_idleKicker' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Idle Threshold (seconds)</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="1800" value={selectedNodeData.config.idleThresholdSeconds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, idleThresholdSeconds: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Kick Reason</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Idle timeout" value={selectedNodeData.config.reason || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, reason: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Exempt Group IDs (comma-separated)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="6,7" value={selectedNodeData.config.exemptGroupIds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, exemptGroupIds: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_pokeGroup' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Server Group ID</Label>
                        <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="6" value={selectedNodeData.config.groupId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, groupId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Message</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Support needed!" value={selectedNodeData.config.message || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, message: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_rankCheck' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Ranks (JSON)</Label>
                      <Input className="h-7 text-xs mt-1 font-mono-data" placeholder='[{"hours":10,"groupId":"7"},{"hours":50,"groupId":"8"}]' value={selectedNodeData.config.ranks || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, ranks: e.target.value } } : n))} />
                      <p className="text-[9px] text-muted-foreground mt-1">Array of {'{hours, groupId}'} — highest eligible rank is assigned</p>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_tempChannelCleanup' && (
                    <>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Parent Channel ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="19" value={selectedNodeData.config.parentChannelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, parentChannelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Protected Channel IDs (comma-separated)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="20,21" value={selectedNodeData.config.protectedChannelIds || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, protectedChannelIds: e.target.value } } : n))} />
                        <p className="text-[9px] text-muted-foreground mt-1">Channels under the parent that should NOT be deleted (e.g. the lobby)</p>
                      </div>
                    </>
                  )}

                  {selectedNodeData.type === 'action_animatedChannel' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="42" value={selectedNodeData.config.channelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Display Text</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Welcome to MyServer" value={selectedNodeData.config.text || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, text: e.target.value } } : n))} />
                        <p className="text-[9px] text-muted-foreground mt-1">Supports {'{{time.time}}'}, {'{{time.date}}'}, etc.</p>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Animation Style</Label>
                        <Select value={selectedNodeData.config.style || 'scroll'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, style: v } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="scroll">Scroll Left (Marquee)</SelectItem>
                            <SelectItem value="typewriter">Typewriter</SelectItem>
                            <SelectItem value="bounce">Bounce</SelectItem>
                            <SelectItem value="blink">Blink</SelectItem>
                            <SelectItem value="wave">Wave (Decorative)</SelectItem>
                            <SelectItem value="alternateCase">Alternate Case</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Speed</Label>
                        <Select
                          value={(() => {
                            const raw = selectedNodeData.config.intervalSeconds || '10';
                            const n = parseFloat(String(raw));
                            if (!Number.isFinite(n) || n < 10) return '10';
                            if (n <= 10) return '10';
                            if (n <= 15) return '15';
                            if (n <= 30) return '30';
                            return '60';
                          })()}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, intervalSeconds: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="10">Normal (10s)</SelectItem>
                            <SelectItem value="15">Relaxed (15s)</SelectItem>
                            <SelectItem value="30">Calm (30s)</SelectItem>
                            <SelectItem value="60">Slow (60s)</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[9px] text-muted-foreground mt-1">Faster than 10s is clamped server-side so Query flood protection does not trip.</p>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Prefix</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="[cspacer]" value={selectedNodeData.config.prefix ?? '[cspacer]'} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, prefix: e.target.value } } : n))} />
                        <p className="text-[9px] text-muted-foreground mt-1">TS3 channel name prefix (e.g. [cspacer] for centered spacer)</p>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Suppress edit events</Label>
                        <Select
                          value={selectedNodeData.config.suppressEditEvents === false || selectedNodeData.config.suppressEditEvents === 'false' ? 'false' : 'true'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, suppressEditEvents: v === 'true' } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Yes (recommended)</SelectItem>
                            <SelectItem value="false">No</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[9px] text-muted-foreground mt-1">
                          Ignore TeamSpeak channel-edited notifications for this channel so other flows are not flooded. Does not hide renames inside the TeamSpeak client.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Voice Action Configs */}
                  {selectedNodeData.type === 'action_voicePlay' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1 or {{var.botId}}" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Song ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="Song ID to play" value={selectedNodeData.config.songId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, songId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Playlist ID (alternative)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="Load playlist instead" value={selectedNodeData.config.playlistId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, playlistId: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceStop' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                      <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1 or {{var.botId}}" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceJoinChannel' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="Channel ID or {{event.ctid}}" value={selectedNodeData.config.channelId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channelId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Channel Password (optional)</Label>
                        <Input className="h-7 text-xs mt-1" type="password" placeholder="Optional" value={selectedNodeData.config.channelPassword || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, channelPassword: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceLeaveChannel' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                      <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceVolume' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Volume (0-100)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="50 or {{event.volume}}" value={selectedNodeData.config.volume || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, volume: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voicePauseResume' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Action</Label>
                        <Select value={selectedNodeData.config.action || 'toggle'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, action: v } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pause">Pause</SelectItem>
                            <SelectItem value="resume">Resume</SelectItem>
                            <SelectItem value="toggle">Toggle</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceSkip' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Direction</Label>
                        <Select value={selectedNodeData.config.direction || 'next'} onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, direction: v } } : n))}>
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="next">Next</SelectItem>
                            <SelectItem value="previous">Previous</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceSeek' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Position (seconds)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="30" value={selectedNodeData.config.position || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, position: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_voiceTts' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Bot ID</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="1" value={selectedNodeData.config.botId || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, botId: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Text</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Hello {{event.client_nickname}}" value={selectedNodeData.config.text || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, text: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Language (optional)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="en" value={selectedNodeData.config.language || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, language: e.target.value } } : n))} />
                      </div>
                      <p className="text-[9px] text-muted-foreground/60">TTS engine not yet configured — placeholder only</p>
                    </div>
                  )}

                  {selectedNodeData.type === 'condition' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Expression</Label>
                      <Input
                        className="h-7 text-xs mt-1 font-mono-data"
                        placeholder='event.client_type == 0'
                        value={selectedNodeData.config.expression || ''}
                        onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, expression: e.target.value } } : n))}
                      />
                      <p className="text-[9px] text-muted-foreground mt-1">True and False use labelled outputs with distinct semantic colours.</p>
                    </div>
                  )}

                  {selectedNodeData.type === 'delay' && (
                    <div>
                      <Label className="text-[10px] text-muted-foreground">Delay (ms)</Label>
                      <Input type="number" className="h-7 text-xs mt-1 font-mono-data" placeholder="5000" value={selectedNodeData.config.delayMs || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, delayMs: parseInt(e.target.value) || 0 } } : n))} />
                    </div>
                  )}

                  {selectedNodeData.type === 'variable' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Variable Name</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="myVar" value={selectedNodeData.config.varName || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, varName: e.target.value } } : n))} />
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Value (Expression)</Label>
                        <Input className="h-7 text-xs mt-1 font-mono-data" placeholder="event.clid" value={selectedNodeData.config.varValue || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, varValue: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}

                  {selectedNodeData.type === 'action_generateCode' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Length</Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="5"
                          value={selectedNodeData.config.length ?? '5'}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, length: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                      </div>

                      <div>
                        <Label className="text-[10px] text-muted-foreground">Store As</Label>
                        <Input
                          className="h-7 text-xs mt-1 font-mono-data"
                          placeholder="code"
                          value={selectedNodeData.config.storeAs ?? 'code'}
                          onChange={(e) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, storeAs: e.target.value } }
                                  : n
                              )
                            )
                          }
                        />
                        <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                          Use as: {'{{temp.'}{(selectedNodeData.config.storeAs ?? 'code')}{'}}'}
                        </p>
                      </div>

                      <div>
                        <Label className="text-[10px] text-muted-foreground">Characters</Label>
                        <Select
                          value={(selectedNodeData.config.numericOnly ?? true) ? 'digits' : 'alnum'}
                          onValueChange={(v) =>
                            setNodes((prev) =>
                              prev.map((n) =>
                                n.id === selectedNode
                                  ? { ...n, config: { ...n.config, numericOnly: v === 'digits' } }
                                  : n
                              )
                            )
                          }
                        >
                          <SelectTrigger className="h-7 text-xs mt-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="digits">Digits only</SelectItem>
                            <SelectItem value="alnum">Alphanumeric</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                  
                  {selectedNodeData.type === 'log' && (
                    <div className="space-y-2">
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Log Level</Label>
                        <Select
                          value={selectedNodeData.config.level || 'info'}
                          onValueChange={(v) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, level: v } } : n))}
                        >
                          <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="debug">Debug</SelectItem>
                            <SelectItem value="info">Info</SelectItem>
                            <SelectItem value="warn">Warning</SelectItem>
                            <SelectItem value="error">Error</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[10px] text-muted-foreground">Message</Label>
                        <Input className="h-7 text-xs mt-1" placeholder="Client joined: {{event.client_nickname}}" value={selectedNodeData.config.message || ''} onChange={(e) => setNodes((prev) => prev.map((n) => n.id === selectedNode ? { ...n, config: { ...n.config, message: e.target.value } } : n))} />
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Connections overview */}
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground mb-1">CONNECTIONS</p>
                  <div className="space-y-1">
                    {edges.filter((e) => e.source === selectedNodeData.id).map((edge) => {
                      const target = nodes.find((n) => n.id === edge.target);
                      return (
                        <div key={edge.id} className="flex items-center justify-between text-[10px] bg-muted/20 rounded px-2 py-1">
                          <span className="flex items-center gap-1">
                            <span className="text-muted-foreground">{edge.sourcePort}</span>
                            <span>→</span>
                            <span>{target?.label || '?'}</span>
                          </span>
                          <button onClick={() => deleteEdge(edge.id)} className="text-destructive hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      );
                    })}
                    {edges.filter((e) => e.target === selectedNodeData.id).map((edge) => {
                      const source = nodes.find((n) => n.id === edge.source);
                      return (
                        <div key={edge.id} className="flex items-center justify-between text-[10px] bg-muted/20 rounded px-2 py-1">
                          <span className="flex items-center gap-1">
                            <span>{source?.label || '?'}</span>
                            <span>→</span>
                            <span className="text-muted-foreground">{edge.targetPort}</span>
                          </span>
                          <button onClick={() => deleteEdge(edge.id)} className="text-destructive hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      );
                    })}
                    {edges.filter((e) => e.source === selectedNodeData.id || e.target === selectedNodeData.id).length === 0 && (
                      <p className="text-[10px] text-muted-foreground/50">No connections</p>
                    )}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDiscardDialog}
        onOpenChange={setShowDiscardDialog}
        title="Discard unsaved flow changes?"
        description="Your Bot Flow edits have not been saved. Stay to keep editing, or discard them and continue."
        cancelLabel="Stay"
        confirmLabel="Discard & continue"
        destructive
        onConfirm={() => {
          const destination = pendingNavigation;
          setShowDiscardDialog(false);
          setPendingNavigation(null);
          if (destination) navigate(destination);
        }}
      />

      <PlaceholderReference open={showHelp} onOpenChange={setShowHelp} />
    </div>
  );
}
