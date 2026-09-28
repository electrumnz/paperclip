import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("secret-binding revoke is not undone by a concurrent agent config write", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-revoke-probe-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("revoke-probe");
    db = createDb(started.connectionString);
    stopDb = started.cleanup;
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Probe Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name, issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function createApp(companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId: "user-1", source: "session", companyIds,
        memberships: companyIds.map((companyId) => ({
          companyId, status: "active", membershipRole: "admin",
        })),
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // Mirrors the production PATCH /api/agents/:id path: the handler reads the
  // hydrated agent row, builds the patch from that read, then calls update()
  // carrying the version it read (server/src/routes/agents.ts PATCH /agents/:id).
  // A PATCH that read the agent before the revoke committed carries a stale
  // config snapshot. Without the optimistic version guard it silently rewrites
  // adapterConfig, resurrecting the secret_ref and re-projecting the secret value
  // into the runtime environment -- a revoke that returns 200 and revokes
  // nothing. This is the production shape of PATCH /api/agents/:id.
  it("rejects a stale config write that would resurrect the revoked secret", async () => {
    const companyId = await seedCompany();
    const envKey = "SUPABASE_PROBE_TOKEN";
    const secret = await secretService(db).create(companyId, {
      name: `supabase-${randomUUID()}`, provider: "local_encrypted", value: "sbp_live_value",
    });
    const agent = await agentService(db).create(companyId, {
      name: "Bound Agent", role: "engineer", adapterType: "codex_local",
      adapterConfig: { env: { [envKey]: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
      runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null,
    });
    const [binding] = await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.companyId, companyId),
      eq(companySecretBindings.targetType, "agent"),
      eq(companySecretBindings.targetId, agent.id),
    ));

    // Step 1: PATCH handler does its initial read (this is what routes/agents.ts
    // does at the top of the handler, long before svc.update).
    const handlerRead = await agentService(db).getById(agent.id);
    if (!handlerRead) throw new Error("no agent");

    // Step 2: revoke commits first, taking the row lock and removing the ref.
    const res = await request(createApp([companyId])).delete(`/api/secrets/${secret.id}/bindings/${binding.id}`);
    expect(res.status).toBe(200);

    // Step 3: the PATCH handler now applies the config patch it built from its
    // stale read, carrying the version it read. After the fix, the service
    // compares that version under the row lock and refuses the stale write.
    const patched = await agentService(db).update(
      agent.id,
      { adapterConfig: { ...(handlerRead.adapterConfig as Record<string, unknown>), unrelatedFlag: true } },
      { expectedAdapterConfig: handlerRead.adapterConfig },
    ).then(() => "committed" as const, (error: unknown) => error as Error);

    const conflict = patched instanceof Error && /changed before this update/i.test(patched.message);

    // The security property under test: is the secret ref back in the config,
    // and is it projected into the runtime environment again?
    const reloaded = await agentService(db).getById(agent.id);
    const env = (reloaded?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env;
    const resurrected = env?.[envKey] as { secretId?: string } | undefined;

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId, reloaded?.adapterConfig,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "codex_local" },
    );

    const bindings = await db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.companyId, companyId),
      eq(companySecretBindings.targetType, "agent"),
      eq(companySecretBindings.targetId, agent.id),
    ));

    expect(conflict, "stale PATCH must be rejected, not silently merged").toBe(true);
    expect(resurrected, "secret ref was resurrected by a stale PATCH read").toBeUndefined();
    expect(JSON.stringify(resolved.config), "secret value must not be projected again").not.toContain("sbp_live_value");
    expect(bindings, "revoked binding must not be re-derived").toHaveLength(0);
  });
});
