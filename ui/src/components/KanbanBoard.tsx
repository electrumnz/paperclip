import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Identity } from "./Identity";
import type { Issue, IssueRelationIssueSummary, IssueStatus } from "@paperclipai/shared";
import { AlertTriangle, CornerDownRight, GitBranch } from "lucide-react";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { cn } from "../lib/utils";
import {
  issueStatusText,
  issueStatusTextDefault,
} from "../lib/status-colors";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSidebar } from "../context/SidebarContext";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;
export const KANBAN_MOBILE_SWIPE_MIN_DISTANCE = 48;
export const KANBAN_MOBILE_SWIPE_AXIS_RATIO = 1.2;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

const defaultKanbanColumnTone = {
  rail: "border-border bg-muted/20",
  railOver: "bg-accent/50 ring-1 ring-primary/20",
  header: "text-muted-foreground",
  count: "text-muted-foreground/60",
  body: "bg-muted/20",
  bodyOver: "bg-accent/40",
  card: "",
};

// Every column carries a status-hued tint (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
export const kanbanColumnTones: Partial<Record<IssueStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "border-border bg-muted/30",
    railOver: "bg-muted/50 ring-1 ring-neutral-400/25",
    header: "text-muted-foreground",
    count: "text-muted-foreground/60",
    body: "bg-muted/30 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/50 ring-1 ring-inset ring-neutral-400/25",
    card: "",
  },
  todo: {
    rail: "border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20",
    railOver: "bg-amber-100/70 ring-1 ring-amber-500/25 dark:bg-amber-950/35",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700/65 dark:text-amber-300/65",
    body: "bg-amber-50/45 ring-1 ring-inset ring-amber-500/15 dark:bg-amber-950/15",
    bodyOver: "bg-amber-100/70 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-950/30",
    card: "",
  },
  in_progress: {
    rail: "border-blue-500/25 bg-blue-50/60 dark:bg-blue-950/20",
    railOver: "bg-blue-100/70 ring-1 ring-blue-500/25 dark:bg-blue-950/35",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700/65 dark:text-blue-300/65",
    body: "bg-blue-50/45 ring-1 ring-inset ring-blue-500/15 dark:bg-blue-950/15",
    bodyOver: "bg-blue-100/70 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-950/30",
    card: "",
  },
  blocked: {
    rail: "border-red-500/25 bg-red-50/60 dark:bg-red-950/20",
    railOver: "bg-red-100/70 ring-1 ring-red-500/25 dark:bg-red-950/35",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700/65 dark:text-red-300/65",
    body: "bg-red-50/45 ring-1 ring-inset ring-red-500/15 dark:bg-red-950/15",
    bodyOver: "bg-red-100/70 ring-1 ring-inset ring-red-500/25 dark:bg-red-950/30",
    card: "",
  },
  in_review: {
    rail: "border-violet-500/25 bg-violet-50/60 dark:bg-violet-950/20",
    railOver: "bg-violet-100/70 ring-1 ring-violet-500/25 dark:bg-violet-950/35",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700/65 dark:text-violet-300/65",
    body: "bg-violet-50/45 ring-1 ring-inset ring-violet-500/15 dark:bg-violet-950/15",
    bodyOver: "bg-violet-100/70 ring-1 ring-inset ring-violet-500/25 dark:bg-violet-950/30",
    card: "",
  },
  done: {
    rail: "border-green-500/25 bg-green-50/60 dark:bg-green-950/20",
    railOver: "bg-green-100/70 ring-1 ring-green-500/25 dark:bg-green-950/35",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700/65 dark:text-green-300/65",
    body: "bg-green-50/45 ring-1 ring-inset ring-green-500/15 dark:bg-green-950/15",
    bodyOver: "bg-green-100/70 ring-1 ring-inset ring-green-500/25 dark:bg-green-950/30",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-muted-foreground/80",
    count: "text-muted-foreground/50",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: IssueStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveKanbanTargetStatus(overId: string, issues: Issue[]): IssueStatus | null {
  if ((boardStatuses as readonly string[]).includes(overId)) {
    return overId as IssueStatus;
  }
  return issues.find((issue) => issue.id === overId)?.status ?? null;
}

export function resolveMobileSwipeStatus(
  currentStatus: IssueStatus,
  deltaX: number,
  deltaY: number,
): IssueStatus {
  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance < KANBAN_MOBILE_SWIPE_MIN_DISTANCE ||
    horizontalDistance <= Math.abs(deltaY) * KANBAN_MOBILE_SWIPE_AXIS_RATIO
  ) {
    return currentStatus;
  }

  const currentIndex = boardStatuses.indexOf(currentStatus);
  const nextIndex = Math.max(
    0,
    Math.min(boardStatuses.length - 1, currentIndex + (deltaX < 0 ? 1 : -1)),
  );
  return boardStatuses[nextIndex];
}

