// Regression for the lifecycle break the operator found on PR #79 head
// bfb48a763: `tests/e2e/acp-stop-continuation.spec.ts` fails 3/3, all waiting at
// line 67 for a follow-up agent message.
//
// Cause, measured rather than argued: the no-registry sweep was unconditional, and
// on that path `pid` is null, so the sweep had no way to know the run's own child
// was excluded. Session-shaped adapters keep ONE long-lived process across a
// stop -- the ACP fixture writes a `continued` marker on `session/cancel` and
// stays alive expecting a later `session/prompt` on the SAME process. The sweep
// killed it, so the continuation run had nothing to talk to and never answered.
//
// The fix makes ownership explicit: the caller passes `preservePids`, and the
// sweep's exclusion set is the union of that, the run's own child, and this
// process. No inference from liveness or registry contents.
//
// This exercises `terminateHeartbeatRunProcess` -- the function all six call
// sites funnel through -- with the real ACP fixture as the long-lived process, so
// a regression that re-widens the sweep fails here rather than in an e2e timeout
// ten minutes later.
//
// Disposable embedded postgres, temp dir, own processes only. No live service, no
// user bus, no install path, no systemd.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping ACP session-ownership tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

describeEmbeddedPostgres("cancelRun preserves the run's session carrier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-acp-owner-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ACP Session Agent",
      role: "engineer",
      status: "active",
      // The e2e fixture's adapter: session-shaped, one long-lived process.
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stop then continue in the same session",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    return { runId, companyId };
  }

  it("does not kill the run's session carrier, but does sweep a tagged escapee", async () => {
    const { runId } = await seedRunningRun();


    const carrier = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    const escapee = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    const bystander = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: `other-${randomUUID()}` },
    });

    try {
      // The e2e's shape, precisely: the ACP session is NOT the run's registered
      // child. `acpx-engine/execute.ts:1934` starts it with
      // `PAPERCLIP_RUN_ID: runId` in its environment, so it carries the run id
      // and is a genuine sweep target -- and it must survive, because the fixture
      // writes a `continued` marker on `session/cancel` and expects a later
      // `session/prompt` on this same process.
      //
      // The registered child is a separate, ordinary process group leader, so it
      // is NOT seeded into `runningProcesses` here: seeding it makes
      // `terminateLocalService` kill it (correctly, that is its job) and that is
      // pre-existing behaviour, verified failing identically at bfb48a763. It is
      // not the regression under test.
      // A `timeout`-wrapped tool escapee in its own process group: same run id,
      // and the whole reason the sweep exists. It must be reaped.
      // An unrelated run's process that must survive.

      await new Promise((r) => setTimeout(r, 500));
      // The session carrier is the run's PERSISTED child, per recordProcessIdentity.
      const carrierPid = carrier.pid!;
      expect(pidAlive(carrierPid)).toBe(true);
      expect(pidAlive(escapee.pid!)).toBe(true);
      expect(pidAlive(bystander.pid!)).toBe(true);

      // Exactly the identity a warm-reused persistent ACP session reports:
      // acpx-engine/execute.ts:4485-4489 calls onSpawn with the session pid and
      // `processGroupId: null`, because the session was not spawned by this run.
      await db
        .update(heartbeatRuns)
        .set({ processPid: carrierPid, processGroupId: null })
        .where(eq(heartbeatRuns.id, runId));
      // No live registry entry: the carrier is known only from the run record.
      expect(runningProcesses.has(runId)).toBe(false);

      const cancelled = await heartbeatService(db).cancelRun(runId, "test stop");
      expect(cancelled).toBeTruthy();

      // The session carrier survives, so a later run in the same session still
      // has a process to talk to. This is the assertion that fails in CI.
      expect(
        pidAlive(carrierPid),
        "cancelRun killed the run's session carrier; the continuation run cannot answer",
      ).toBe(true);

      // The escapee the group signal could not reach is reaped. The fix narrows
      // what is preserved, it does not disable cleanup.
      expect(await waitForExit(escapee.pid!, 5_000)).toBe(true);

      // An unrelated run is untouched.
      expect(pidAlive(bystander.pid!)).toBe(true);
    } finally {
      for (const child of [carrier, escapee, bystander]) {
        try {
          process.kill(child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
        try {
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 40_000);
});
