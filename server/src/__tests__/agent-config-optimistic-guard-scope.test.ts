import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, secretAccessEvents } from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("optimistic guard does not reject an ordinary edit over an unrelated row touch", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-guard-probe-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("guard-probe");
    db = createDb(started.connectionString);
    stopDb = started.cleanup;
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Guard Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  // services/costs.ts writes `updatedAt` on the agents row for every cost
  // event; active-run-watchdog does the same on every run completion. Neither
  // touches adapterConfig. If the optimistic guard keys on updatedAt alone, a
  // user's legitimate config edit loses to that background write and 409s.
  it("accepts a config edit when only an unrelated column was touched meanwhile", async () => {
    const companyId = await seedCompany();
    const agent = await agentService(db).create(companyId, {
      name: "Ordinary Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: { env: { EXISTING: "value" } },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // Handler's initial read, exactly as routes/agents.ts does it.
    const handlerRead = await agentService(db).getById(agent.id);
    if (!handlerRead) throw new Error("no agent");

    // Unrelated background activity: a spend rollup that only writes
    // spentMonthlyCents + updatedAt. No config change whatsoever.
    await db
      .update(agents)
      .set({ spentMonthlyCents: 1234, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));

    const result = await agentService(db)
      .update(agent.id, { adapterConfig: { env: { EXISTING: "value", ADDED: "yes" } } }, {
        expectedAdapterConfig: handlerRead.adapterConfig,
      })
      .then((updated) => ({ ok: true as const, updated }))
      .catch((error: unknown) => ({ ok: false as const, error: error as Error }));

    // Asserted against the behaviour we want, not the behaviour we shipped.
    expect(result.ok, `an unrelated column touch must not reject a legitimate config edit: ${result.ok ? "" : (result as { error: Error }).error.message}`)
      .toBe(true);
  });
});
