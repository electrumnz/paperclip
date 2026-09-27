/**
 * KEE-1095 containment proof for `reconcileStrandedAssignedIssues`.
 *
 * ## The defect
 *
 * `reconcileStrandedAssignedIssues` (server/src/services/recovery/service.ts)
 * walks every stranded candidate in one `for` loop and contains **no** `try`
 * anywhere around that loop's body. A single rejected `await` therefore aborts
 * the *entire* pass: every remaining candidate is skipped, nothing is reported
 * in the returned result, and the periodic caller
 * (`trackHeartbeatSchedulerWork` in server/src/index.ts) discards the rejection
 * via `.then(() => undefined, () => undefined)` with no log line. The sweep
 * then repeats the same silent abort every 5 minutes.
 *
 * Measured at fork master `1440ee07e` with a real parser (oxc-parser), not by
 * eye: the function is `4388..5661`, the per-issue loop is `4455..5646`, and the
 * loop body holds 90 `await` expressions against 0 `TryStatement` nodes.
 *
 * ## What these tests pin
 *
 * A pass must survive a per-issue failure, keep processing the issues behind
 * it, say so in its returned result, log each failure with the offending issue's
 * identity, and still run its post-loop recovery passes.
 *
 * ## How the failure is produced
 *
 * The fixture forces a **real** `unprocessable` out of
 * `issues.ts:assertNoBlockingCycles` through the real
 * `resolveContinuationWaitingOnReview` -> `issuesSvc.update({ blockedByIssueIds })`
 * -> `syncBlockedByIssueIds` path. No throw is injected and nothing on the cycle
 * path is mocked, so this stays a regression test for any future await in the
 * loop body, not just for the known cycle trigger.
 *
 * Each parent issue has a child that already blocks it, so recovery's proposal
 * to mark the parent blocked-by that child closes a cycle and throws. Three such
 * parents are seeded, so the pass must record three independent failures — only
 * possible if the loop kept going after the first one died. Before the fix the
 * very first rejection escaped the function and the call rejected.
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

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child(this: unknown) {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { logger } from "../../middleware/logger.js";
import { recoveryService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping KEE-1095 recovery containment tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "KEE-1095: reconcileStrandedAssignedIssues contains a per-issue failure",
  () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db: ReturnType<typeof createDb>;
    const companyIds: string[] = [];

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-kee-1095-containment-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterEach(async () => {
      vi.clearAllMocks();
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
     * Seeds one company with two independent groups of work.
     *
     * **Group 1 — three cyclic parents, each with a child that already blocks
     * it:**
     *
     *   parent_i  ->blocks->  child_i
     *
     * `assertNoBlockingCycles` walks *outbound* `blocks` edges from the issue
     * being updated (issues.ts:7348-7359), so the seeded edge must be
     * "parent blocks child" for "make parent blocked-by child" to close the loop
     * parent -> child -> parent. The reverse orientation is not a cycle there.
     *
     * Every issue carries the terminal run shape that drives the
     * waiting-on-review branch: `errorCode:
     * "issue_continuation_waiting_on_review"`, plus `resultJson.executionRecovery
     * = { kind: "bootstrap", providerWorkStarted: false }`. The second half is
     * load-bearing, not decoration — without it `legacyExecutionNeedsReconciliation`
     * routes the issue to the legacy execution branch and the waiting-on-review
     * path under test is never reached.
     *
     * The parents throw; the children do not. So a surviving pass both records
     * three failures *and* resolves three waits, which is the clearest possible
     * statement that the loop continued rather than stopped.
     *
     * **Group 2 — one unassigned orphan blocker:**
     *
     *   orphan (todo, unassigned, created by the agent)  ->blocks->  dep
     *
     * This is the only shape `reconcileUnassignedBlockingIssues` (the *post-loop*
     * pass at 5648) acts on: `todo`/`blocked`, no assignee, a non-null creator,
     * blocking something still open. It contributes `orphanBlockersAssigned`,
     * which is assigned **only** from that pass's return value. If containment
     * had wrapped the whole function instead of the loop body, a per-issue
     * failure would skip that pass and this counter would stay 0.
     *
     * The candidate query has no ORDER BY, so processing order is not
     * guaranteed. That is deliberate: assertions are order-independent, and
     * three independent recorded failures can only happen if the loop continued
     * past whichever issue it hit first.
     */
    async function seedFixture() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const prefix = `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      companyIds.push(companyId);

      await db.insert(companies).values({
        id: companyId,
        name: "KEE-1095 Containment Co",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const parentIds: string[] = [];
      const childIds: string[] = [];
      const issueRows: (typeof issues.$inferInsert)[] = [];
      const runIssueIds: string[] = [];
      let issueNumber = 0;
      const nextNumber = () => (issueNumber += 1);

      for (let i = 0; i < 3; i += 1) {
        const parentId = randomUUID();
        const childId = randomUUID();
        parentIds.push(parentId);
        childIds.push(childId);
        runIssueIds.push(parentId, childId);
        const parentNumber = nextNumber();
        const childNumber = nextNumber();
        issueRows.push(
          {
            id: parentId,
            companyId,
            title: `Parent ${i} already blocked by its own child`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: parentNumber,
            identifier: `${prefix}-${parentNumber}`,
          },
          {
            id: childId,
            companyId,
            title: `Open child ${i} that already blocks the parent`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            parentId,
            issueNumber: childNumber,
            identifier: `${prefix}-${childNumber}`,
          },
        );
      }

      const orphanId = randomUUID();
      const depId = randomUUID();
      const orphanNumber = nextNumber();
      const depNumber = nextNumber();
      issueRows.push(
        {
          id: orphanId,
          companyId,
          title: "Unassigned issue blocking live work",
          status: "todo",
          priority: "medium",
          createdByAgentId: agentId,
          issueNumber: orphanNumber,
          identifier: `${prefix}-${orphanNumber}`,
        },
        {
          id: depId,
          companyId,
          title: "Live work still waiting on the orphan",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: depNumber,
          identifier: `${prefix}-${depNumber}`,
        },
      );

      await db.insert(issues).values(issueRows);

      await db.insert(issueRelations).values([
        ...parentIds.map((parentId, i) => ({
          id: randomUUID(),
          companyId,
          issueId: parentId,
          relatedIssueId: childIds[i]!,
          type: "blocks" as const,
        })),
        {
          id: randomUUID(),
          companyId,
          issueId: orphanId,
          relatedIssueId: depId,
          type: "blocks" as const,
        },
      ]);

      for (const issueId of runIssueIds) {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId,
          agentId,
          invocationSource: "manual",
          status: "cancelled",
          error: "Paused: waiting for review or approval",
          errorCode: "issue_continuation_waiting_on_review",
          startedAt: new Date("2026-09-27T10:00:00.000Z"),
          finishedAt: new Date("2026-09-27T10:01:00.000Z"),
          contextSnapshot: { issueId },
          resultJson: {
            executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          },
        });
      }

      return { companyId, agentId, parentIds, childIds, orphanId, depId };
    }

    /** The per-issue containment lines, recovered from the mocked logger. */
    function loggedContainmentFailures() {
      return vi
        .mocked(logger.error)
        .mock.calls.map((call) => {
          const [context, message] = call as [unknown, string];
          return {
            message,
            context: (context ?? {}) as Record<string, unknown>,
            text: `${message} ${JSON.stringify(
              (context ?? {}) as Record<string, unknown>,
              (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v),
            )}`,
          };
        })
        .filter((entry) => entry.message.includes("continuing the sweep"));
    }

    it("survives a per-issue failure, keeps processing the rest of the sweep, and reports it", async () => {
      const { parentIds, childIds } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      // The primary assertion: the pass resolves. Before containment this
      // rejected with "Blocking relations cannot contain cycles" and the
      // caller's handler swallowed it with no log line.
      const result = await recovery.reconcileStrandedAssignedIssues();

      // All three parents failed independently. Recording three can only happen
      // if the loop continued past the first rejection, which is the whole point
      // of the containment.
      expect(result.failed).toBe(3);
      expect([...result.failedIssueIds].sort()).toEqual([...parentIds].sort());

      // The three children sit in the same loop and must still be processed
      // normally. This is the "later issues are still processed" requirement
      // stated as a positive outcome rather than an absence of a throw.
      expect(result.waitingOnReviewResolved).toBe(3);
      for (const childId of childIds) {
        expect(result.issueIds).toContain(childId);
      }

      // A contained failure is never also reported as acted-on.
      for (const parentId of parentIds) {
        expect(result.issueIds).not.toContain(parentId);
      }
      expect(result.escalated).toBe(0);
    }, 60_000);

    it("logs each per-issue failure with the offending issue's identity", async () => {
      const { parentIds } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      await recovery.reconcileStrandedAssignedIssues();

      // Not silently discarded: every contained failure reaches the log with the
      // issue id and the underlying error, so an operator can tell which rows are
      // stuck rather than only that something threw.
      const containment = loggedContainmentFailures();
      expect(containment).toHaveLength(3);
      expect(containment.map((e) => e.context.issueId).sort()).toEqual([...parentIds].sort());
      for (const entry of containment) {
        expect(entry.text).toContain("Blocking relations cannot contain cycles");
        expect(entry.context.companyId).toBeTruthy();
        expect(entry.context.identifier).toBeTruthy();
        expect(entry.context.err).toBeTruthy();
      }
    }, 60_000);

    it("does not write the reverse blocking edge that caused the cycle", async () => {
      const { companyId, parentIds, childIds, orphanId, depId } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      await recovery.reconcileStrandedAssignedIssues();

      // Containment must not paper over the cycle by forcing the write through.
      // Only the seeded parent->child edges and the orphan edge may exist.
      const edges = await db
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.companyId, companyId));
      const expected = [
        ...parentIds.map((parentId, i) => `${parentId}->${childIds[i]}`),
        `${orphanId}->${depId}`,
      ];
      expect(edges.map((e) => `${e.issueId}->${e.relatedIssueId}`).sort()).toEqual(
        expected.sort(),
      );
    }, 60_000);

    it("still runs the post-loop recovery pass after a per-issue failure", async () => {
      // `reconcileUnassignedBlockingIssues` runs after the per-issue loop. If
      // containment had wrapped the whole function instead of the loop body, a
      // per-issue failure would skip it and the orphan would stay unassigned.
      const { parentIds, orphanId } = await seedFixture();
      // `assigned` only increments when the wakeup enqueue reports success
      // (service.ts:2235), so this test needs a wakeup that is actually queued.
      // The other tests keep the null-returning mock because they assert on the
      // per-issue counters, which do not depend on the enqueue result.
      //
      // `RecoveryWakeup` resolves to a `heartbeatRuns` row, but the pass only
      // tests it for truthiness, so a partial row cast to the inferred row type
      // is enough and avoids having to satisfy every column.
      const recovery = recoveryService(db, {
        enqueueWakeup: vi.fn(async () => ({ id: randomUUID() }) as never),
      });

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.failed).toBe(3);
      // `orphanBlockersAssigned` is assigned only from the post-loop pass's own
      // return value, so a non-zero value proves that pass ran after the
      // contained failures.
      expect(result.orphanBlockersAssigned).toBe(1);
      expect(result.issueIds).toContain(orphanId);
      expect([...result.failedIssueIds].sort()).toEqual([...parentIds].sort());
    }, 60_000);
  },
);
