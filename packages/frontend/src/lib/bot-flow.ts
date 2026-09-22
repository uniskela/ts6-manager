export interface FlowNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, any>;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export interface FlowSnapshot {
  botId: number;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface OrthogonalRoute {
  points: Point[];
  path: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const ROUTING_CLEARANCE = 32;
export const FLOW_TRAILING_PADDING = 128;
const CORNER_RADIUS = 12;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function createFlowSnapshot(botId: number, name: string, nodes: FlowNode[], edges: FlowEdge[]): FlowSnapshot {
  return clone({ botId, name, nodes, edges });
}

export function flowSnapshotsEqual(a: FlowSnapshot | null, b: FlowSnapshot | null): boolean {
  if (!a || !b) return false;
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function samePoint(a: Point, b: Point) { return a.x === b.x && a.y === b.y; }

function collapseCollinear(points: Point[]): Point[] {
  return points.filter((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const before = points[index - 1];
    const after = points[index + 1];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  }).filter((point, index, all) => index === 0 || !samePoint(point, all[index - 1]));
}

function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  if (a.x === b.x) return a.x >= left && a.x <= right && Math.max(Math.min(a.y, b.y), top) <= Math.min(Math.max(a.y, b.y), bottom);
  if (a.y === b.y) return a.y >= top && a.y <= bottom && Math.max(Math.min(a.x, b.x), left) <= Math.min(Math.max(a.x, b.x), right);
  return false;
}

function roundedPath(points: Point[]): string {
  if (points.length < 2) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incomingLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const outgoingLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    const radius = Math.min(CORNER_RADIUS, incomingLength / 2, outgoingLength / 2);
    const before = {
      x: current.x + (previous.x === current.x ? 0 : previous.x < current.x ? -radius : radius),
      y: current.y + (previous.y === current.y ? 0 : previous.y < current.y ? -radius : radius),
    };
    const after = {
      x: current.x + (next.x === current.x ? 0 : next.x < current.x ? -radius : radius),
      y: current.y + (next.y === current.y ? 0 : next.y < current.y ? -radius : radius),
    };
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
}

export function buildOrthogonalRoute(source: Point, target: Point, obstacles: Rect[]): OrthogonalRoute {
  const sourceExit = { x: source.x + ROUTING_CLEARANCE, y: source.y };
  const targetEntry = { x: Math.max(0, target.x - ROUTING_CLEARANCE), y: target.y };
  const forward = target.x > source.x;
  const direct: Point[] = forward && source.y === target.y
    ? [source, target]
    : forward
      ? [source, { x: (source.x + target.x) / 2, y: source.y }, { x: (source.x + target.x) / 2, y: target.y }, target]
      : [];
  const directBlocked = direct.some((point, index) => index > 0 && obstacles.some((obstacle) => segmentIntersectsRect(direct[index - 1], point, obstacle)));
  let points: Point[];
  if (direct.length > 0 && !directBlocked) {
    points = direct;
  } else {
    const laneY = Math.max(source.y, target.y, ...obstacles.map((obstacle) => obstacle.y + obstacle.height)) + ROUTING_CLEARANCE;
    points = [source, sourceExit, { x: sourceExit.x, y: laneY }, { x: targetEntry.x, y: laneY }, targetEntry, target];
  }
  points = collapseCollinear(points);
  const values = points.flatMap((point) => [point.x, point.y]);
  return {
    points,
    path: roundedPath(points),
    bounds: { minX: Math.min(...values.filter((_, index) => index % 2 === 0)), minY: Math.min(...values.filter((_, index) => index % 2 === 1)), maxX: Math.max(...values.filter((_, index) => index % 2 === 0)), maxY: Math.max(...values.filter((_, index) => index % 2 === 1)) },
  };
}

export function computeCanvasExtent({
  nodes,
  routeBounds,
  viewportWidth,
  viewportHeight,
}: {
  nodes: FlowNode[];
  routeBounds: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
  viewportWidth: number;
  viewportHeight: number;
}): { width: number; height: number } {
  const maxX = Math.max(0, ...nodes.map((node) => node.x + NODE_WIDTH), ...routeBounds.map((route) => route.maxX));
  const maxY = Math.max(0, ...nodes.map((node) => node.y + NODE_HEIGHT), ...routeBounds.map((route) => route.maxY));
  return {
    width: Math.max(viewportWidth, Math.ceil(maxX + FLOW_TRAILING_PADDING)),
    height: Math.max(viewportHeight, Math.ceil(maxY + FLOW_TRAILING_PADDING)),
  };
}
