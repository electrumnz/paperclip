import { describe, expect, it } from "vitest";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  crossIssueInfluenceLimitError,
  evaluateCrossIssueInfluenceLimit,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.ts";

function counterDb(
  initialCount = 0,
  runOverrides: Record<string, unknown> | null = {},
  wakeupRequest: { requestedByActorType: string | null } | null = null,
) {
  let observedCount = initialCount;
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (Object.keys(selection).includes("count")) {
            return {
              then: (resolve: (rows: unknown[]) => unknown) => resolve([{ count: observedCount }]),
            };
          }
          // KEE-586: the wakeup-request lookup is keyed by its own projection.
          if (Object.keys(selection).includes("requestedByActorType")) {
            return {
              limit: () => ({
                then: (resolve: (rows: unknown[]) => unknown) => resolve(
                  wakeupRequest ? [{ requestedByActorType: wakeupRequest.requestedByActorType }] : [],
                ),
              }),
            };
          }
          return {
            for: () => ({
              then: (resolve: (rows: unknown[]) => unknown) => resolve(runOverrides === null ? [] : [{
                id: "11111111-1111-4111-8111-111111111111",
                companyId: "22222222-2222-4222-8222-222222222222",
                agentId: "33333333-3333-4333-8333-333333333333",
                responsibleUserId: "user-1",
                invocationSource: "on_demand",
                contextSnapshot: { issueId: "44444444-4444-4444-8444-444444444444" },
                // No wakeup request unless a test opts in, so the board_dispatch
                // path is only reachable by naming an initiator explicitly.
                wakeupRequestId: null,
                ...runOverrides,
              }]),
            }),
          };
        },
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value);
        if (value.action === "issue.cross_issue_influence_observed") observedCount += 1;
      },
    }),
  };
  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    },
    inserted,
    get observedCount() {
      return observedCount;
    },
  };
}

const BOARD_WAKE_ID = "66666666-6666-4666-8666-666666666666";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ISSUE_ID = "55555555-5555-4555-8555-555555555555";

