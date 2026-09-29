import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
  secretAccessEvents,
} from "@paperclipai/db";

// `routes/agents.ts` imports `agentService` from `../services/index.js`, so
// this mock is what the PATCH handler actually calls. The real service is
// spread through untouched; only `getById` can be pinned to a stale snapshot
// while the routing test needs the handler to observe an old read.
//
// Stale reads are staged explicitly because a single HTTP request reads and
// writes in one breath: to make the handler's own read stale, a concurrent
// commit has to land between them. Pinning `getById` reproduces exactly that
// interleaving, and it isolates what this suite is for -- whether the handler
// passes the config it read to the service at all.
const staleRead = vi.hoisted(() => ({ snapshot: null as Record<string, unknown> | null }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    agentService: (db: Parameters<typeof actual.agentService>[0]) => {
      const svc = actual.agentService(db);
      return {
        ...svc,
        getById: async (id: string) => {
          if (staleRead.snapshot) {
            const real = await svc.getById(id);
            if (real && real.id === (staleRead.snapshot.id as string)) {
              return { ...real, adapterConfig: staleRead.snapshot.adapterConfig };
            }
            return real;
          }
          return svc.getById(id);
        },
      };
    },
  };
});

import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent config HTTP concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// This suite covers the ROUTE wiring, not the service mechanism.
//
// The service-level guard in `agentService.update` is proven by
// `secret-binding-revoke-concurrency.test.ts`. That test calls
// `agentService.update(...)` directly, so it cannot see whether
// `PATCH /api/agents/:id` actually passes `expectedAdapterConfig`.
//
// The consequence of that gap is concrete: deleting the
// `expectedAdapterConfig` argument from the PATCH handler in
// `server/src/routes/agents.ts` is a small, plausible-looking edit that
// leaves every other test in the revoke PR green while silently restoring
// the lost-update race -- a PATCH that read the agent before the revoke
// committed rewrites `adapterConfig` from its stale snapshot, resurrecting
// the `secret_ref` and re-projecting the secret value into the runtime
// environment. These tests drive the real HTTP route so that regression
// fails here instead of surviving review.
describeEmbeddedPostgres("agent config writes over HTTP reject stale reads", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-config-http-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-config-http");
    db = createDb(started.connectionString);
    stopDb = started.cleanup;
  }, 30_000);

  afterEach(async () => {
    staleRead.snapshot = null;
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Http Guard Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The PATCH route authorizes through `access.decide`, which requires an
    // `agents:configure` grant for the acting user. Without both rows the
    // handler 403s before it ever reaches the concurrency guard, and the test
    // would pass for the wrong reason.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "user-1",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: "user-1",
      permissionKey: "agents:configure",
      scope: null,
    });
    return companyId;
  }

  async function seedBoundAgent(companyId: string, envKey: string) {
    const secret = await secretService(db).create(companyId, {
      name: `supabase-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sbp_live_value",
    });
    const agent = await agentService(db).create(companyId, {
      name: "Bound Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: { [envKey]: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, agent.id),
        ),
      );
    return { secret, agent, binding, envKey };
  }

  function createApp(companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds,
        memberships: companyIds.map((companyId) => ({
          companyId,
          status: "active" as const,
          membershipRole: "owner" as const,
        })),
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function readBindingRows(companyId: string, agentId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, agentId),
        ),
      );
  }

  it("rejects a stale PATCH /api/agents/:id that would resurrect a revoked secret", async () => {
    const companyId = await seedCompany();
    const envKey = "SUPABASE_HTTP_TOKEN";
    const { secret, agent, binding } = await seedBoundAgent(companyId, envKey);
    const app = createApp([companyId]);

    // The PATCH handler's read, captured before the revoke commits. This is
    // the snapshot a handler that started just before the revoke would hold.
    const handlerRead = await agentService(db).getById(agent.id);
    if (!handlerRead) throw new Error("agent not found");
    const staleConfig = handlerRead.adapterConfig as Record<string, unknown>;

    // The revoke commits and removes the ref.
    const revoked = await request(app).delete(`/api/secrets/${secret.id}/bindings/${binding.id}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    // Now the handler re-reads and sees the pre-revoke config, as it would if
    // its read had happened a moment before the revoke committed.
    staleRead.snapshot = { id: agent.id, adapterConfig: staleConfig };

    // The PATCH body still carries the secret_ref from the stale read, which
    // is the normal shape of a client PATCH built from a config it fetched
    // just before the revoke.
    const patched = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { ...staleConfig, unrelatedFlag: true } });

    expect(patched.status, JSON.stringify(patched.body)).toBe(409);
    expect(patched.body, "the 409 must name the concurrency code a client can branch on")
      .toMatchObject({ code: "agent_config_concurrency_conflict" });

    // The security property: the secret is neither back in the config, nor
    // re-derived as a binding, nor projected into the runtime environment.
    const reloaded = await agentService(db).getById(agent.id);
    const env = (reloaded?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env;
    expect(env?.[envKey], "secret ref was resurrected by a stale PATCH over HTTP").toBeUndefined();
    expect(await readBindingRows(companyId, agent.id)).toHaveLength(0);

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      reloaded?.adapterConfig,
      { consumerType: "agent", consumerId: agent.id },
      { adapterType: "codex_local" },
    );
    expect(
      JSON.stringify(resolved.config),
      "secret value must not be projected again after a refused PATCH",
    ).not.toContain("sbp_live_value");
  });

  // The guard must not reject a PATCH that is genuinely current. This pins
  // the false-positive behaviour: the handler's own read and the row it locks
  // agree, so the write is allowed through.
  it("allows a current PATCH /api/agents/:id to write config", async () => {
    const companyId = await seedCompany();
    const { agent } = await seedBoundAgent(companyId, "SUPABASE_CURRENT_TOKEN");
    const app = createApp([companyId]);

    const patched = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "gpt-5" } });

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ id: agent.id });
  });
});
