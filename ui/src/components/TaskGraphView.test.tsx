// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTaskGraphLayout, TaskGraphView } from "./TaskGraphView";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function createIssue(index: number, status: IssueStatus, parentId: string | null = null): Issue {
  const createdAt = new Date(`2026-09-${String(index).padStart(2, "0")}T00:00:00.000Z`);
  return {
    id: `issue-${index}`,
    identifier: `KEE-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId,
    title: `Task ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt,
    updatedAt: createdAt,
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function renderGraph(issues: Issue[], liveIssueIds = new Set<string>()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  flushSync(() => root.render(<TaskGraphView issues={issues} liveIssueIds={liveIssueIds} />));
  return container;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) flushSync(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("TaskGraphView", () => {
  it("lays out child and blocker targets after their source nodes", () => {
    const parent = createIssue(1, "in_progress");
    const child = createIssue(2, "todo", parent.id);
    const blocked = {
      ...createIssue(3, "blocked"),
      blockedBy: [{
        id: child.id,
        identifier: child.identifier,
        title: child.title,
        status: child.status,
        priority: child.priority,
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    };

    const layout = buildTaskGraphLayout([blocked, child, parent]);
    const nodeById = new Map(layout.nodes.map((node) => [node.issue.id, node]));
    expect(nodeById.get(child.id)!.x).toBeGreaterThan(nodeById.get(parent.id)!.x);
    expect(nodeById.get(blocked.id)!.x).toBeGreaterThan(nodeById.get(child.id)!.x);
    expect(layout.edges.map((edge) => edge.kind).sort()).toEqual(["blocker", "child"]);
  });

  it("renders clickable nodes, graph controls, liveness, and both connection styles", () => {
    const parent = createIssue(1, "in_progress");
    const child = {
      ...createIssue(2, "blocked", parent.id),
      blockedBy: [{
        id: parent.id,
        identifier: parent.identifier,
        title: parent.title,
        status: parent.status,
        priority: parent.priority,
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    };
    const container = renderGraph([parent, child], new Set([parent.id]));

    expect(container.querySelectorAll('[data-testid="task-graph-node"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="task-graph-node"][href="/issues/KEE-1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Live"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(container.querySelector('path[marker-end="url(#task-graph-arrow)"]')).not.toBeNull();
    expect(container.querySelector('path[marker-end="url(#task-graph-blocker-arrow)"]')).not.toBeNull();
  });

  it("shows a useful empty state", () => {
    expect(renderGraph([]).textContent).toContain("No tasks match");
  });
});