describe("cross-issue influence limit rollout", () => {
  it("logs observations without enforcement during the one-week rollout", () => {
    const decision = evaluateCrossIssueInfluenceLimit({
      priorCount: CROSS_ISSUE_INFLUENCE_LIMIT,
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    });

    expect(decision).toMatchObject({
      allowed: true,
      mode: "log_only",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("allows the twentieth influence and fails closed on the twenty-first after the flip", () => {
    const now = CROSS_ISSUE_INFLUENCE_ENFORCE_AT;
    expect(evaluateCrossIssueInfluenceLimit({ priorCount: 19, now })).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 20,
      cap: 20,
    });

    const rejected = evaluateCrossIssueInfluenceLimit({ priorCount: 20, now });
    expect(rejected).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: 21,
      cap: 20,
    });
    const capError = crossIssueInfluenceLimitError(rejected, {
      actorLabel: "Fable",
      issueIdentifier: "TASK-482",
    });
    expect(capError.details).toMatchObject({
      code: "cross_issue_influence_cap_exceeded",
      cap: 20,
      count: 21,
      mode: "enforce",
      enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
    });
    // Plan §6: the 429 names the boundary, who can act, and the way forward.
    expect(capError.error).toContain("20");
    expect(capError.error).toContain("Who can act:");
    expect(capError.error).toContain("Try this:");
    expect(capError.error).toContain("next heartbeat");
    expect(capError.details.boundary).toContain("20");
    expect(capError.details.whoCanAct).toContain("Fable");
  });

  it("uses one durable counter for cross-issue comments, PATCH updates, and interaction resolutions", async () => {
    const fake = counterDb();
    const base = {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      now: new Date(CROSS_ISSUE_INFLUENCE_ENFORCE_AT.getTime() - 1),
    } as const;

    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "comment" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "update" }))
      .resolves.toMatchObject({ count: 2, allowed: true });
    await expect(observeCrossIssueInfluence(fake.db as never, { ...base, kind: "interaction_resolution" }))
      .resolves.toMatchObject({ count: 3, allowed: true });

    expect(fake.observedCount).toBe(3);
    expect(fake.inserted.map((row) => (row.details as { kind: string }).kind))
      .toEqual(["comment", "update", "interaction_resolution"]);
  });

  it("counts an interaction resolution against a budget already spent on comments", async () => {
    const fake = counterDb(CROSS_ISSUE_INFLUENCE_LIMIT);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "interaction_resolution",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({ action: "issue.cross_issue_influence_cap_rejected" }),
    ]);
  });

  it("does not count same-issue writes", async () => {
    const fake = counterDb(0, {
      contextSnapshot: { issueId: "55555555-5555-4555-8555-555555555555" },
    });
    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).resolves.toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("counts every write from a verified unscoped heartbeat timer run", async () => {
    const fake = counterDb(0, {
      invocationSource: "timer",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
      },
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 1,
    });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({
          sourceKind: "heartbeat_timer",
          sourceIssueId: null,
        }),
      }),
    ]);
  });

  it("does not trust timer markers on a non-timer run", async () => {
    const fake = counterDb(0, {
      invocationSource: "on_demand",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
      },
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      // Spoofed timer markers leave this run with no sourceKind at all, and
      // its context is fixed for its lifetime — so no header can rescue it
      // and it now takes the KEE-567 run_not_issue_scoped code.
      details: { code: "cross_issue_influence_run_not_issue_scoped" },
    });
    expect(fake.inserted).toEqual([]);
  });

  // KEE-601: PR #8's split of the 403 wrote its throw against the pre-KEE-159
  // file and fired on `!sourceIssueId`, which is true for the legitimate
  // heartbeat_timer run too. This is the regression this rebase must not
  // reintroduce: an unscoped verified timer run is still allowed, and the new
  // permanent code must not swallow it.
  it("still allows an unscoped heartbeat timer run through the KEE-567 not-issue-scoped throw", async () => {
    const fake = counterDb(0, {
      invocationSource: "timer",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
      },
    });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true, mode: "enforce", count: 1 });
    expect(fake.inserted).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({
          sourceKind: "heartbeat_timer",
          sourceIssueId: null,
        }),
      }),
    ]);
  });

  it.each([
    ["missing", null],
    ["wrong-agent", { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wrong-company", { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
  ] as const)("fails closed for a %s locked run", async (_label, runOverrides) => {
    const fake = counterDb(0, runOverrides);

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed before querying for a malformed run id", async () => {
    const fake = counterDb();

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "attacker-controlled-run-id",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_context_required" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("fails closed with a distinct code when the persisted run has no source issue", async () => {
    const fake = counterDb(0, { contextSnapshot: {} });

    await expect(observeCrossIssueInfluence(fake.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "update",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_not_issue_scoped" },
    });
    expect(fake.inserted).toEqual([]);
  });

  it("gives an unanchored run a different code from a missing or mismatched run, since the header fix only works for the latter", async () => {
    const unanchored = counterDb(0, { contextSnapshot: {} });
    const missingRun = counterDb(0, null);

    const unanchoredRejection = await observeCrossIssueInfluence(unanchored.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    }).catch((error) => error);
    const missingRunRejection = await observeCrossIssueInfluence(missingRun.db as never, {
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "11111111-1111-4111-8111-111111111111",
      agentId: "33333333-3333-4333-8333-333333333333",
      targetIssueId: "55555555-5555-4555-8555-555555555555",
      kind: "comment",
    }).catch((error) => error);

    expect(unanchoredRejection.details.code).toBe("cross_issue_influence_run_not_issue_scoped");
    expect(missingRunRejection.details.code).toBe("cross_issue_influence_run_context_required");
    expect(unanchoredRejection.details.code).not.toBe(missingRunRejection.details.code);
    // The unanchored copy must not claim the header retry works — that is the KEE-567 defect.
    expect(unanchoredRejection.message).not.toContain("X-Paperclip-Run-Id");
  });

  // KEE-586 — the third unscoped class. The card's acceptance criterion is a pair,
  // not a single positive: a board-dispatched on_demand wake must be admitted AND
  // a non-board on_demand wake of the same invocation must still be refused.
  describe("board-dispatched unscoped wakes (KEE-586)", () => {
    const boardOnDemandRun = {
      invocationSource: "on_demand",
      wakeupRequestId: BOARD_WAKE_ID,
      contextSnapshot: {
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        triggeredBy: "board",
        actorId: "local-board",
        wakeReason: "manual",
      },
    };

    it("admits an unanchored on_demand wake dispatched by a user actor", async () => {
      const fake = counterDb(0, boardOnDemandRun, { requestedByActorType: "user" });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      })).resolves.toMatchObject({
        allowed: true,
        mode: "enforce",
        count: 1,
      });
      // Admitted, but still counted: this is a rate backstop, not a licence.
      expect(fake.inserted).toEqual([
        expect.objectContaining({
          action: "issue.cross_issue_influence_observed",
          details: expect.objectContaining({
            sourceKind: "board_dispatch",
            sourceIssueId: null,
          }),
        }),
      ]);
    });

    it("still refuses an identical-looking on_demand wake whose initiator is an agent", async () => {
      const fake = counterDb(0, boardOnDemandRun, { requestedByActorType: "agent" });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "comment",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_issue_scoped" },
      });
      expect(fake.inserted).toEqual([]);
    });

    it("still refuses a scheduler-dispatched run that merely claims the board marker", async () => {
      // The measured case: 285 unscoped runs carry contextSnapshot.triggeredBy
      // "board" while their wakeup row says "system". The JSON field must not be
      // authority on its own.
      const fake = counterDb(0, {
        ...boardOnDemandRun,
        invocationSource: "automation",
        contextSnapshot: { ...boardOnDemandRun.contextSnapshot, wakeSource: "automation" },
      }, { requestedByActorType: "system" });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "update",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_issue_scoped" },
      });
      expect(fake.inserted).toEqual([]);
    });

    it("fails closed when the run has no wakeup request to authenticate an initiator", async () => {
      // No wakeupRequestId means no service-written initiator of record, so the
      // board marker in the payload is uncorroborated.
      const fake = counterDb(0, { ...boardOnDemandRun, wakeupRequestId: null }, null);

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "comment",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_issue_scoped" },
      });
      expect(fake.inserted).toEqual([]);
    });

    it("fails closed when the wakeup request records no initiator at all", async () => {
      const fake = counterDb(0, boardOnDemandRun, { requestedByActorType: null });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "comment",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_issue_scoped" },
      });
      expect(fake.inserted).toEqual([]);
    });

    it("does not let a user initiator launder a run whose own marker is not the board", async () => {
      // Belt-and-braces: a user-actor row paired with an agent marker is still not
      // a board dispatch, and must not become one.
      const fake = counterDb(0, {
        ...boardOnDemandRun,
        contextSnapshot: { ...boardOnDemandRun.contextSnapshot, triggeredBy: "agent" },
      }, { requestedByActorType: "user" });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "comment",
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_influence_run_not_issue_scoped" },
      });
      expect(fake.inserted).toEqual([]);
    });

    it("keeps the heartbeat timer allowance intact and independent of the initiator column", async () => {
      // KEE-601's regression guard: the timer class is classified by its own
      // structural markers and must not be affected by the KEE-586 join.
      const fake = counterDb(0, {
        invocationSource: "timer",
        contextSnapshot: { wakeReason: "heartbeat_timer", wakeSource: "timer" },
      }, { requestedByActorType: "system" });

      await expect(observeCrossIssueInfluence(fake.db as never, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        agentId: AGENT_ID,
        targetIssueId: TARGET_ISSUE_ID,
        kind: "update",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      })).resolves.toMatchObject({ allowed: true, count: 1 });
      expect(fake.inserted).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ sourceKind: "heartbeat_timer" }),
        }),
      ]);
    });
  });
});
