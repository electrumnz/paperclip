/**
 * KEE-1087 / KEE-1102 wiring proof for pilot hotfix 5 (effective run timeout).
 *
 * `heartbeat-stop-metadata.effective-timeout.test.ts` proves the *policy
 * function* in isolation. It stays green if the call site is reverted, which is
 * exactly the defect the reviewer measured on commit `4f206ec56`: changing
 * `mergeRunStopMetadataForAgent({ ...agent, adapterConfig: runtimeConfig }, …)`
 * back to `mergeRunStopMetadataForAgent(agent, …)` left all three
 * stop-metadata test files passing, EXIT=0, 12 tests. Both existing tests call
 * `resolveHeartbeatRunTimeoutPolicy` directly with a literal config object, so
 * neither can observe *which* config the call site hands it.
 *
 * This file pins the *wiring* instead. It drives the real exported entry point
 * `heartbeatService(db).invoke(...)` through a real run against a real
 * database, with a registered fake adapter, and then reads the **persisted**
 * `heartbeat_runs.resultJson`. That is the only place the argument the call site
 * passes is observable from outside.
 *
 * The divergence the hotfix exists to fix, in the terms this test seeds it:
 *
 *   agent.adapterConfig.timeoutSec              = 600   (stored on the row)
 *   issues.assigneeAdapterOverrides.adapterConfig
 *            .timeoutSec                        = 180   (per-issue override)
 *
 * `executeRun` merges the issue-level override over the stored agent config
 * (`mergedConfig` at heartbeat.ts:21226-21229), and that merged config is the
 * `runtimeConfig` passed to `adapter.execute({ config: runtimeConfig })`
 * (heartbeat.ts:24353). The run is actually executed under 180s. Pre-port the
 * call site handed `mergeRunStopMetadataForAgent` the *stored* 600s, so the
 * persisted `resultJson.effectiveTimeoutSec` recorded 600 for a run that was
 * really aborted at 180.
 *
 * Revert the call site and the first test below fails: it records 600.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
// A skipped wiring test would read as coverage in a merge review while proving
// nothing, so the reason is stated rather than left silent — same guard as
// non-cyclic-children.wiring.test.ts.
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const ADAPTER_TYPE = "codex_local";
const STORED_AGENT_TIMEOUT_SEC = 600;
const EFFECTIVE_RUNTIME_TIMEOUT_SEC = 180;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping KEE-1087 effective-timeout wiring tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres(
  "KEE-1087: the recorded run timeout is the effective runtime timeout, not the stored agent config",
  () => {
    let db!: ReturnType<typeof createDb>;
    let heartbeat!: ReturnType<typeof heartbeatService>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;
    const execute = vi.fn<ServerAdapterModule["execute"]>();

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "heartbeat-kee-1087-effective-timeout-",
      );
      db = createDb(tempDb.connectionString);
      heartbeat = heartbeatService(db);
      registerServerAdapter({
        type: ADAPTER_TYPE,
        supportsLocalAgentJwt: false,
        execute,
        testEnvironment: async () => ({
          adapterType: ADAPTER_TYPE,
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        }),
      });
    }, 30_000);

    afterEach(async () => {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      vi.clearAllMocks();
      await db.execute(
        sql.raw(`
          TRUNCATE TABLE
            "issue_relations",
            "issues",
            "heartbeat_run_events",
            "heartbeat_runs",
            "agent_wakeup_requests",
            "agent_runtime_state",
            "agents",
            "companies"
          RESTART IDENTITY CASCADE
        `),
      );
    });

    afterAll(async () => {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      unregisterServerAdapter(ADAPTER_TYPE);
      await tempDb?.cleanup();
    });

    it("persists the issue-level override timeout, which differs from the stored agent timeout", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      // The adapter must observe the same effective timeout the port now records,
      // otherwise the test would assert the port is correct while the run itself
      // was executed under a different value. This pins that both come from
      // runtimeConfig.
      execute.mockImplementation(async ({ config }) => {
        expect((config as Record<string, unknown>)?.timeoutSec).toBe(
          EFFECTIVE_RUNTIME_TIMEOUT_SEC,
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          provider: "codex",
          model: "test-codex",
          summary: "Ran under the issue-level timeout override.",
        };
      });

      await db.insert(companies).values({
        id: companyId,
        name: "Effective timeout wiring",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Timeout subject",
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER_TYPE,
        // The stored config says 600s. Nothing should ever record this for a run
        // that actually executed under 180s.
        adapterConfig: { timeoutSec: STORED_AGENT_TIMEOUT_SEC },
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Per-issue timeout override",
        status: "todo",
        priority: "medium",
        responsibleUserId: "responsible-user",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        assigneeAdapterOverrides: {
          adapterConfig: { timeoutSec: EFFECTIVE_RUNTIME_TIMEOUT_SEC },
        },
      });

      const queued = await heartbeat.invoke(
        agentId,
        "assignment",
        { issueId, taskId: issueId },
        "system",
      );
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(finished).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledOnce();

      const persistedResult = finished?.resultJson as Record<string, unknown> | null;
      // The port's guarantee: the recorded timeout is the one the run ran under.
      expect(persistedResult?.effectiveTimeoutSec).toBe(
        EFFECTIVE_RUNTIME_TIMEOUT_SEC,
      );
      expect(persistedResult?.timeoutSource).toBe("config");
      expect(persistedResult?.timeoutConfigured).toBe(true);
      // And explicitly not the stored agent value, which is the regression the
      // pre-port call site produced.
      expect(persistedResult?.effectiveTimeoutSec).not.toBe(
        STORED_AGENT_TIMEOUT_SEC,
      );
    }, 30_000);

    it("still records the stored agent timeout when no override applies, so the port is not a blanket change", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: "codex",
        model: "test-codex",
        summary: "Ran with no override in play.",
      });

      await db.insert(companies).values({
        id: companyId,
        name: "No override control",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Control subject",
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER_TYPE,
        adapterConfig: { timeoutSec: STORED_AGENT_TIMEOUT_SEC },
        runtimeConfig: {},
        permissions: {},
      });

      const queued = await heartbeat.invoke(
        agentId,
        "on_demand",
        {},
        "manual",
      );
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);

      expect(finished).toMatchObject({ status: "succeeded" });
      const persistedResult = finished?.resultJson as Record<string, unknown> | null;
      // runtimeConfig derives from the stored agent config when no override is
      // present, so the recorded value is unchanged by the port.
      expect(persistedResult?.effectiveTimeoutSec).toBe(
        STORED_AGENT_TIMEOUT_SEC,
      );
    }, 30_000);
  },
);
