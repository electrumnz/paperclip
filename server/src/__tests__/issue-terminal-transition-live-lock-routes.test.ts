import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal transition route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("terminal transition live lock route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-transition-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    // Route writes can append `heartbeat_run_events` for the seeded run, which
    // a bare delete of `heartbeat_runs` would violate via foreign key.
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    } as unknown as Express.Request["actor"];
  }

  function otherAgentActor(companyId: string, agentId: string, runId: string) {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    } as unknown as Express.Request["actor"];
  }

  async function seedCompanyAgentAndLiveRun(status: "queued" | "running") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const bystanderAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "LockedAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: bystanderAgentId,
        companyId,
        name: "BystanderAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId: null },
    });

    return { companyId, agentId, runId, bystanderAgentId };
  }

  async function seedIssueWithLiveRun(
    companyId: string,
    agentId: string,
    runId: string,
  ) {
    const issueId = randomUUID();
    await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Terminal transition under live lock",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionLockedAt: new Date(),
      })
      .returning();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, runId));
    return issueId;
  }

  it.each(["cancelled", "done"] as const)(
    "allows a board actor to move an issue to %s while another run holds the execution lock",
    async (terminalStatus) => {
      const { companyId, agentId, runId } = await seedCompanyAgentAndLiveRun("running");
      const issueId = await seedIssueWithLiveRun(companyId, agentId, runId);

      const res = await request(createApp(boardActor(companyId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: terminalStatus });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe(terminalStatus);

      const row = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe(terminalStatus);

      // A terminal transition must not be recorded as a skipped live-lock write.
      const audit = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.status_write_skipped_live_lock"))
        .then((rows) => rows[0] ?? null);
      expect(audit).toBeNull();
    },
  );

  it.each(["queued", "running"] as const)(
    "still refuses a non-terminal external status write while a %s run owns the issue",
    async (runStatus) => {
      const { companyId, agentId, runId } = await seedCompanyAgentAndLiveRun(runStatus);
      const issueId = await seedIssueWithLiveRun(companyId, agentId, runId);

      const res = await request(createApp(boardActor(companyId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({
        code: "issue_status_write_live_lock",
        activeRunId: runId,
        retryAfter: "active_run_release",
      });
    },
  );

  it("records no live-lock audit for a terminal transition", async () => {
    const { companyId, agentId, runId } = await seedCompanyAgentAndLiveRun("running");
    const issueId = await seedIssueWithLiveRun(companyId, agentId, runId);

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.status_write_skipped_live_lock"))
      .then((rows) => rows[0] ?? null);
    expect(audit).toBeNull();
  });
});
