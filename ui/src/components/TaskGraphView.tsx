import { useMemo, useRef, useState } from "react";
import { CheckCircle2, Maximize2, Minus, Plus, Radio } from "lucide-react";
import type { Issue, IssueStatus } from "@paperclipai/shared";

import { Button } from "./ui/button";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { issueStatusText, issueStatusTextDefault } from "../lib/status-colors";

const NODE_WIDTH = 224;
const NODE_HEIGHT = 76;
const COLUMN_GAP = 92;
const ROW_GAP = 26;
const COMPONENT_GAP = 56;
const CANVAS_PADDING = 28;
const MIN_CANVAS_WIDTH = 980;
const MIN_ZOOM = 0.15;

const statusBorderClasses: Record<IssueStatus, string> = {
  backlog: "border-l-neutral-400",
  todo: "border-l-amber-500",
  in_progress: "border-l-blue-500",
  in_review: "border-l-violet-500",
  blocked: "border-l-red-500",
  done: "border-l-green-500",
  cancelled: "border-l-neutral-500",
};

export interface TaskGraphNode {
  issue: Issue;
  x: number;
  y: number;
}

export interface TaskGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "child" | "blocker";
}

export interface TaskGraphLayout {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  width: number;
  height: number;
}

function issueSort(left: Issue, right: Issue) {
  return (left.identifier ?? left.id).localeCompare(right.identifier ?? right.id, undefined, {
    numeric: true,
  });
}

