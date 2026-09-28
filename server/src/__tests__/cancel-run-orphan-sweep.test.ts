// Regression for the cancellation gap the operator found at PR #79 head
// 9ce784c19: `cancelRun` could finalise a run as `cancelled` while attributed
// descendants were still alive.
//
// Two separate causes, both fixed in `terminateHeartbeatRunProcess` and its call
// sites:
//   1. the function returned early when no pid and no process group were given,
//      before reaching the run-id sweep;
//   2. all three call sites invoked it only inside `if (running)`, so with an
//      empty `runningProcesses` registry the function was never called at all.
//
// The operator's 12:21Z attribution is the evidence: cancelled runs e1b9d30b,
// e65ddac3 and 3e71cf0e retained 24 / 22 / 6 child processes.
//
// This drives the SUPPORTED entry point -- `heartbeatService(db).cancelRun` --
// not the helper. An earlier version of this file only tested
// `terminateHeartbeatRunProcess` directly with a live run root, which is exactly
// the coverage gap: the helper worked, and the callers still skipped it.
//
// Runs against a disposable embedded postgres in a temp dir. No live service,
// no user bus, no install path, no systemd.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
    `Skipping cancelRun orphan sweep tests on this host: ${
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

describeEmbeddedPostgres("cancelRun orphan descendant sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancel-orphan-");
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
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes Agent",
      role: "engineer",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancel with an orphan descendant",
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

  it("sweeps an attributed descendant even with no runningProcesses registry entry", async () => {
    const { runId } = await seedRunningRun();

    // The orphan: a `timeout`-wrapped descendant in its own process group that
    // still carries the run id. The run root itself is absent from the registry,
    // which is the case under test.
    const orphan = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    // An unrelated run's process that must survive.
    const bystanderRunId = `bystander-${process.pid}-${Date.now()}`;
    const bystander = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: bystanderRunId },
    });

    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(pidAlive(orphan.pid!)).toBe(true);
      expect(pidAlive(bystander.pid!)).toBe(true);

      // Precondition for the defect: the registry has no entry for this run, so
      // `if (running)` is false and the callers previously skipped cleanup
      // entirely.
      expect(runningProcesses.has(runId)).toBe(false);

      // The supported entry point, not the helper.
      const cancelled = await heartbeatService(db).cancelRun(runId, "test cancel");
      expect(cancelled).toBeTruthy();

      // The run is finalised as cancelled...
      const after = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      expect(after[0]?.status).toBe("cancelled");

      // ...and the orphan the group signal could not reach is gone.
      expect(await waitForExit(orphan.pid!, 5_000)).toBe(true);

      // An unrelated run's process is untouched: attribution is exact-run.
      expect(pidAlive(bystander.pid!)).toBe(true);
    } finally {
      for (const p of [orphan.pid, bystander.pid]) {
        try {
          process.kill(p!, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 40_000);

  it("cancels cleanly when nothing is attributed to the run", async () => {
    const { runId } = await seedRunningRun();

    // No orphan at all. Cleanup must still complete and report cancelled, not
    // throw or hang on the now-unconditional sweep.
    const cancelled = await heartbeatService(db).cancelRun(runId, "test cancel nothing");
    expect(cancelled).toBeTruthy();

    const after = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    expect(after[0]?.status).toBe("cancelled");
  }, 20_000);

  // The sweep must not cross a remote boundary. It cannot: attribution is the
  // run id in THIS host's process environments, and a remote run's processes do
  // not carry it. This pins that property so a future change that widens the
  // attribution (a name match, a looser env scan) fails here.
  it("never signals a process that does not carry the exact run id", async () => {
    // A process tagged with a DIFFERENT run's id, standing in for anything the
    // sweep must not touch: another run, a remote target, or an unrelated host
    // process that happens to be heavy.
    const otherRunId = `remote-target-${process.pid}-${Date.now()}`;
    const remoteLike = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: otherRunId },
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(pidAlive(remoteLike.pid!)).toBe(true);

      // Cancel a run id that matches nothing on this host.
      const { runId } = await seedRunningRun();
      const cancelled = await heartbeatService(db).cancelRun(runId, "sweep must not cross hosts");
      expect(cancelled).toBeTruthy();

      // The unrelated process is still running.
      expect(pidAlive(remoteLike.pid!)).toBe(true);
    } finally {
      try {
        process.kill(remoteLike.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 20_000);
});