export interface KanbanIssuePlacement {
  issue: Issue;
  depth: number;
}

/**
 * Keeps each status lane's original root/sibling order while placing descendants
 * directly below their nearest parent in that same lane. Cross-lane children stay
 * at the root of their current lane and rely on the card's visible parent context.
 */
export function orderKanbanIssues(issues: Issue[]): KanbanIssuePlacement[] {
  const issueIds = new Set(issues.map((issue) => issue.id));
  const childrenByParentId = new Map<string, Issue[]>();
  const roots: Issue[] = [];

  for (const issue of issues) {
    if (issue.parentId && issueIds.has(issue.parentId)) {
      const children = childrenByParentId.get(issue.parentId) ?? [];
      children.push(issue);
      childrenByParentId.set(issue.parentId, children);
    } else {
      roots.push(issue);
    }
  }

  const ordered: KanbanIssuePlacement[] = [];
  const visited = new Set<string>();
  const visit = (issue: Issue, depth: number) => {
    if (visited.has(issue.id)) return;
    visited.add(issue.id);
    ordered.push({ issue, depth });
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) visit(root, 0);
  // Corrupt/cyclic hierarchy data must never make a card disappear.
  for (const issue of issues) visit(issue, 0);

  return ordered;
}

function collectGraphicallyRelatedIssueIds(issues: Issue[]) {
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const relatedIdsByIssue = new Map<string, Set<string>>();
  const addRelation = (leftId: string, rightId: string) => {
    const left = relatedIdsByIssue.get(leftId) ?? new Set<string>();
    const right = relatedIdsByIssue.get(rightId) ?? new Set<string>();
    left.add(rightId);
    right.add(leftId);
    relatedIdsByIssue.set(leftId, left);
    relatedIdsByIssue.set(rightId, right);
  };

  for (const issue of issues) {
    const visited = new Set<string>();
    let parentId = issue.parentId;
    while (parentId && issueById.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      addRelation(issue.id, parentId);
      parentId = issueById.get(parentId)?.parentId ?? null;
    }
  }

  return relatedIdsByIssue;
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  liveIssueIds,
  subtreeLiveCounts,
  issueById,
  directChildCountById,
  compactCards = false,
  collapsed = false,
  visibleCount,
  revealIncrement,
  onShowMore,
  mobileFullWidth = false,
}: {
  status: IssueStatus;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  subtreeLiveCounts?: ReadonlyMap<string, number>;
  issueById: ReadonlyMap<string, Issue>;
  directChildCountById: ReadonlyMap<string, number>;
  compactCards?: boolean;
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  onShowMore: () => void;
  mobileFullWidth?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  const isEmpty = issues.length === 0;
  const placements = useMemo(() => orderKanbanIssues(issues), [issues]);
  const visiblePlacements = collapsed ? [] : placements.slice(0, visibleCount);
  const graphicallyRelatedIdsByIssue = collectGraphicallyRelatedIssueIds(
    visiblePlacements.map(({ issue }) => issue),
  );
  const hiddenCount = Math.max(issues.length - visiblePlacements.length, 0);
  const nextRevealCount = Math.min(revealIncrement, hiddenCount);
  const tone = getKanbanColumnTone(status);

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-(--sz-220px) w-(--sz-52px) shrink-0 flex-col items-center rounded-md border px-1.5 py-2 transition-colors",
          tone.rail,
          isOver && tone.railOver,
        )}
        title={`${statusLabel(status)}: ${issues.length}`}
      >
        <StatusIcon status={status} />
        <span className={cn("mt-2 [writing-mode:vertical-rl] rotate-180 text-(length:--text-nano) font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <Badge variant="ghost" className={cn("mt-auto bg-background px-1.5 text-(length:--text-nano) tabular-nums", tone.header)}>
          {issues.length}
        </Badge>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex flex-col shrink-0",
      mobileFullWidth ? "min-w-0 w-full" : "min-w-(--sz-260px) w-(--sz-260px)",
    )}>
      <div className="flex items-center gap-2 px-3 py-2 mb-1">
        <StatusIcon status={status} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", tone.header)}>
          {statusLabel(status)}
        </span>
        <span className={cn("ml-auto text-xs tabular-nums", tone.count)}>
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 min-h-(--sz-120px) rounded-md p-2 space-y-1 transition-colors",
          isOver ? tone.bodyOver : tone.body,
        )}
      >
        {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
        <SortableContext
          items={visiblePlacements.map(({ issue }) => issue.id)}
          strategy={verticalListSortingStrategy}
        >
          {visiblePlacements.map(({ issue, depth }) => (
            <div
              key={issue.id}
              data-testid="kanban-card-shell"
              data-issue-id={issue.id}
              data-parent-id={issue.parentId ?? undefined}
              data-depth={depth}
              className={cn(
                "relative",
                depth === 1 && "ml-3 pl-3",
                depth > 1 && "ml-6 pl-3",
              )}
            >
              {depth > 0 ? (
                <>
                  <span
                    className="pointer-events-none absolute inset-y-0 left-0 w-px bg-border"
                    aria-hidden="true"
                  />
                  <span
                    className="pointer-events-none absolute left-0 top-5 h-px w-2 bg-border"
                    aria-hidden="true"
                  />
                </>
              ) : null}
              <KanbanCard
                issue={issue}
                parentIssue={issue.parentId ? issueById.get(issue.parentId) : undefined}
                directChildCount={directChildCountById.get(issue.id) ?? 0}
                agents={agents}
                isLive={liveIssueIds?.has(issue.id)}
                subtreeLiveCount={subtreeLiveCounts?.get(issue.id) ?? 0}
                compact={compactCards}
                className={tone.card}
                graphicallyRelatedIssueIds={graphicallyRelatedIdsByIssue.get(issue.id)}
              />
            </div>
          ))}
        </SortableContext>
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            onClick={onShowMore}
          >
            Show {nextRevealCount} more
          </button>
        ) : null}
        {issues.length > 0 && (hiddenCount > 0 || issues.length >= visibleCount) ? (
          <p className="px-1 pt-1 text-(length:--text-micro) text-muted-foreground">
            Showing {visiblePlacements.length} of {issues.length}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanRelationshipLink({
  label,
  relatedIssue,
  icon,
  testId,
}: {
  label: string;
  relatedIssue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title" | "status">;
  icon: ReactNode;
  testId: string;
}) {
  const tone = issueStatusText[relatedIssue.status] ?? issueStatusTextDefault;
  const identifier = relatedIssue.identifier ?? relatedIssue.id.slice(0, 8);

  return (
    <Link
      to={`/issues/${relatedIssue.identifier ?? relatedIssue.id}`}
      disableIssueQuicklook
      data-testid={testId}
      data-related-status={relatedIssue.status}
      className={cn(
        "flex min-w-0 items-center gap-1 py-0.5 text-(length:--text-nano) no-underline hover:underline",
        tone,
      )}
      title={`${label} ${identifier} · ${statusLabel(relatedIssue.status)}: ${relatedIssue.title}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {icon}
      <span className="shrink-0">{label}</span>
      <span className="shrink-0 font-mono font-semibold">{identifier}</span>
      <span className="truncate">{relatedIssue.title}</span>
    </Link>
  );
}

function KanbanCard({
  issue,
  parentIssue,
  directChildCount = 0,
  agents,
  isLive,
  subtreeLiveCount = 0,
  isOverlay,
  compact = false,
  className,
  graphicallyRelatedIssueIds,
}: {
  issue: Issue;
  parentIssue?: Issue;
  directChildCount?: number;
  agents?: Agent[];
  isLive?: boolean;
  subtreeLiveCount?: number;
  isOverlay?: boolean;
  compact?: boolean;
  className?: string;
  graphicallyRelatedIssueIds?: ReadonlySet<string>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };
  const unresolvedBlockers = (issue.blockedBy ?? []).filter(
    (blocker) => blocker.status !== "done" && blocker.status !== "cancelled",
  );
  const waitingLabel = formatWaitingLabel(unresolvedBlockers);
  const displayedBlockedIssues = (issue.blocks ?? []).filter(
    (blockedIssue) => !graphicallyRelatedIssueIds?.has(blockedIssue.id),
  );
  const showParentContext = Boolean(
    issue.parentId && !graphicallyRelatedIssueIds?.has(issue.parentId),
  );

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "block cursor-grab active:cursor-grabbing transition-shadow",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      {showParentContext ? (
        parentIssue ? (
          <div className="mb-1.5">
            <KanbanRelationshipLink
              label="Child of"
              relatedIssue={parentIssue}
              icon={<CornerDownRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
              testId="kanban-parent-context"
            />
          </div>
        ) : (
          <div
            data-testid="kanban-parent-context"
            className="mb-1.5 flex min-w-0 items-center gap-1 py-0.5 text-(length:--text-nano) text-muted-foreground"
            title="Child task"
          >
            <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="shrink-0">Child of</span>
            <span className="font-medium">parent task</span>
          </div>
        )
      ) : null}
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isSuccessfulRunHandoffRequired(issue) ? (
            <Badge variant="outline"
              className="border-amber-400/45 bg-amber-50/60 px-1.5 text-(length:--text-nano) text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
              title="This task needs a next step"
              aria-label="Needs next step"
            >
              <AlertTriangle className="h-3 w-3" />
              Next step
            </Badge>
          ) : null}
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {compact ? "Live" : null}
            </span>
          )}
          {!isLive && subtreeLiveCount > 0 && (
            <Badge variant="outline"
              className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
              title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
              {subtreeLiveCount} live below
            </Badge>
          )}
        </div>
        <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{issue.title}</p>
        {directChildCount > 0 || waitingLabel ? (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {directChildCount > 0 ? (
              <Badge
                variant="outline"
                className="gap-1 border-border bg-muted/40 px-1.5 text-(length:--text-nano) text-muted-foreground"
                title={`${directChildCount} direct subtask${directChildCount === 1 ? "" : "s"}`}
              >
                <GitBranch className="h-3 w-3" aria-hidden="true" />
                {directChildCount} subtask{directChildCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {waitingLabel ? (
              <Badge
                variant="outline"
                data-testid="kanban-waiting-on"
                className="gap-1 border-amber-500/45 bg-amber-500/10 px-1.5 text-(length:--text-nano) text-amber-700 dark:text-amber-300"
                title={unresolvedBlockers.map(formatIssueReference).join(", ")}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {waitingLabel}
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2 min-w-0">
          {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority={issue.priority} />}
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <Identity name={name} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
      {displayedBlockedIssues.length > 0 ? (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-1.5" aria-label="Tasks this card is blocking">
          {displayedBlockedIssues.map((blockedIssue) => (
            <KanbanRelationshipLink
              key={blockedIssue.id}
              label="Blocking"
              relatedIssue={blockedIssue}
              icon={<AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
              testId="kanban-blocking-context"
            />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function formatIssueReference(issue: Pick<IssueRelationIssueSummary, "id" | "identifier" | "title">): string {
  return `${issue.identifier ?? issue.id.slice(0, 8)} ${issue.title}`;
}

function formatWaitingLabel(blockers: IssueRelationIssueSummary[]): string | null {
  const first = blockers[0];
  if (!first) return null;
  const identifier = first.identifier ?? first.id.slice(0, 8);
  return blockers.length === 1
    ? `Waiting on ${identifier}`
    : `Waiting on ${identifier} +${blockers.length - 1}`;
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  onUpdateIssue,
}: KanbanBoardProps) {
  const { isMobile } = useSidebar();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mobileStatus, setMobileStatus] = useState<IssueStatus>(() => {
    const firstPopulated = boardStatuses.find((status) =>
      issues.some((issue) => issue.status === status),
    );
    return firstPopulated ?? "backlog";
  });
  const mobileStatusHydrated = useRef(issues.length > 0);
  const mobileSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const mobileTabRefs = useRef<Partial<Record<IssueStatus, HTMLButtonElement | null>>>({});
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByStatus = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const sensors = useSensors(isMobile ? undefined : pointerSensor);

  useEffect(() => {
    if (!isMobile) return;
    mobileTabRefs.current[mobileStatus]?.scrollIntoView?.({
      block: "nearest",
      inline: "center",
    });
  }, [isMobile, mobileStatus]);

  useLayoutEffect(() => {
    if (!isMobile || mobileStatusHydrated.current || issues.length === 0) return;
    mobileStatusHydrated.current = true;
    const firstPopulated = boardStatuses.find((status) =>
      issues.some((issue) => issue.status === status),
    );
    if (firstPopulated) setMobileStatus(firstPopulated);
  }, [isMobile, issues]);

  const columnIssues = useMemo(() => {
    const grouped: Record<IssueStatus, Issue[]> = {} as Record<IssueStatus, Issue[]>;
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const issueById = useMemo(
    () => new Map(issues.map((issue) => [issue.id, issue])),
    [issues],
  );

  const directChildCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.parentId) continue;
      counts.set(issue.parentId, (counts.get(issue.parentId) ?? 0) + 1);
    }
    return counts;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues);

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  function handleMobileTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    if (!touch) return;
    mobileSwipeStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleMobileTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const start = mobileSwipeStart.current;
    const touch = event.changedTouches[0];
    mobileSwipeStart.current = null;
    if (!start || !touch || activeId) return;

    setMobileStatus((currentStatus) =>
      resolveMobileSwipeStatus(
        currentStatus,
        touch.clientX - start.x,
        touch.clientY - start.y,
      ),
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {isMobile ? (
      <div data-testid="kanban-mobile-board" className="space-y-3">
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Task status"
        >
          {boardStatuses.map((status) => {
            const selected = status === mobileStatus;
            return (
              <button
                key={status}
                ref={(node) => {
                  mobileTabRefs.current[status] = node;
                }}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setMobileStatus(status)}
              >
                <StatusIcon status={status} />
                <span>{statusLabel(status)}</span>
                <span className="tabular-nums opacity-70">
                  {columnIssues[status]?.length ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div
          data-testid="kanban-mobile-lane"
          className="touch-pan-y"
          onTouchStart={handleMobileTouchStart}
          onTouchEnd={handleMobileTouchEnd}
          onTouchCancel={() => {
            mobileSwipeStart.current = null;
          }}
        >
          <KanbanColumn
            status={mobileStatus}
            issues={columnIssues[mobileStatus] ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
            subtreeLiveCounts={subtreeLiveCounts}
            issueById={issueById}
            directChildCountById={directChildCountById}
            compactCards={compactCards}
            collapsed={false}
            visibleCount={visibleCountByStatus[mobileStatus] ?? initialVisibleCount}
            revealIncrement={revealIncrement}
            mobileFullWidth
            onShowMore={() => {
              setVisibleState((current) => {
                const counts = current.paginationKey === paginationKey ? current.counts : {};
                return {
                  paginationKey,
                  counts: {
                    ...counts,
                    [mobileStatus]: (counts[mobileStatus] ?? initialVisibleCount) + revealIncrement,
                  },
                };
              });
            }}
          />
        </div>
      </div>
      ) : (
      <div data-testid="kanban-desktop-board" className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            liveIssueIds={liveIssueIds}
            subtreeLiveCounts={subtreeLiveCounts}
            issueById={issueById}
            directChildCountById={directChildCountById}
            compactCards={compactCards}
            // Compact mode (any lane explicitly collapsed) also collapses
            // empty lanes to the same labeled rail, so an empty In Progress
            // reads like the other rails instead of a lone expanded column.
            collapsed={collapsedStatusSet.has(status) || (collapsedStatusSet.size > 0 && columnIssues[status].length === 0)}
            visibleCount={visibleCountByStatus[status] ?? initialVisibleCount}
            revealIncrement={revealIncrement}
            onShowMore={() => {
              setVisibleState((current) => {
                const counts = current.paginationKey === paginationKey ? current.counts : {};
                return {
                  paginationKey,
                  counts: {
                    ...counts,
                    [status]: (counts[status] ?? initialVisibleCount) + revealIncrement,
                  },
                };
              });
            }}
          />
        ))}
      </div>
      )}
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay compact={compactCards} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
