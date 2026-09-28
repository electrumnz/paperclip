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
 * A Postgres fault trigger raises on the write that moves a seeded parent to
 * `blocked`, so the rejection travels the real driver and transaction path. No
 * throw is injected and nothing in the recovery path is mocked, so this stays a
 * regression test for any future await in the loop body, not just for the known
 * cycle trigger.
 *
 * ### Why not a blocking cycle
 *
 * Earlier revisions drove the failure with a real cycle: each parent had a child
 * that already blocked it, so `resolveContinuationWaitingOnReview` ->
 * `issuesSvc.update({ blockedByIssueIds })` -> `syncBlockedByIssueIds` ->
 * `assertNoBlockingCycles` threw. That reproduction was genuine and it was 4/4
 * red on the base this branch was first cut from.
 *
 * KEE-1087's `nonCyclicChildren` port then reached fork master (PR #60,
 * `79e69ee24`, now in this branch's base). That helper drops any candidate
 * child already reachable from the parent, so the cycle is never proposed and
 * the fixture went green for the wrong reason: `result.failed` came back `0`
 * instead of `3`. The port closes the one trigger it set out to close, but the
 * per-issue loop still has no `try` around its awaits, so the defect survives
 * and the test no longer proved anything. The fault trigger is used instead
 * because no upstream refactor can make it disappear.
 *
 * The parents throw; the children do not. So a surviving pass both records
 * three failures *and* resolves three waits, which is the clearest possible
 * statement that the loop continued rather than stopped.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
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

    // Deletion order is FK-driven, not stylistic, and it is deliberately the same
    // order the neighbouring `heartbeat-process-recovery.test.ts` uses. Two
    // constraints matter here:
    //
    //   * `activity_log.run_id` and `heartbeat_run_events.run_id` reference
    //     `heartbeat_runs.id` (`ON DELETE no action`, migrations 0001 and 0003),
    //     so the referencing rows must go before the runs.
    //   * `heartbeat_runs.wakeup_request_id` references
    //     `agent_wakeup_requests.id`, so wakeups must go *after* the runs, not
    //     before. The two directions are easy to get backwards; a surviving pass
    //     queues a real wakeup, so both sides of this are exercised.
    afterEach(async () => {
      vi.clearAllMocks();
      for (const companyId of companyIds.splice(0)) {
        await db.delete(issueRelations).where(eq(issueRelations.companyId, companyId));
        await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
        await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
        await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
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
     * **Group 1 — three faulted candidates, each with its own blocker:**
     *
     *   faultBlocker_i  ->blocks->  fault_i
     *
     * A Postgres fault trigger (installed by `withFaults`) makes the write that
     * moves a `fault_i` to `blocked` raise, so each one's recovery work throws
     * for a reason the production code cannot reason its way out of. The other
     * three candidates succeed, so a surviving pass records three failures *and*
     * resolves three waits — the clearest possible statement that the loop
     * continued rather than stopped.
     *
     * ### Why the blocker edge is load-bearing
     *
     * `resolveContinuationWaitingOnReview` returns `null` before any write when
     * `blockedByIssueIds` is empty (service.ts:3011), and it is populated only
     * from `existingUnresolvedBlockerIssues` (an existing `blocks` edge into this
     * issue) or from non-cyclic open children. A candidate with neither is
     * simply skipped and never performs the write the fault would intercept —
     * measured: `failed = 0` with no blocker edge. Every candidate here
     * therefore has its own blocker, which is also what the production data
     * looks like for a dependency wait.
     *
     * ### Why the fault trigger at all
     *
     * An earlier revision forced the failure with a blocking cycle: each parent
     * had a child that already blocked it, so the proposal closed
     * `parent -> child -> parent` and `assertNoBlockingCycles` threw. That was a
     * real reproduction and it was 4/4 red on the base this branch was cut from.
     *
     * It stopped working when KEE-1087's `nonCyclicChildren` port reached fork
     * master (PR #60, `79e69ee24`, now in this branch's base). That helper filters
     * any child already reachable from the parent, so the cycle is never proposed
     * and `failed` came back `0` instead of `3`. The port is working as designed —
     * it closes the one trigger it could prove — but it does not close the *class*
     * of defect, because the per-issue loop still has no `try` around its awaits. A
     * regression test that silently stops exercising the defect is worse than no
     * test, so the fixture is now built on a fault no upstream refactor erases.
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

      const faultIds: string[] = [];
      const faultBlockerIds: string[] = [];
      const healthyIds: string[] = [];
      const healthyBlockerIds: string[] = [];
      const issueRows: (typeof issues.$inferInsert)[] = [];
      let issueNumber = 0;
      const nextNumber = () => (issueNumber += 1);

      // Group 1 — three faulted candidates, each with its own blocker edge.
      for (let i = 0; i < 3; i += 1) {
        const faultId = randomUUID();
        const blockerId = randomUUID();
        faultIds.push(faultId);
        faultBlockerIds.push(blockerId);
        const faultNumber = nextNumber();
        const blockerNumber = nextNumber();
        issueRows.push(
          {
            id: faultId,
            companyId,
            title: `Faulted candidate ${i}`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: faultNumber,
            identifier: `${prefix}-${faultNumber}`,
          },
          {
            id: blockerId,
            companyId,
            title: `Blocker ${i} holding up faulted candidate ${i}`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: blockerNumber,
            identifier: `${prefix}-${blockerNumber}`,
          },
        );
      }

      // Group 2 — three healthy candidates, also with a blocker edge, so the pass
      // has real successful work to do alongside the contained failures.
      for (let i = 0; i < 3; i += 1) {
        const healthyId = randomUUID();
        const blockerId = randomUUID();
        healthyIds.push(healthyId);
        healthyBlockerIds.push(blockerId);
        const healthyNumber = nextNumber();
        const blockerNumber = nextNumber();
        issueRows.push(
          {
            id: healthyId,
            companyId,
            title: `Healthy candidate ${i}`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: healthyNumber,
            identifier: `${prefix}-${healthyNumber}`,
          },
          {
            id: blockerId,
            companyId,
            title: `Blocker ${i} holding up healthy candidate ${i}`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: blockerNumber,
            identifier: `${prefix}-${blockerNumber}`,
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
        ...faultIds.map((faultId, i) => ({
          id: randomUUID(),
          companyId,
          issueId: faultBlockerIds[i]!,
          relatedIssueId: faultId,
          type: "blocks" as const,
        })),
        ...healthyIds.map((healthyId, i) => ({
          id: randomUUID(),
          companyId,
          issueId: healthyBlockerIds[i]!,
          relatedIssueId: healthyId,
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

      // Every candidate needs a stranded terminal run to be picked up at all.
      // `executionRecovery` is load-bearing: without it
      // `legacyExecutionNeedsReconciliation` routes the issue to the legacy
      // execution branch and the waiting-on-review path under test is skipped.
      for (const issueId of [...faultIds, ...healthyIds]) {
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

      return { companyId, agentId, faultIds, healthyIds, orphanId, depId };
    }

    /**
     * Runs `body` with a Postgres trigger that raises whenever an update moves one
     * of `faultIds` to `blocked`, then removes the trigger and function again.
     *
     * The condition is `new.status = 'blocked' and old.status is distinct from
     * 'blocked'`, so the fault fires exactly once per issue, on the write recovery
     * actually performs, and does not fire again if the status is re-asserted. It
     * is raised from the database, not from a mock, so the rejection travels the
     * real driver and transaction path.
     *
     * This is the same idiom the neighbouring `heartbeat-process-recovery.test.ts`
     * uses for its own fault fixture, and the trigger is always removed in a
     * `finally` so a failing assertion cannot leak it into the next test.
     */
    async function withFaults<T>(faultIds: string[], body: () => Promise<T>): Promise<T> {
      const idList = faultIds.map((id) => `'${id}'::uuid`).join(", ");
      await db.execute(
        sql.raw(
          `create function kee1095_fault() returns trigger language plpgsql as $$ begin if new.id in (${idList}) and new.status = 'blocked' and old.status is distinct from 'blocked' then raise exception 'kee1095_fault_fixture'; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql`create trigger kee1095_fault before update on issues for each row execute function kee1095_fault()`,
      );
      try {
        return await body();
      } finally {
        await db.execute(sql`drop trigger if exists kee1095_fault on issues`);
        await db.execute(sql`drop function if exists kee1095_fault()`);
      }
    }

    /**
     * The per-issue containment lines, recovered from the mocked logger.
     *
     * `err` is a wrapped driver error whose `message` is a generic "Failed
     * query: ..." string; the driver's own message ("kee1095_fault_fixture") is
     * one level down in `cause`. `JSON.stringify` cannot be used to read either,
     * because `message` and `cause` are non-enumerable on an `Error`, so the
     * chain is walked explicitly. This is the assertion that the operator-facing
     * log actually carries the underlying cause and not just the wrapper.
     */
    function loggedContainmentFailures() {
      return vi
        .mocked(logger.error)
        .mock.calls.map((call) => {
          const [context, message] = call as [unknown, string];
          return {
            message,
            context: (context ?? {}) as Record<string, unknown>,
            text: errorChainText((context as { err?: unknown } | null)?.err),
          };
        })
        .filter((entry) => entry.message.includes("continuing the sweep"));
    }

    /** Flattens an error and its `cause` chain into one searchable string. */
    function errorChainText(err: unknown): string {
      const parts: string[] = [];
      let current: unknown = err;
      for (let depth = 0; current != null && depth < 10; depth += 1) {
        const asError = current as { message?: unknown; name?: unknown };
        if (typeof asError.message === "string") parts.push(asError.message);
        if (typeof asError.name === "string") parts.push(asError.name);
        current = (current as { cause?: unknown }).cause;
      }
      return parts.join(" | ");
    }

    it("survives a per-issue failure, keeps processing the rest of the sweep, and reports it", async () => {
      const { faultIds, healthyIds } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      // The primary assertion: the pass resolves. Before containment this rejected
      // and the caller's handler swallowed it with no log line.
      const result = await withFaults(faultIds, () =>
        recovery.reconcileStrandedAssignedIssues(),
      );

      // All three faulted issues failed independently. Recording three can only
      // happen if the loop continued past the first rejection, which is the whole
      // point of the containment.
      expect(result.failed).toBe(3);
      expect([...result.failedIssueIds].sort()).toEqual([...faultIds].sort());

      // The three healthy candidates sit in the same loop and must still be
      // processed. This is the "later issues are still processed" requirement
      // stated as a positive outcome rather than an absence of a throw.
      expect(result.waitingOnReviewResolved).toBe(3);
      for (const healthyId of healthyIds) {
        expect(result.issueIds).toContain(healthyId);
      }

      // A contained failure is never also reported as acted-on.
      for (const faultId of faultIds) {
        expect(result.issueIds).not.toContain(faultId);
      }
      expect(result.escalated).toBe(0);
    }, 60_000);

    it("logs each per-issue failure with the offending issue's identity", async () => {
      const { faultIds } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      await withFaults(faultIds, () => recovery.reconcileStrandedAssignedIssues());

      // Not silently discarded: every contained failure reaches the log with the
      // issue id and the underlying error, so an operator can tell which rows are
      // stuck rather than only that something threw.
      const containment = loggedContainmentFailures();
      expect(containment).toHaveLength(3);
      expect(containment.map((e) => e.context.issueId).sort()).toEqual([...faultIds].sort());
      for (const entry of containment) {
        expect(entry.text).toContain("kee1095_fault_fixture");
        expect(entry.context.companyId).toBeTruthy();
        expect(entry.context.identifier).toBeTruthy();
        expect(entry.context.err).toBeTruthy();
      }
    }, 60_000);

    it("leaves no partial write behind for a contained failure", async () => {
      const { companyId, faultIds, healthyIds, orphanId, depId } = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      await withFaults(faultIds, () => recovery.reconcileStrandedAssignedIssues());

      // Containment must not paper over a failed write by forcing it through, and
      // it must not leave a half-applied dependency graph behind either. Every
      // `blocks` edge seeded above must still be there, and nothing extra may have
      // been created for an issue whose update was rejected.
      const edges = await db
        .select()
        .from(issueRelations)
        .where(eq(issueRelations.companyId, companyId));
      expect(edges).toHaveLength(faultIds.length + healthyIds.length + 1);
      for (const faultId of faultIds) {
        expect(edges.some((e) => e.relatedIssueId === faultId)).toBe(true);
      }
      expect(edges.filter((e) => e.relatedIssueId === depId).map((e) => e.issueId)).toEqual([
        orphanId,
      ]);

      // The faulted issues must still be in their original status. If the write
      // were retried or forced past the fault, the row would read `blocked`.
      const rows = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(eq(issues.companyId, companyId));
      for (const faultId of faultIds) {
        expect(rows.find((row) => row.id === faultId)?.status).toBe("in_progress");
      }
      // The healthy ones did move, which is what makes this a real contrast
      // rather than a check that nothing happened at all.
      for (const healthyId of healthyIds) {
        expect(rows.find((row) => row.id === healthyId)?.status).toBe("blocked");
      }
    }, 60_000);

    it("still runs the post-loop recovery pass after a per-issue failure", async () => {
      // `reconcileUnassignedBlockingIssues` runs after the per-issue loop. If
      // containment had wrapped the whole function instead of the loop body, a
      // per-issue failure would skip it and the orphan would stay unassigned.
      const { faultIds, orphanId } = await seedFixture();
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

      const result = await withFaults(faultIds, () =>
        recovery.reconcileStrandedAssignedIssues(),
      );

      expect(result.failed).toBe(3);
      // `orphanBlockersAssigned` is assigned only from the post-loop pass's own
      // return value, so a non-zero value proves that pass ran after the
      // contained failures.
      expect(result.orphanBlockersAssigned).toBe(1);
      expect(result.issueIds).toContain(orphanId);
      expect([...result.failedIssueIds].sort()).toEqual([...faultIds].sort());
    }, 60_000);
  },
);
