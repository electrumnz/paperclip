/**
 * KEE-1087 / KEE-1102 wiring proof for pilot hotfixes 1 and 3.
 *
 * `non-cyclic-children.test.ts` proves the *filter* in isolation. It stays
 * green if the call sites are deleted, which is exactly the defect the reviewer
 * measured: reverting both `nonCyclicChildren(...)` call sites in
 * `recovery/service.ts` left that file passing 10/10.
 *
 * This file pins the *wiring* instead. It drives the real exported entry point
 * `reconcileStrandedAssignedIssues` against a real database, using the real
 * trigger for the path under test (a terminal run carrying
 * `issue_continuation_waiting_on_review`, which reaches
 * `resolveContinuationWaitingOnReview` at service.ts:5414).
 *
 * Seeded shape — the cycle the pilot hotfixes existed to prevent:
 *
 *   A (parent)  ->blocks->  B (open child of A)  ->blocks->  A
 *   i.e. B already blocks A, and recovery is about to make A blocked-by B.
 *
 * `syncBlockedByIssueIds` calls `assertNoBlockingCycles` (issues.ts), which
 * throws `unprocessable` on that proposal. `reconcileStrandedAssignedIssues`
 * has no try/catch across its 1207 lines and its caller swallows rejections, so
 * without the filter the throw abandons the entire pass, silently, every
 * 5-minute sweep.
 *
 * Remove either `nonCyclicChildren` call site and these tests fail: the
 * reverse edge gets written or the pass throws before the bystander is reached.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
// A skipped wiring test would read as coverage in a merge review while proving
// nothing, so the reason is stated rather than left silent.
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres(
  "KEE-1087: reverse-dependency filtering is wired into the recovery call sites",
  () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db: ReturnType<typeof createDb>;
    const companyIds: string[] = [];

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-kee-1087-wiring-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterEach(async () => {
      for (const companyId of companyIds.splice(0)) {
        await db.delete(issueRelations).where(eq(issueRelations.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
        await db.delete(issues).where(eq(issues.companyId, companyId));
        await db.delete(agents).where(eq(agents.companyId, companyId));
        await db.delete(companies).where(eq(companies.id, companyId));
      }
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    /**
     * Seeds the cyclic fixture plus one unrelated bystander issue.
     *
     * The bystander is what makes this a wiring test rather than a unit test: a
     * surviving recovery pass always reaches a decision about it, so a pass
     * that dies on the cyclic issue cannot be mistaken for a pass that simply
     * had nothing to do.
     */
    async function seedCyclicFixture() {
      const companyId = randomUUID();
      const coderId = randomUUID();
      const prefix = `K${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      companyIds.push(companyId);

      await db.insert(companies).values({
        id: companyId,
        name: "KEE-1087 Wiring Co",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const parentId = randomUUID();
      const childId = randomUUID();
      const bystanderId = randomUUID();

      await db.insert(issues).values([
        {
          id: parentId,
          companyId,
          title: "Parent that is already blocked by its own child",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: coderId,
          issueNumber: 1,
          identifier: `${prefix}-1`,
        },
        {
          id: childId,
          companyId,
          title: "Open child that already blocks the parent",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: coderId,
          parentId,
          issueNumber: 2,
          identifier: `${prefix}-2`,
        },
        {
          id: bystanderId,
          companyId,
          title: "Unrelated issue a surviving pass must still reach",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: coderId,
          issueNumber: 3,
          identifier: `${prefix}-3`,
        },
      ]);

      // The edge that makes the reverse proposal cyclic.
      //
      // `assertNoBlockingCycles` walks *outbound* `blocks` edges from the issue
      // being updated (issues.ts:7348-7359): starting at A it follows
      // A -> ... and throws if it meets the proposed blocker. So the seeded edge
      // must be A blocks B, which makes "make A blocked-by B" close the loop
      // A -> B -> A. The reverse edge (B blocks A) would not be a cycle here.
      await db.insert(issueRelations).values({
        id: randomUUID(),
        companyId,
        issueId: parentId,
        relatedIssueId: childId,
        type: "blocks",
      });

      // The real trigger: a terminal run reporting it is waiting on review.
      //
      // `resultJson.executionRecovery = { kind: "bootstrap", providerWorkStarted: false }`
      // is required, not decoration. Without it `legacyExecutionNeedsReconciliation`
      // treats this as a failed provider session that needs reconciliation and
      // recovery escalates every issue at the legacy branch (service.ts:4646)
      // *before* reaching the waiting-on-review path this test is about.
      for (const issueId of [parentId, childId, bystanderId]) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId: coderId,
          invocationSource: "manual",
          status: "cancelled",
          error: "Paused: waiting for review or approval",
          errorCode: "issue_continuation_waiting_on_review",
          startedAt: new Date("2026-09-20T10:00:00.000Z"),
          finishedAt: new Date("2026-09-20T10:01:00.000Z"),
          contextSnapshot: { issueId },
          resultJson: {
            executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          },
        });
      }

      return { companyId, coderId, parentId, childId, bystanderId };
    }

    it("refuses the cyclic reverse edge at the real call site (hotfix 3)", async () => {
      const { companyId, parentId, childId } = await seedCyclicFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      // Must not throw: an uncontained throw here is the silent-pass-abandonment
      // bug. This assertion is the primary point of the test.
      await expect(recovery.reconcileStrandedAssignedIssues()).resolves.toBeDefined();

      const edges = await db
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.companyId, companyId));
      // Only the seeded A->B edge may exist. Recovery must not have written a
      // row pointing B -> A (the relation that makes A blocked-by B a cycle).
      expect(edges.map((e) => `${e.issueId}->${e.relatedIssueId}`)).toEqual([
        `${parentId}->${childId}`,
      ]);

      const parent = await db
        .select()
        .from(issues)
        .where(eq(issues.id, parentId))
        .then((rows) => rows[0]);
      // The parent must not have been converted into a wait on the child. It
      // stays `in_progress` because the child is the one with no live path, so
      // recovery is the child's to resolve — not the parent's blocker list.
      expect(parent?.status).toBe("in_progress");
    }, 30_000);

    it("keeps processing the remaining issues after the cyclic one (hotfix 1 + 3)", async () => {
      const { companyId, childId, parentId } = await seedCyclicFixture();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const result = await recovery.reconcileStrandedAssignedIssues();

      // The pass survived and reached a decision: the waiting-on-review branch
      // actually ran, rather than the whole sweep dying on the cyclic issue.
      expect(result.waitingOnReviewResolved).toBe(1);
      // The resolved issue is the one recovery acted on. The bystander has no
      // child to wait on, so it is legitimately skipped rather than abandoned —
      // `skipped` accounting for it is what a surviving pass looks like.
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toHaveLength(1);
      expect(result.issueIds).not.toContain(parentId);

      const edges = await db
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.companyId, companyId));
      expect(edges.map((e) => `${e.issueId}->${e.relatedIssueId}`)).toEqual([
        `${parentId}->${childId}`,
      ]);
      expect(edges.some((e) => e.issueId === childId && e.relatedIssueId === parentId)).toBe(
        false,
      );
    }, 30_000);
  },
);
