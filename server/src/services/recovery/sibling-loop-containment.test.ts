/**
 * KEE-1121 containment proof for the two post-loop passes of
 * `reconcileStrandedAssignedIssues`:
 *
 *   * `reconcileUnassignedBlockingIssues` (orphan-blocker assignment)
 *   * `reconcileActiveRecoveryActions`   (active recovery action reconciliation)
 *
 * ## The defect this pins
 *
 * KEE-1095 contained the *main* per-issue loop of
 * `reconcileStrandedAssignedIssues` and deliberately left these two sibling
 * passes outside its boundary, naming them in the PR's "Not covered" section.
 * Both are per-row loops with no `try` around the loop body, so a single
 * rejected `await` abandons every row behind it, for the whole company, on
 * every 5-minute pass.
 *
 * Measured on fork master `b9d1900a4` with the repo's own `oxc-parser`, not by
 * indentation:
 *
 *   reconcileUnassignedBlockingIssues  ForOf @2174 awaitsInBody=7  try=0
 *   reconcileActiveRecoveryActions      ForOf @3539 awaitsInBody=8  try=0
 *
 * (against, in the same run, KEE-1095's contained loop at
 * `reconcileStrandedAssignedIssues` ForOf @4585 awaitsInBody=90 try=1.)
 *
 * ## How the failure is produced
 *
 * A Postgres fault trigger raises on a chosen write for a chosen row, so the
 * rejection travels the real driver and transaction path with nothing in the
 * recovery service mocked. Two different fault points are used, because the two
 * passes fail at different depths and the difference matters:
 *
 *   * `orphan_comment` faults the `addComment` insert — the *second* write of
 *     the orphan candidate, after the assignee write has already landed. This
 *     is the partial-side-effect case: the row must be reported honestly and
 *     must not be retried blindly.
 *   * `action_resolve` faults the `issue_recovery_actions` status update, which
 *     is the write that would clear the action.
 *
 * ### Why the fault trigger at all
 *
 * The obvious reproduction — a blocking cycle through `assertNoBlockingCycles`
 * — is the same one KEE-1095 already had to abandon. KEE-1087's `nonCyclicChildren`
 * port closed that trigger upstream, so a cycle-based fixture silently goes green
 * while proving nothing. A fault trigger scoped to specific row ids cannot be
 * erased by any upstream refactor, so the tests below stay discriminating.
 *
 * ## What each test pins
 *
 * 1. A failing candidate does not abandon the rest of the orphan queue, and the
 *    surviving pass counts it in `failed`, not in `assigned` or `skipped`.
 * 2. A failing action row does not abandon the rest of the pass.
 * 3. The two passes' failures reach the same `failed` / `failedIssueIds`
 *    counters on the sweep result, so all three passes read alike.
 * 4. Partial side effects are reported, not hidden and not re-applied.
 * 5. Each failure is logged with the offending row's identity.
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
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
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
    `Skipping KEE-1121 sibling-loop containment tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "KEE-1121: the post-loop recovery passes contain a per-row failure",
  () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db: ReturnType<typeof createDb>;
    const companyIds: string[] = [];

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-kee-1121-containment-");
      db = createDb(tempDb.connectionString);
    }, 60_000);

    // Same FK-driven order as the neighbouring KEE-1095 suite: the activity-log
    // and heartbeat-run-event rows reference runs, and runs reference wakeup
    // requests, so the three deletions have to happen in that direction.
    afterEach(async () => {
      vi.clearAllMocks();
      for (const companyId of companyIds.splice(0)) {
        await db.delete(issueComments).where(eq(issueComments.companyId, companyId));
        await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
        await db.delete(issueRelations).where(eq(issueRelations.companyId, companyId));
        await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
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
     * Seeds one company holding two independent groups of work.
     *
     * **Group A — orphan blockers (drives `reconcileUnassignedBlockingIssues`):**
     *
     *   orphan_i (todo, unassigned, created by the agent)  ->blocks->  dep_i
     *
     * This is the only shape that pass acts on: `todo`/`blocked`, no assignee
     * of either kind, a non-null `createdByAgentId`, blocking something still
     * open. One `orphan_i` is listed as the faulted candidate and the rest are
     * healthy, so a surviving pass records one failure *and* assigns the rest.
     *
     * The `dep_i` rows are assigned to the agent and left `in_progress`. They
     * are deliberately not stranded candidates themselves: they have no
     * terminal run, so the main loop ignores them and the two passes under test
     * are the only things that act.
     *
     * **Group B — active recovery actions (drives `reconcileActiveRecoveryActions`):**
     *
     *   action_i on source_i, status active, wake_policy.bounded_recovery_owner
     *
     * A `bounded_owner_disposition_repair` policy would route to
     * `reconcileDispositionRepair`, which schedules its own wakes and needs a
     * terminal run to reason about. `bounded_recovery_owner` with a
     * `source_terminal` issue is the minimal path that reaches a real write:
     * the source issue is `done`, so the row resolves via
     * `resolveActiveForIssue`. One action's resolve is faulted; the rest
     * resolve normally.
     *
     * `withOrphans: false` seeds only Group B. Two tests need a control company
     * with no orphan rows at all, so that a `result` counter can be attributed
     * to one pass rather than to the sweep as a whole — see the note on the
     * shared `skipped` counter in the action test.
     */
    async function seedFixture({ withOrphans = true }: { withOrphans?: boolean } = {}) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const prefix = `S${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      companyIds.push(companyId);

      await db.insert(companies).values({
        id: companyId,
        name: "KEE-1121 Containment Co",
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

      const faultOrphanId = randomUUID();
      const healthyOrphanIds: string[] = [];
      const actionIssueIds: string[] = [];
      const issueRows: (typeof issues.$inferInsert)[] = [];
      let issueNumber = 0;
      const nextNumber = () => (issueNumber += 1);

      // Group A — one faulted orphan blocker plus two healthy ones.
      for (let i = 0; withOrphans && i < 3; i += 1) {
        const orphanId = i === 0 ? faultOrphanId : randomUUID();
        const depId = randomUUID();
        if (i !== 0) healthyOrphanIds.push(orphanId);
        const orphanNumber = nextNumber();
        const depNumber = nextNumber();
        issueRows.push(
          {
            id: orphanId,
            companyId,
            title: `Orphan blocker ${i}`,
            status: "todo",
            priority: "medium",
            createdByAgentId: agentId,
            issueNumber: orphanNumber,
            identifier: `${prefix}-${orphanNumber}`,
          },
          {
            id: depId,
            companyId,
            title: `Live work waiting on orphan ${i}`,
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: agentId,
            issueNumber: depNumber,
            identifier: `${prefix}-${depNumber}`,
          },
        );
      }

      // Group B — three recovery actions whose sources are terminal, so each
      // row reaches `resolveActiveForIssue`. The first is the faulted one.
      for (let i = 0; i < 3; i += 1) {
        const sourceId = randomUUID();
        actionIssueIds.push(sourceId);
        const sourceNumber = nextNumber();
        issueRows.push({
          id: sourceId,
          companyId,
          title: `Recovery source ${i}`,
          status: "done",
          priority: "medium",
          assigneeAgentId: agentId,
          completedAt: new Date("2026-09-30T00:00:00.000Z"),
          issueNumber: sourceNumber,
          identifier: `${prefix}-${sourceNumber}`,
        });
      }

      await db.insert(issues).values(issueRows);

      if (withOrphans) {
        await db.insert(issueRelations).values([
          {
            id: randomUUID(),
            companyId,
            issueId: faultOrphanId,
            relatedIssueId: issueRows.find((r) => r.title === "Live work waiting on orphan 0")!.id!,
            type: "blocks" as const,
          },
          ...healthyOrphanIds.map((orphanId, i) => ({
            id: randomUUID(),
            companyId,
            issueId: orphanId,
            relatedIssueId: issueRows.find(
              (r) => r.title === `Live work waiting on orphan ${i + 1}`,
            )!.id!,
            type: "blocks" as const,
          })),
        ]);
      }

      await db.insert(issueRecoveryActions).values(
        actionIssueIds.map((sourceIssueId, i) => ({
          id: randomUUID(),
          companyId,
          sourceIssueId,
          kind: "takeover",
          status: "active",
          ownerType: "agent",
          ownerAgentId: agentId,
          cause: "agent_stopped_mid_task",
          fingerprint: `kee1121-${i}`,
          evidence: {},
          nextAction: "reconcile",
          wakePolicy: { type: "bounded_recovery_owner" },
        })),
      );

      return {
        companyId,
        agentId,
        faultOrphanId,
        healthyOrphanIds,
        actionIssueIds,
      };
    }

    /**
     * Runs `body` with a Postgres trigger that raises on inserts into
     * `issue_comments` for a specific issue, then removes it again.
     *
     * The comment insert is the *second* write of the orphan candidate, after
     * `issuesSvc.update` has already set the assignee. Faulting here is what
     * makes the partial-side-effect behaviour observable: the assignee write
     * really has landed, and the row must still be reported honestly.
     *
     * The trigger is always dropped in a `finally`, so a failing assertion
     * cannot leak it into the next test.
     */
    async function withCommentFault<T>(issueId: string, body: () => Promise<T>): Promise<T> {
      await db.execute(
        sql.raw(
          `create function kee1121_comment_fault() returns trigger language plpgsql as $$ begin if new.issue_id = '${issueId}'::uuid then raise exception 'kee1121_comment_fault_fixture'; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql`create trigger kee1121_comment_fault before insert on issue_comments for each row execute function kee1121_comment_fault()`,
      );
      try {
        return await body();
      } finally {
        await db.execute(sql`drop trigger if exists kee1121_comment_fault on issue_comments`);
        await db.execute(sql`drop function if exists kee1121_comment_fault()`);
      }
    }

    /**
     * Runs `body` with a Postgres trigger that raises on updates to
     * `issue_recovery_actions` for one specific action id.
     */
    async function withActionResolveFault<T>(actionId: string, body: () => Promise<T>): Promise<T> {
      await db.execute(
        sql.raw(
          `create function kee1121_action_fault() returns trigger language plpgsql as $$ begin if new.id = '${actionId}'::uuid and new.status <> 'active' and old.status = 'active' then raise exception 'kee1121_action_fault_fixture'; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql`create trigger kee1121_action_fault before update on issue_recovery_actions for each row execute function kee1121_action_fault()`,
      );
      try {
        return await body();
      } finally {
        await db.execute(sql`drop trigger if exists kee1121_action_fault on issue_recovery_actions`);
        await db.execute(sql`drop function if exists kee1121_action_fault()`);
      }
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

    /** The contained-failure log lines for one of the two passes. */
    function loggedFailures(fragment: string) {
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
        .filter((entry) => entry.message.includes(fragment));
    }

    const assigneeOf = (issueId: string) =>
      db
        .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

    const actionStatusOf = (sourceIssueId: string) =>
      db
        .select({ status: issueRecoveryActions.status, resolutionNote: issueRecoveryActions.resolutionNote })
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId))
        .then((rows) => rows[0] ?? null);

    it("keeps assigning the rest of the orphan queue when one candidate fails", async () => {
      const fixture = await seedFixture();
      // `RecoveryWakeup` resolves to a `heartbeatRuns` row, but the orphan pass
      // only tests it for truthiness (`if (queued)` at service.ts:2268), so a
      // partial row cast to the inferred type is enough. The mock must return
      // something truthy: a null-returning enqueue means the pass counts every
      // candidate as `skipped`, and `orphanBlockersAssigned` stays 0. Measured,
      // not assumed.
      const recovery = recoveryService(db, {
        enqueueWakeup: vi.fn(async () => ({ id: randomUUID() }) as never),
      });

      // Primary assertion: the pass resolves. Before containment the rejection
      // left `reconcileUnassignedBlockingIssues` and took the sweep with it.
      const result = await withCommentFault(fixture.faultOrphanId, () =>
        recovery.reconcileStrandedAssignedIssues(),
      );

      // The faulted candidate is counted as failed — and, critically, not as
      // assigned or skipped. `skipped` means "deliberately left alone", which
      // would be a false claim here.
      expect(result.failed).toBe(1);
      expect(result.failedIssueIds).toContain(fixture.faultOrphanId);

      // The healthy candidates sit in the same loop and are still assigned.
      // This is "the rest of the queue was not abandoned", stated positively.
      expect(result.orphanBlockersAssigned).toBe(2);
      for (const healthyId of fixture.healthyOrphanIds) {
        expect(result.issueIds).toContain(healthyId);
      }
      // A contained failure is never also reported as acted-on.
      expect(result.issueIds).not.toContain(fixture.faultOrphanId);

      // Honest counters: the faulted row is not folded into the others. Each of the
      // three channels is derived from that pass's own return value, so the
      // arithmetic has to close at exactly the candidate count. (Note that
      // `result.skipped` is the sweep-level counter shared with the main loop,
      // so it cannot be used to attribute the orphan pass on its own — the
      // second, orphan-free fixture in the action test is what isolates it.)
      expect(result.orphanBlockersAssigned).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.orphanBlockersAssigned + result.failed).toBe(3);
    });

    it("does not retry the uncertain assignee write when the later comment fails", async () => {
      const fixture = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      const before = await assigneeOf(fixture.faultOrphanId);
      expect(before?.assigneeAgentId).toBeNull();

      await withCommentFault(fixture.faultOrphanId, () => recovery.reconcileStrandedAssignedIssues());

      // The assignee write genuinely landed before the throw. That is the
      // partial side effect: the row is now assigned but was never commented
      // and never woken, so recovery leaves it alone from now on — the
      // candidate query filters `assigneeAgentId is null`, so it drops out of
      // the set on the next pass rather than being retried.
      const after = await assigneeOf(fixture.faultOrphanId);
      expect(after?.assigneeAgentId).toBe(fixture.agentId);
      expect(after?.status).toBe("todo");

      // No comment was written for it, and no activity row claiming the
      // recovery completed.
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, fixture.faultOrphanId));
      expect(comments).toHaveLength(0);

      const activities = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, fixture.faultOrphanId));
      expect(activities).toHaveLength(0);

      // And it is reported, rather than silently half-done.
      expect(vi.mocked(logger.error).mock.calls.length).toBeGreaterThan(0);
    });

    it("keeps resolving the rest of the recovery actions when one row fails", async () => {
      // No orphan rows in this company, so every sweep counter that moves here
      // is attributable to the recovery-action pass alone. Without that
      // isolation the orphan pass also contributes `skipped`, which would make
      // the "not misreported as a skip" assertion below vacuous.
      const fixture = await seedFixture({ withOrphans: false });
      // Truthy enqueue for the same reason as the orphan test: the `skipped`
      // assertion below is only meaningful once the orphan pass is not itself
      // contributing skips from a null enqueue.
      const recovery = recoveryService(db, {
        enqueueWakeup: vi.fn(async () => ({ id: randomUUID() }) as never),
      });

      const actions = await db
        .select({ id: issueRecoveryActions.id, sourceIssueId: issueRecoveryActions.sourceIssueId })
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.companyId, fixture.companyId));
      expect(actions).toHaveLength(3);
      const faultAction = actions.find((a) => a.sourceIssueId === fixture.actionIssueIds[0])!;

      const result = await withActionResolveFault(faultAction.id, () =>
        recovery.reconcileStrandedAssignedIssues(),
      );

      // The faulted action is contained, counted, and attributed.
      expect(result.failed).toBe(1);
      expect(result.failedIssueIds).toContain(fixture.actionIssueIds[0]);

      // The other two actions still resolved — the pass continued.
      expect(result.continuationRequeued).toBe(0);
      expect(result.escalated).toBe(0);
      for (const sourceIssueId of fixture.actionIssueIds.slice(1)) {
        const row = await actionStatusOf(sourceIssueId);
        expect(row?.status).toBe("resolved");
        expect(row?.resolutionNote).toBe("source_terminal");
      }

      // The faulted one is left active: an unresolved action stays a candidate
      // and is reconsidered next pass. It is not force-resolved and not lost.
      const faulted = await actionStatusOf(fixture.actionIssueIds[0]!);
      expect(faulted?.status).toBe("active");
      expect(faulted?.resolutionNote).toBeNull();

      // And it is not misreported as a deliberate skip.
      expect(result.skipped).toBe(0);
    });

    it("attributes both passes' failures to the same sweep counters", async () => {
      const fixture = await seedFixture();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

      const actions = await db
        .select({ id: issueRecoveryActions.id, sourceIssueId: issueRecoveryActions.sourceIssueId })
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.companyId, fixture.companyId));
      const faultAction = actions.find((a) => a.sourceIssueId === fixture.actionIssueIds[0])!;

      // Both faults are installed at once so a single pass contains one
      // failure from each loop, which is what proves the counters are shared
      // rather than one pass overwriting the other's.
      const body = () => recovery.reconcileStrandedAssignedIssues();
      await db.execute(
        sql.raw(
          `create function kee1121_both_a() returns trigger language plpgsql as $$ begin if new.issue_id = '${fixture.faultOrphanId}'::uuid then raise exception 'kee1121_comment_fault_fixture'; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql`create trigger kee1121_both_a before insert on issue_comments for each row execute function kee1121_both_a()`,
      );
      await db.execute(
        sql.raw(
          `create function kee1121_both_b() returns trigger language plpgsql as $$ begin if new.id = '${faultAction.id}'::uuid and new.status <> 'active' and old.status = 'active' then raise exception 'kee1121_action_fault_fixture'; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql`create trigger kee1121_both_b before update on issue_recovery_actions for each row execute function kee1121_both_b()`,
      );

      try {
        const result = await body();

        // One failure from each loop, in the same result.
        expect(result.failed).toBe(2);
        expect([...result.failedIssueIds].sort()).toEqual(
          [fixture.faultOrphanId, fixture.actionIssueIds[0]!].sort(),
        );

        // Both are logged with their own row identity, under distinct messages.
        const orphanLog = loggedFailures("orphan-blocker recovery failed");
        const actionLog = loggedFailures("active recovery action failed");
        expect(orphanLog).toHaveLength(1);
        expect(actionLog).toHaveLength(1);
        expect(orphanLog[0]!.context.issueId).toBe(fixture.faultOrphanId);
        expect(actionLog[0]!.context.actionId).toBe(faultAction.id);
        expect(orphanLog[0]!.text).toContain("kee1121_comment_fault_fixture");
        expect(actionLog[0]!.text).toContain("kee1121_action_fault_fixture");
      } finally {
        await db.execute(sql`drop trigger if exists kee1121_both_a on issue_comments`);
        await db.execute(sql`drop function if exists kee1121_both_a()`);
        await db.execute(sql`drop trigger if exists kee1121_both_b on issue_recovery_actions`);
        await db.execute(sql`drop function if exists kee1121_both_b()`);
      }
    });
  },
);
