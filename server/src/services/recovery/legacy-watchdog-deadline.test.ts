import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  terminalizeLegacyExecution,
  LEGACY_RECOVERY_CAUSE,
  LEGACY_WATCHDOG_DEADLINE_MS,
  LEGACY_WATCHDOG_TIMEOUT_SETTLER,
} from "../legacy-execution-recovery.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { recoveryService } from "./service.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "legacy execution watchdog deadline and settler",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    beforeAll(async () => {
      if (externalDatabaseUrl) {
        db = createDb(externalDatabaseUrl);
        return;
      }
      database = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-deadline-");
      db = createDb(database.connectionString);
    }, 30_000);

    afterEach(async () => {
      await db.execute(sql`TRUNCATE companies CASCADE`);
    });

    afterAll(async () => {
      if (externalDatabaseUrl) await db?.$client.end();
      else await database?.cleanup();
    });

    /** A non-native run in a terminal state, which is what the watchdog wraps. */
    async function seedTerminalLegacyRun() {
      await db.insert(companies).values({
        id: companyId,
        name: "Watchdog",
        issuePrefix: "WD",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Runner",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Card that looked like a slow reviewer",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId,
          nativeIssueId: issueId,
          contextSnapshot: { issueId },
          status: "running",
          errorCode: null,
        })
        .returning();
      return run!;
    }

    /**
     * `recoveryService` requires a wakeup dependency. The settler never
     * enqueues one (it settles, it does not reschedule), so a stub is enough —
     * but the argument is required, and omitting it is a type error that only
     * CI catches, because vitest transpiles without checking types.
     */
    function createSettler() {
      return recoveryService(db, { enqueueWakeup: vi.fn() });
    }

    async function readAction() {
      const [row] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      return row ?? null;
    }

    it("writes a deadline and names the settler at creation", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });

      const action = await readAction();
      expect(action).not.toBeNull();
      expect(action!.kind).toBe("active_run_watchdog");
      expect(action!.cause).toBe(LEGACY_RECOVERY_CAUSE);
      expect(action!.ownerType).toBe("board");
      expect(action!.timeoutAt).toBeInstanceOf(Date);
      expect(
        (action!.evidence as Record<string, any>).watchdogDeadline.settler,
      ).toBe(LEGACY_WATCHDOG_TIMEOUT_SETTLER);
    });

    /**
     * The naive fix is "set timeoutAt" alone. That is the same deadlock with a
     * date printed on it, so the guard must reject it at authoring time rather
     * than persisting a deadline nothing reads.
     */
    it("refuses a timeoutAt that names no settler", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      await db.execute(sql`TRUNCATE companies CASCADE`);
      const secondCompany = randomUUID();
      const secondAgent = randomUUID();
      const secondIssue = randomUUID();
      await db.insert(companies).values({
        id: secondCompany,
        name: "Trap",
        issuePrefix: "TP",
      });
      await db.insert(agents).values({
        id: secondAgent,
        companyId: secondCompany,
        name: "Trap runner",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db.insert(issues).values({
        id: secondIssue,
        companyId: secondCompany,
        title: "Trap card",
        status: "in_progress",
        assigneeAgentId: secondAgent,
      });

      await expect(
        issueRecoveryActionService(db).upsertSourceScoped({
          companyId: secondCompany,
          sourceIssueId: secondIssue,
          kind: "active_run_watchdog",
          ownerType: "board",
          cause: "trap",
          fingerprint: "trap:1",
          nextAction: "n/a",
          // A deadline with no consumer: exactly the KEE-1044 shape.
          timeoutAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow(/without a timeoutSettler/);

      const [row] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, secondIssue));
      expect(row).toBeUndefined();
    });

    /**
     * The load-bearing test. With only part 1 applied (deadline set, no settler)
     * the deadline is unread and the action stays `active` forever. This fails
     * in that state and passes with the settler wired in.
     */
    it("settles an expired watchdog instead of leaving it active forever", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });

      // Before the deadline the settler must not touch it.
      const early = await createSettler().settleExpiredRecoveryActionDeadlines({
        now: new Date(Date.now() - 1_000),
      });
      expect(early.expired).toBe(0);
      expect((await readAction())!.status).toBe("active");

      const afterDeadline = new Date(Date.now() + LEGACY_WATCHDOG_DEADLINE_MS + 60_000);
      const settled = await createSettler().settleExpiredRecoveryActionDeadlines({
        now: afterDeadline,
      });

      expect(settled.expired).toBe(1);
      expect(settled.issueIds).toContain(issueId);

      const action = await readAction();
      // Escalated, not resolved: the board still owns the reconciliation and
      // Paperclip must not assert an outcome nobody recorded.
      expect(action!.status).toBe("escalated");
      expect(action!.ownerType).toBe("board");
      expect(action!.resolvedAt).toBeNull();
      expect((action!.evidence as Record<string, any>).deadlineOutcome).toBe(
        "escalated",
      );
    });

    it("leaves the issue honestly describable after expiry", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      await createSettler().settleExpiredRecoveryActionDeadlines({
        now: new Date(Date.now() + LEGACY_WATCHDOG_DEADLINE_MS + 60_000),
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments.length).toBeGreaterThan(0);
      const body = comments.map((c) => c.body).join("\n");
      // Surfaces the expiry without fabricating a reconciliation outcome.
      expect(body).toMatch(/has \*\*not\*\* decided whether the work/);
      expect(body).toMatch(/board owns this reconciliation/);
    });

    it("is idempotent: a second sweep does not re-comment or re-escalate", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      const past = new Date(Date.now() + LEGACY_WATCHDOG_DEADLINE_MS + 60_000);
      const recovery = createSettler();
      await recovery.settleExpiredRecoveryActionDeadlines({ now: past });
      const second = await recovery.settleExpiredRecoveryActionDeadlines({ now: past });

      expect(second.expired).toBe(0);
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      const expiryComments = comments.filter((c) =>
        /reconciliation deadline passed/.test(c.body),
      );
      expect(expiryComments.length).toBe(1);
    });

    it("does not settle a legacy timeout_at that names no settler", async () => {
      const run = await seedTerminalLegacyRun();
      // A pre-existing action written before this contract existed: a deadline
      // with no settler. It must not be reinterpreted by a consumer it never
      // named; it stays board-owned.
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "board",
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: "legacy-execution:bare",
        evidence: { runId },
        nextAction: "reconcile",
        timeoutAt: new Date(Date.now() - 60_000),
      });

      const settled = await createSettler().settleExpiredRecoveryActionDeadlines({
        now: new Date(),
      });
      expect(settled.expired).toBe(0);
      const [row] = await db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(issueRecoveryActions.fingerprint, "legacy-execution:bare"),
          ),
        );
      expect(row!.status).toBe("active");
    });

    /**
     * `maxAttempts: 3` was unspendable: every caller is gated on a non-terminal
     * run, so a second pass over an already-terminal run cannot happen. Pin that
     * with a test rather than with reading the code.
     */
    it("does not advance attemptCount past 1 on an already-terminal run", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      const first = await readAction();
      expect(first!.attemptCount).toBe(1);

      // Re-run the finalizer against the same terminal run, as a repeated
      // stranded-work sweep would.
      await terminalizeLegacyExecution({ db, run: { ...run, status: "failed" }, status: "failed" });
      const second = await readAction();
      expect(second!.attemptCount).toBe(1);
      // And the budget is not advertised as spendable.
      expect(second!.maxAttempts).toBeNull();
    });

    it("keeps the original deadline on repeated writes", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      const firstDeadline = (await readAction())!.timeoutAt;

      await new Promise((resolve) => setTimeout(resolve, 5));
      await terminalizeLegacyExecution({ db, run: { ...run, status: "failed" }, status: "failed" });

      const second = await readAction();
      // A deadline that slid forward on every write would never expire.
      expect(second!.timeoutAt!.getTime()).toBe(firstDeadline!.getTime());
    });

    /**
     * Pins the settler to the live periodic scheduler.
     *
     * A settler that exists but is never invoked is exactly the KEE-1044 shape
     * restated: the deadline is written, and nothing ever reads it. Mutating
     * this out of `server/src/index.ts` must turn the suite red — the other
     * behavioural tests call the settler directly and cannot catch it.
     */
    it("wires the settler into the live periodic scheduler", async () => {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const serverEntry = fileURLToPath(
        new URL("../../index.ts", import.meta.url),
      );
      const source = await readFile(serverEntry, "utf8");

      // The call must be inside the periodic recovery chain, not merely
      // defined or exported somewhere unreachable.
      const invoked = /heartbeat\.settleExpiredRecoveryActionDeadlines\(\)/.test(source);
      expect(invoked).toBe(true);

      // A timeout_at with a settler that nothing schedules is still a deadlock.
      // Require the call to sit on the same chain as the other periodic
      // recovery sweeps.
      const chainIndex = source.indexOf(
        "heartbeat.reconcileResolvedDependencyWakes()",
      );
      expect(chainIndex).toBeGreaterThan(-1);
      const settlerIndex = source.indexOf(
        "heartbeat.settleExpiredRecoveryActionDeadlines()",
      );
      expect(settlerIndex).toBeGreaterThan(chainIndex);
    });

    it("does not settle before the deadline passes", async () => {
      const run = await seedTerminalLegacyRun();
      await terminalizeLegacyExecution({ db, run, status: "failed" });
      const settled = await createSettler().settleExpiredRecoveryActionDeadlines({
        now: new Date(),
      });
      expect(settled.expired).toBe(0);
      expect((await readAction())!.status).toBe("active");
    });
  },
);