export function buildTaskGraphLayout(issues: Issue[]): TaskGraphLayout {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const edgeKeys = new Set<string>();
  const edges: TaskGraphEdge[] = [];
  const addEdge = (sourceId: string, targetId: string, kind: TaskGraphEdge["kind"]) => {
    if (!issueById.has(sourceId) || !issueById.has(targetId) || sourceId === targetId) return;
    const key = `${kind}:${sourceId}:${targetId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: key, sourceId, targetId, kind });
  };

  for (const issue of issues) {
    if (issue.parentId) addEdge(issue.parentId, issue.id, "child");
    for (const blocker of issue.blockedBy ?? []) addEdge(blocker.id, issue.id, "blocker");
  }

  const adjacency = new Map(issues.map((issue) => [issue.id, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.sourceId)?.add(edge.targetId);
    adjacency.get(edge.targetId)?.add(edge.sourceId);
  }

  const components: Issue[][] = [];
  const visited = new Set<string>();
  for (const issue of [...issues].sort(issueSort)) {
    if (visited.has(issue.id)) continue;
    const component: Issue[] = [];
    const pending = [issue.id];
    visited.add(issue.id);
    while (pending.length) {
      const currentId = pending.shift()!;
      const current = issueById.get(currentId);
      if (current) component.push(current);
      for (const neighbour of adjacency.get(currentId) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        pending.push(neighbour);
      }
    }
    components.push(component.sort(issueSort));
  }

  components.sort((left, right) => {
    if (left.length === 1 && right.length !== 1) return 1;
    if (left.length !== 1 && right.length === 1) return -1;
    return right.length - left.length || issueSort(left[0], right[0]);
  });

  const nodes: TaskGraphNode[] = [];
  let yOffset = CANVAS_PADDING;
  let widest = MIN_CANVAS_WIDTH;
  const isolated: Issue[] = [];

  for (const component of components) {
    if (component.length === 1) {
      isolated.push(component[0]);
      continue;
    }

    const componentIds = new Set(component.map((issue) => issue.id));
    const componentEdges = edges.filter(
      (edge) => componentIds.has(edge.sourceId) && componentIds.has(edge.targetId),
    );
    const incoming = new Map(component.map((issue) => [issue.id, 0]));
    const outgoing = new Map(component.map((issue) => [issue.id, [] as string[]]));
    for (const edge of componentEdges) {
      incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
      outgoing.get(edge.sourceId)?.push(edge.targetId);
    }

    const ranks = new Map(component.map((issue) => [issue.id, 0]));
    const queue = component.filter((issue) => incoming.get(issue.id) === 0).sort(issueSort);
    const processed = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      processed.add(current.id);
      for (const targetId of outgoing.get(current.id) ?? []) {
        ranks.set(targetId, Math.max(ranks.get(targetId) ?? 0, (ranks.get(current.id) ?? 0) + 1));
        incoming.set(targetId, (incoming.get(targetId) ?? 1) - 1);
        if (incoming.get(targetId) === 0) {
          const target = issueById.get(targetId);
          if (target) queue.push(target);
          queue.sort(issueSort);
        }
      }
    }

    // Cycles should still remain visible instead of making the entire graph fail to lay out.
    for (const issue of component) {
      if (processed.has(issue.id)) continue;
      const predecessorRanks = componentEdges
        .filter((edge) => edge.targetId === issue.id && processed.has(edge.sourceId))
        .map((edge) => ranks.get(edge.sourceId) ?? 0);
      ranks.set(issue.id, predecessorRanks.length ? Math.max(...predecessorRanks) + 1 : 0);
    }

    const byRank = new Map<number, Issue[]>();
    for (const issue of component) {
      const rank = ranks.get(issue.id) ?? 0;
      const column = byRank.get(rank) ?? [];
      column.push(issue);
      byRank.set(rank, column);
    }
    for (const column of byRank.values()) column.sort(issueSort);

    const maxRows = Math.max(...Array.from(byRank.values(), (column) => column.length));
    const maxRank = Math.max(...byRank.keys());
    const componentHeight = maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
    for (const [rank, column] of byRank) {
      column.forEach((issue, index) => {
        nodes.push({
          issue,
          x: CANVAS_PADDING + rank * (NODE_WIDTH + COLUMN_GAP),
          y: yOffset + index * (NODE_HEIGHT + ROW_GAP),
        });
      });
    }
    widest = Math.max(widest, CANVAS_PADDING * 2 + (maxRank + 1) * NODE_WIDTH + maxRank * COLUMN_GAP);
    yOffset += componentHeight + COMPONENT_GAP;
  }

  if (isolated.length) {
    const columns = Math.min(4, Math.max(1, isolated.length));
    isolated.forEach((issue, index) => {
      nodes.push({
        issue,
        x: CANVAS_PADDING + (index % columns) * (NODE_WIDTH + COLUMN_GAP),
        y: yOffset + Math.floor(index / columns) * (NODE_HEIGHT + ROW_GAP),
      });
    });
    const isolatedRows = Math.ceil(isolated.length / columns);
    widest = Math.max(widest, CANVAS_PADDING * 2 + columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP);
    yOffset += isolatedRows * NODE_HEIGHT + Math.max(0, isolatedRows - 1) * ROW_GAP;
  } else {
    yOffset = Math.max(CANVAS_PADDING, yOffset - COMPONENT_GAP);
  }

  return {
    nodes,
    edges,
    width: widest,
    height: Math.max(300, yOffset + CANVAS_PADDING),
  };
}

function edgePath(source: TaskGraphNode, target: TaskGraphNode): string {
  const sourceX = source.x + NODE_WIDTH;
  const sourceY = source.y + NODE_HEIGHT / 2;
  const targetX = target.x;
  const targetY = target.y + NODE_HEIGHT / 2;
  if (targetX > sourceX + 30) {
    const middleX = (sourceX + targetX) / 2;
    return `M ${sourceX} ${sourceY} C ${middleX} ${sourceY}, ${middleX} ${targetY}, ${targetX} ${targetY}`;
  }
  const detourX = Math.max(sourceX, target.x + NODE_WIDTH) + 34;
  return `M ${sourceX} ${sourceY} C ${detourX} ${sourceY}, ${detourX} ${targetY}, ${targetX} ${targetY}`;
}

export function TaskGraphView({
  issues,
  liveIssueIds,
}: {
  issues: Issue[];
  liveIssueIds?: ReadonlySet<string>;
}) {
  const [showCompleted, setShowCompleted] = useState(false);
  const completedCount = useMemo(
    () => issues.filter((issue) => issue.status === "done" || issue.status === "cancelled").length,
    [issues],
  );
  const visibleIssues = useMemo(
    () => showCompleted
      ? issues
      : issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled"),
    [issues, showCompleted],
  );
  const layout = useMemo(() => buildTaskGraphLayout(visibleIssues), [visibleIssues]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.issue.id, node])), [layout.nodes]);
  const [zoom, setZoom] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const changeZoom = (next: number) => setZoom(Math.min(1.4, Math.max(MIN_ZOOM, next)));
  const fitGraph = () => {
    const available = (scrollerRef.current?.clientWidth ?? layout.width) - 24;
    changeZoom(available / layout.width);
    scrollerRef.current?.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label="Task graph">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2 text-(length:--text-nano) text-muted-foreground">
        <span className="font-medium text-foreground">Task graph</span>
        <span>{layout.nodes.length} tasks · {layout.edges.length} connections</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 bg-muted-foreground/70" /> parent / child
        </span>
        <span className="inline-flex items-center gap-1.5 text-red-500">
          <span className="w-5 border-t border-dashed border-red-500/80" /> blocked by
        </span>
        <span className="hidden sm:inline">Swipe or scroll to pan</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant={showCompleted ? "secondary" : "outline"}
            size="sm"
            className="h-8 gap-1.5 px-2 text-(length:--text-nano)"
            aria-label={showCompleted ? "Hide completed tasks" : `Show ${completedCount} completed tasks`}
            aria-pressed={showCompleted}
            onClick={() => setShowCompleted((current) => !current)}
            disabled={completedCount === 0}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {showCompleted ? "Hide completed" : `Show completed (${completedCount})`}
          </Button>
          <div className="flex items-center rounded-md border border-border bg-background/70">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-r-none"
              aria-label="Zoom out"
              onClick={() => changeZoom(zoom - 0.15)}
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-11 text-center font-mono text-foreground">{Math.round(zoom * 100)}%</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-none"
              aria-label="Zoom in"
              onClick={() => changeZoom(zoom + 0.15)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-l-none border-l border-border"
              aria-label="Fit graph"
              onClick={fitGraph}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="h-[min(68vh,760px)] min-h-96 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-background/35"
        data-testid="task-graph-scroller"
      >
        {layout.nodes.length === 0 ? (
          <div className="flex h-full min-h-96 items-center justify-center px-5 text-center text-sm text-muted-foreground">
            {completedCount > 0 ? "No active tasks. Show completed tasks to view the archive." : "No tasks match the current filters or search."}
          </div>
        ) : <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
          >
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height}>
              <defs>
                <marker id="task-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                </marker>
                <marker id="task-graph-blocker-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const source = nodeById.get(edge.sourceId);
                const target = nodeById.get(edge.targetId);
                if (!source || !target) return null;
                return (
                  <path
                    key={edge.id}
                    d={edgePath(source, target)}
                    fill="none"
                    stroke="currentColor"
                    className={edge.kind === "blocker" ? "text-red-500/75" : "text-muted-foreground/55"}
                    strokeWidth={edge.kind === "blocker" ? 1.75 : 1.35}
                    strokeDasharray={edge.kind === "blocker" ? "5 4" : undefined}
                    markerEnd={edge.kind === "blocker" ? "url(#task-graph-blocker-arrow)" : "url(#task-graph-arrow)"}
                  />
                );
              })}
            </svg>

            {layout.nodes.map(({ issue, x, y }) => {
              const statusText = issueStatusText[issue.status] ?? issueStatusTextDefault;
              const isLive = liveIssueIds?.has(issue.id) ?? false;
              return (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  disableIssueQuicklook
                  data-testid="task-graph-node"
                  data-issue-id={issue.id}
                  className={cn(
                    "absolute flex flex-col rounded-md border border-l-[3px] border-border bg-card px-3 py-2.5 text-left no-underline shadow-sm transition hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    statusBorderClasses[issue.status],
                  )}
                  style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                  title={`Open ${issue.identifier ?? issue.id}: ${issue.title}`}
                >
                  <span className="flex items-center justify-between gap-2 text-(length:--text-nano)">
                    <span className={cn("font-mono font-semibold", statusText)}>{issue.identifier ?? issue.id.slice(0, 8)}</span>
                    <span className={cn("inline-flex items-center gap-1 capitalize", statusText)}>
                      {isLive ? <Radio className="h-3 w-3 animate-pulse" aria-label="Live" /> : null}
                      {issue.status.replace(/_/g, " ")}
                    </span>
                  </span>
                  <span className="mt-1 line-clamp-2 text-xs font-medium leading-4 text-foreground">{issue.title}</span>
                </Link>
              );
            })}
          </div>
        </div>}
      </div>
    </section>
  );
}
