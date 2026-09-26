import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * KEE-916 integration coverage.
 *
 * The report traced this path but explicitly did not reproduce it, so this
 * test exists to settle reachability rather than to re-assert the trace. The
 * defect: the status-commit projection wrote `unblockDescriptor`
 * unconditionally, so a card that was *already* `blocked` and carried a valid
 * agent-owned descriptor had its owner replaced by a board-owned one. Because
 * `deliverAgentUnblockNotification` only wakes agent-owned descriptors, the
 * agent responsible for the block silently stopped being woken.
 *
 * `assertTransition` returns early when `from === to`, which is what lets the
 * displacing write through on an already-`blocked` card.
 */
describe("status commit does not displace an existing unblock descriptor", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-kee-916-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "KEE-916", issuePrefix: "K916" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Responsible agent",
      adapterType: "codex_local",
      status: "running",
    });
  }, 60_000);

  afterAll(async () => temporary?.cleanup());

  /**
   * Seeds a card that is already `blocked` and already carries
   * `existingDescriptor`, plus the native finalization records the committer
   * requires, then commits a board-owned `blocked` decision over it.
   */
  async function commitBlockedDecisionOverExistingDescriptor(
    existingDescriptor: { owner: { agentId: string } | { userId: string } | "board"; action: string } | null,
    blockerOwner: { agentId: string } | "board" = "board",
  ) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "already blocked",
      status: "blocked",
      assigneeAgentId: agentId,
      workMode: "standard",
      ...(existingDescriptor ? { unblockDescriptor: existingDescriptor } : {}),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      contextSnapshot: { issueId },
      completionContractId: contractId,
      completionContractSha256: `contract:${issueId}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "kee-916-v1", criteria: [{ id: "objective", requirement: "kee-916" }] },
      canonicalSha256: `contract:${issueId}`,
      createdByActorType: "system",
      createdByActorId: "kee-916",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${issueId}`,
      schemaStatus: "accepted",
      resultJson: { fixtureId: "kee-916" },
      canonicalSha256: `result:${issueId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "blocked",
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: { fixtureId: "kee-916" },
      inputDigest: `assessment:${issueId}`,
      createdAt: new Date(),
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });

    // Exactly what `status-arbiter` emits for a `blocked` decision.
    const blockerAction =
      blockerOwner === "board" ? "Board-owned action that must not land." : "Agent-owned action.";
    const committed = await commitNativeStatusDecision({
      db,
      companyId,
      issueId,
      runId,
      assessmentId,
      priorStatus: "blocked",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision: {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "current_track_blocker_waiting",
        unblockDescriptor: { owner: blockerOwner, action: blockerAction },
        effects: [{ kind: "bind_blocker", owner: blockerOwner, action: blockerAction }],
      },
    });

    const persisted = await db
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    // A block committed to an agent must actually wake that agent. The issue is
    // carried in the jsonb payload, there is no `issueId` column.
    const wakeAgentIds = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        ),
      )
      .then((rows) => rows.map((row) => row.agentId));

    return { committed, persisted, wakeAgentIds };
  }

  it("keeps an existing agent-owned descriptor on an already-blocked card", async () => {
    const existing = { owner: { agentId }, action: "Re-run the failed migration." };
    const { persisted } = await commitBlockedDecisionOverExistingDescriptor(existing);

    expect(persisted?.status).toBe("blocked");
    // The responsible agent keeps the wake route; no displacement.
    expect(persisted?.unblockDescriptor).toEqual(existing);
  });

  it("keeps an existing user-owned descriptor on an already-blocked card", async () => {
    const existing = { owner: { userId: "user-1" }, action: "Decide on the schema change." };
    const { persisted } = await commitBlockedDecisionOverExistingDescriptor(existing);

    expect(persisted?.unblockDescriptor).toEqual(existing);
  });

  it("attaches a board-owned descriptor when the blocked card has none", async () => {
    const { persisted } = await commitBlockedDecisionOverExistingDescriptor(null);

    expect(persisted?.status).toBe("blocked");
    expect(persisted?.unblockDescriptor).toEqual({
      owner: "board",
      action: "Board-owned action that must not land.",
    });
  });

  it("attaches an agent-owned bind_blocker to a blocked card that has no descriptor", async () => {
    // A `bind_blocker` may name an agent rather than the board. The guard must
    // not rewrite that as board-owned: `deliverAgentUnblockNotification` only
    // wakes agent-owned descriptors, so doing so would silently stop the agent
    // that was just given the block from ever being woken for it.
    const { persisted, wakeAgentIds } =
      await commitBlockedDecisionOverExistingDescriptor(null, { agentId });

    expect(persisted?.status).toBe("blocked");
    expect(persisted?.unblockDescriptor).toEqual({
      owner: { agentId },
      action: "Agent-owned action.",
    });
    // The owner must actually be woken, not just labelled.
    expect(wakeAgentIds).toContain(agentId);
  });
});
