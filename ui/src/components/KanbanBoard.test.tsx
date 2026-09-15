// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getKanbanColumnTone,
  KanbanBoard,
  orderKanbanIssues,
  resolveKanbanTargetStatus,
  resolveMobileSwipeStatus,
} from "./KanbanBoard";

const sidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: index === 1 ? "agent-1" : null,
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
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function dispatchTouch(
  element: Element,
  type: "touchstart" | "touchend",
  point: { clientX: number; clientY: number },
) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, type === "touchstart" ? "touches" : "changedTouches", {
    value: [point],
  });
  element.dispatchEvent(event);
}

function swipe(
  element: Element,
  start: { clientX: number; clientY: number },
  end: { clientX: number; clientY: number },
) {
  act(() => {
    dispatchTouch(element, "touchstart", start);
    dispatchTouch(element, "touchend", end);
  });
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveIssueIds={new Set(["issue-todo-1"])}
          onUpdateIssue={vi.fn()}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    sidebarState.isMobile = false;
    document.body.innerHTML = "";
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
    });

    const desktopBoard = container.querySelector('[data-testid="kanban-desktop-board"]');
    expect(desktopBoard?.textContent).toContain("Done");
    expect(desktopBoard?.textContent).toContain("3");
    expect(desktopBoard?.textContent).not.toContain("Issue 1");
  });

  it("shows one selectable status lane in the mobile board", () => {
    sidebarState.isMobile = true;
    const { container } = renderBoard({
      issues: [createIssue(1, "backlog"), createIssue(2, "blocked")],
    });
    const mobileBoard = container.querySelector('[data-testid="kanban-mobile-board"]');
    expect(mobileBoard?.textContent).toContain("Issue 1");
    expect(mobileBoard?.textContent).not.toContain("Issue 2");

    const blockedTab = Array.from(mobileBoard?.querySelectorAll('[role="tab"]') ?? [])
      .find((tab) => tab.textContent?.includes("Blocked"));
    act(() => {
      blockedTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(blockedTab?.getAttribute("aria-selected")).toBe("true");
    expect(mobileBoard?.textContent).toContain("Issue 2");
    expect(mobileBoard?.textContent).not.toContain("Issue 1");
  });

  it("selects the first populated mobile lane when issues arrive after mount", () => {
    sidebarState.isMobile = true;
    const { container, render } = renderBoard({ issues: [] });

    const initialBacklogTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.textContent?.includes("Backlog"));
    expect(initialBacklogTab?.getAttribute("aria-selected")).toBe("true");

    render({ issues: [createIssue(2, "todo")] });

    const mobileBoard = container.querySelector('[data-testid="kanban-mobile-board"]');
    expect(mobileBoard?.textContent).toContain("Issue 2");
    const todoTab = Array.from(mobileBoard?.querySelectorAll('[role="tab"]') ?? [])
      .find((tab) => tab.textContent?.includes("Todo"));
    expect(todoTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("swipes between adjacent mobile lanes without hijacking vertical scrolling", () => {
    sidebarState.isMobile = true;
    const { container } = renderBoard({
      issues: [
        createIssue(1, "backlog"),
        createIssue(2, "todo"),
        createIssue(3, "in_progress"),
      ],
    });
    const mobileBoard = container.querySelector('[data-testid="kanban-mobile-board"]');
    const mobileLane = container.querySelector('[data-testid="kanban-mobile-lane"]');
    expect(mobileLane).toBeTruthy();

    swipe(
      mobileLane!,
      { clientX: 280, clientY: 120 },
      { clientX: 120, clientY: 128 },
    );

    const todoTab = Array.from(mobileBoard?.querySelectorAll('[role="tab"]') ?? [])
      .find((tab) => tab.textContent?.includes("Todo"));
    expect(todoTab?.getAttribute("aria-selected")).toBe("true");
    expect(mobileBoard?.textContent).toContain("Issue 2");
    expect(mobileBoard?.textContent).not.toContain("Issue 1");

    swipe(
      mobileLane!,
      { clientX: 180, clientY: 100 },
      { clientX: 190, clientY: 250 },
    );
    expect(todoTab?.getAttribute("aria-selected")).toBe("true");

    swipe(
      mobileLane!,
      { clientX: 120, clientY: 125 },
      { clientX: 280, clientY: 120 },
    );
    const backlogTab = Array.from(mobileBoard?.querySelectorAll('[role="tab"]') ?? [])
      .find((tab) => tab.textContent?.includes("Backlog"));
    expect(backlogTab?.getAttribute("aria-selected")).toBe("true");
    expect(mobileBoard?.textContent).toContain("Issue 1");
  });

  it("clamps mobile swipes at the first and last lanes", () => {
    expect(resolveMobileSwipeStatus("backlog", 160, 0)).toBe("backlog");
    expect(resolveMobileSwipeStatus("cancelled", -160, 0)).toBe("cancelled");
    expect(resolveMobileSwipeStatus("todo", -20, 0)).toBe("todo");
    expect(resolveMobileSwipeStatus("todo", -160, 150)).toBe("todo");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "cancelled"),
    });

    const card = container.querySelector('a[href="/issues/PAP-1"]')?.parentElement;

    expect(card?.className).toContain("bg-muted/35");
    expect(card?.className).toContain("opacity-80");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("nests same-lane children directly below their parent", () => {
    const parent = { ...createIssue(1, "todo"), title: "Launch mobile portal" };
    const child = {
      ...createIssue(2, "todo"),
      title: "Polish task board",
      parentId: parent.id,
    };
    const unrelated = { ...createIssue(3, "todo"), title: "Independent task" };

    const ordered = orderKanbanIssues([child, unrelated, parent]);
    expect(ordered.map(({ issue }) => issue.id)).toEqual([
      unrelated.id,
      parent.id,
      child.id,
    ]);
    expect(ordered.map(({ depth }) => depth)).toEqual([0, 0, 1]);

    const { container } = renderBoard({ issues: [child, unrelated, parent] });
    const shells = Array.from(container.querySelectorAll('[data-testid="kanban-card-shell"]'));
    const parentShell = shells.find((shell) => shell.getAttribute("data-issue-id") === parent.id);
    const childShell = shells.find((shell) => shell.getAttribute("data-issue-id") === child.id);

    expect(childShell?.getAttribute("data-depth")).toBe("1");
    expect(childShell?.textContent).not.toContain("Child of");
    expect(parentShell?.textContent).toContain("1 subtask");
    expect(shells.indexOf(childShell!)).toBe(shells.indexOf(parentShell!) + 1);
  });

  it("shows parent context for a child whose parent is in another lane", () => {
    const parent = { ...createIssue(1, "in_progress"), title: "Parent in progress" };
    const child = {
      ...createIssue(2, "blocked"),
      title: "Blocked child",
      parentId: parent.id,
    };

    const { container } = renderBoard({ issues: [child, parent] });
    const childShell = container.querySelector(`[data-issue-id="${child.id}"]`);
    const parentLink = childShell?.querySelector('[data-testid="kanban-parent-context"]');

    expect(childShell?.getAttribute("data-depth")).toBe("0");
    expect(childShell?.textContent).toContain("Child ofPAP-1Parent in progress");
    expect(parentLink?.getAttribute("href")).toBe("/issues/PAP-1");
  });

  it("colours parent context from the parent status, even when the child is live", () => {
    const parent = { ...createIssue(113, "blocked"), title: "Blocked parent" };
    const child = {
      ...createIssue(115, "in_progress"),
      title: "Live child",
      parentId: parent.id,
      blocks: [{
        id: parent.id,
        identifier: parent.identifier,
        title: parent.title,
        status: parent.status,
        priority: parent.priority,
        assigneeAgentId: parent.assigneeAgentId,
        assigneeUserId: parent.assigneeUserId,
      }],
    };

    const { container } = renderBoard({
      issues: [child, parent],
      liveIssueIds: new Set([child.id]),
      compactCards: true,
    });
    const childShell = container.querySelector(`[data-issue-id="${child.id}"]`);
    const parentContext = childShell?.querySelector('[data-testid="kanban-parent-context"]');

    expect(parentContext?.getAttribute("data-related-status")).toBe("blocked");
    expect(parentContext?.className).toContain("text-red-600");
    expect(parentContext?.className).not.toContain("bg-red");
    expect(parentContext?.className).not.toContain("border-red");
    expect(parentContext?.textContent).toContain("Child ofPAP-113Blocked parent");
    expect(childShell?.querySelector('[data-testid="kanban-blocking-context"]')?.textContent)
      .toContain("BlockingPAP-113Blocked parent");
    expect(childShell?.textContent).toContain("Live");
  });

  it("shows clickable tasks this card is blocking at the bottom", () => {
    const issue = {
      ...createIssue(1, "in_progress"),
      title: "Prepare release",
      blocks: [
        {
          id: "blocked-active",
          identifier: "PAP-8",
          title: "Ship release",
          status: "in_review" as const,
          priority: "high" as const,
          assigneeAgentId: null,
          assigneeUserId: null,
        },
        {
          id: "blocked-done",
          identifier: "PAP-9",
          title: "Publish notes",
          status: "done" as const,
          priority: "medium" as const,
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
    };

    const { container } = renderBoard({ issues: [issue] });
    const blockingLinks = Array.from(container.querySelectorAll('[data-testid="kanban-blocking-context"]'));

    expect(blockingLinks).toHaveLength(2);
    expect(blockingLinks[0]?.textContent).toContain("BlockingPAP-8Ship release");
    expect(blockingLinks[0]?.getAttribute("href")).toBe("/issues/PAP-8");
    expect(blockingLinks[1]?.textContent).toContain("BlockingPAP-9Publish notes");
    expect(blockingLinks[1]?.className).toContain("text-green-600");
  });

  it("does not repeat a blocked task that is already nested beneath this card", () => {
    const blocking = {
      ...createIssue(1, "blocked"),
      blocks: [{
        id: "issue-blocked-2",
        identifier: "PAP-2",
        title: "Nested blocked task",
        status: "blocked" as const,
        priority: "medium" as const,
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    };
    const nestedBlocker = {
      ...createIssue(2, "blocked"),
      title: "Nested blocked task",
      parentId: blocking.id,
    };

    const { container } = renderBoard({ issues: [blocking, nestedBlocker] });
    const blockingShell = container.querySelector(`[data-issue-id="${blocking.id}"]`);

    expect(blockingShell?.querySelector('[data-testid="kanban-blocking-context"]')).toBeNull();
    expect(container.querySelector(`[data-issue-id="${nestedBlocker.id}"]`)?.getAttribute("data-depth")).toBe("1");
  });

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });
});
