// KEE-996 independent verification test for the KEE-579 fix.
//
// Why this file exists: the author's own regression test (issue-patch-assignee-field.test.ts)
// exercises a *mirror* of the route schema plus two source-reading guards. None of its
// behaviour cases load `routes/issues.ts` to make a request. This file mounts the REAL router
// and PATCHes it, so the strictness contract is verified by observed HTTP behaviour rather than
// by a re-declared copy of the schema.
//
// It is deliberately sensitive to the defect: remove `.strict()` from
// `updateIssueRouteSchema` (server/src/routes/issues.ts) and the first two cases go red with
// `expected 200 to be 400`, reproducing the original KEE-579 baseline signature.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => mockExternalObjectService,
}));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>()),
  observeCrossIssueInfluence: vi.fn(async () => null),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw, companyId: "company-1", status: "idle", orgChainHealth: { status: "healthy" } },
    })),
  }),
  companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

function boardActor() {
  return { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
}

function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  return { select: () => query };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor();
    next();
  });
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-996",
    title: "Independent verification",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

const app = () => createApp();
const patchIssue = (body: unknown) => request(app()).patch(`/api/issues/${ISSUE_ID}`).send(body as object);

describe("KEE-996 independent verification: PATCH /api/issues/{id} strictness on the real router", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.update.mockReset();
    mockIssueService.update.mockImplementation(async (_id: string, data: unknown) => makeIssue(data as Record<string, unknown>));
    mockIssueService.addComment.mockReset();
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockHeartbeatService.wakeup.mockClear();
  });

  // THE DEFECT. Pre-fix this returned 200 and assigned nothing, because the bare
  // z.object() stripped the unknown key. Post-fix it must be a loud 400 that names the key.
  it("THE DEFECT: {assigneeId} is 400, names the key, and writes nothing", async () => {
    const res = await patchIssue({ assigneeId: OTHER_UUID });

    expect(res.status).toBe(400);
    const details = res.body?.details as Array<{ code: string; keys?: string[]; message?: string }> | undefined;
    expect(details?.[0]?.code).toBe("unrecognized_keys");
    expect(details?.[0]?.keys).toContain("assigneeId");
    // The real proof: the request must not reach the service layer at all.
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // A stale key must not be able to hide behind a valid one.
  it("a misspelled key beside a valid one still fails loudly", async () => {
    const res = await patchIssue({ status: "in_progress", assigneeId: OTHER_UUID });

    expect(res.status).toBe(400);
    const details = res.body?.details as Array<{ code: string; keys?: string[] }> | undefined;
    expect(details?.[0]?.code).toBe("unrecognized_keys");
    expect(details?.[0]?.keys).toContain("assigneeId");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["assigneeId"],
    ["assignee"],
    ["agentId"],
    ["labels"],
  ])("rejects the unknown key %s", async (key) => {
    const res = await patchIssue({ [key]: "whatever" });
    expect(res.status).toBe(400);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["status", "in_progress"],
    ["title", "renamed"],
    ["priority", "high"],
    ["assigneeAgentId", OTHER_UUID],
    ["assigneeUserId", null],
    ["workMode", "standard"],
    ["projectId", null],
  ])("accepts the legitimate field %s", async (key, value) => {
    const res = await patchIssue({ [key]: value });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty body as a no-op", async () => {
    const res = await patchIssue({});
    expect(res.status).toBe(200);
  });

  // `interrupt` is a route-only field added by .extend() before .strict(). If the
  // strict call were ever moved before the extend, the route would reject its own
  // field. This asserts the field is still recognised.
  it("still recognises the route-only `interrupt` field as a known key", async () => {
    const res = await patchIssue({ interrupt: true });
    const details = res.body?.details as Array<{ code: string; keys?: string[] }> | undefined;
    const wasRejectedAsUnknown = details?.some((d) => d.keys?.includes("interrupt"));
    expect(wasRejectedAsUnknown).toBeFalsy();
  });

  // The interrupt business rule is a pre-existing route guard, not strictness.
  // Pin it so a future change cannot be mistaken for the schema.
  it("`interrupt` without a comment is refused by the route guard, not by strictness", async () => {
    const res = await patchIssue({ interrupt: true });
    expect(res.status).toBe(400);
    expect(res.body?.error).toContain("Interrupt is only supported when posting a comment");
    expect(res.body?.details).toBeUndefined();
  });
});
