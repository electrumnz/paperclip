import { createHash, randomUUID } from "node:crypto";
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
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  invites,
  joinRequests,
  secretAccessEvents,
} from "@paperclipai/db";

// The invite-replay path in `routes/access.ts` reads the approved join
// request's agent and merges the replayed gateway defaults over the config it
// read, then writes the result back. That is a read-modify-write, so it takes
// the same stale-read hazard as `PATCH /api/agents/:id`: a config change that
// commits in between -- a secret-binding revoke, for example -- would be
// silently overwritten and the revoked `secret_ref` merged straight back.
//
// Pinning `getById` reproduces exactly that interleaving. The real service is
// spread through untouched, so this only stages the read the handler takes.
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
          if (staleRead.snapshot && staleRead.snapshot.id === id) {
            const real = await svc.getById(id);
            if (real) return { ...real, adapterConfig: staleRead.snapshot.adapterConfig };
          }
          return svc.getById(id);
        },
      };
    },
  };
});

import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";
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
    `Skipping invite replay config guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("invite replay refuses to resurrect a revoked secret ref", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-invite-replay-guard-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("invite-replay-guard");
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
    // `join_requests.created_agent_id` references the agent, so the join
    // requests have to go first.
    await db.delete(joinRequests);
    await db.delete(agents);
    await db.delete(invites);
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

  function createApp(companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
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
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  // An already-accepted invite with an approved `openclaw_gateway` join
  // request is the only shape that reaches the replay merge. `inviteToken` is
  // the sha256 the route matches against, so the caller seeds the invite
  // under the same value it will send.
  async function seedAcceptedGatewayJoin(options: {
    inviteTokenHash: string;
    companyId: string;
    agentId: string;
  }) {
    const inviteId = randomUUID();
    const joinRequestId = randomUUID();
    await db.insert(invites).values({
      id: inviteId,
      companyId: options.companyId,
      inviteType: "company_join",
      tokenHash: options.inviteTokenHash,
      allowedJoinTypes: "agent",
      defaultsPayload: null,
      acceptedAt: new Date(),
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    });
    await db.insert(joinRequests).values({
      id: joinRequestId,
      inviteId,
      companyId: options.companyId,
      requestType: "agent",
      status: "approved",
      requestIp: "127.0.0.1",
      agentName: "Gateway Agent",
      adapterType: "openclaw_gateway",
      capabilities: "OpenClaw gateway agent",
      agentDefaultsPayload: null,
      createdAgentId: options.agentId,
    });
    return { inviteId, joinRequestId };
  }

  it("refuses a replay whose agent config changed after it was read", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Replay Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const envKey = "OPENCLAW_REPLAY_TOKEN";
    const secret = await secretService(db).create(companyId, {
      name: `replay-${randomUUID()}`,
      provider: "local_encrypted",
      value: "replay_secret_value",
    });
    const agent = await agentService(db).create(companyId, {
      name: "Gateway Agent",
      role: "engineer",
      adapterType: "openclaw_gateway",
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

    // The invite token is matched by its sha256 hash (`hashToken` in
    // routes/access.ts), so seed the invite under the same hash.
    const inviteToken = `pcp_invite_${randomUUID()}${randomUUID()}`;
    const tokenHash = createHash("sha256").update(inviteToken).digest("hex");
    await seedAcceptedGatewayJoin({ inviteTokenHash: tokenHash, companyId, agentId: agent.id });

    const app = createApp([companyId]);

    // The openclaw_gateway branch requires a defaults payload; it is merged
    // over the config the replay reads, which is exactly the write under test.
    // The gateway needs a ws/wss `url` and an auth token of at least 16
    // characters, or normalization rejects the request before the merge.
    const defaultsPayload = {
      url: "wss://openclaw.example/ws",
      headers: { "x-openclaw-token": "gateway-token-0123456789" },
    };

    // The handler's read, captured before the revoke.
    const handlerRead = await agentService(db).getById(agent.id);
    if (!handlerRead) throw new Error("agent not found");

    const revoked = await request(app).delete(`/api/secrets/${secret.id}/bindings/${binding.id}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    staleRead.snapshot = {
      id: agent.id,
      adapterConfig: handlerRead.adapterConfig as Record<string, unknown>,
    };

    const replayed = await request(app)
      .post(`/api/invites/${inviteToken}/accept`)
      .send({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        agentName: "Gateway Agent",
        agentDefaultsPayload: defaultsPayload,
      });

    expect(replayed.status, JSON.stringify(replayed.body)).toBe(409);
    expect(replayed.body).toMatchObject({ code: "agent_config_concurrency_conflict" });

    // The security property: the replayed merge must not put the ref back.
    const reloaded = await agentService(db).getById(agent.id);
    const env = (reloaded?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env;
    expect(env?.[envKey], "secret ref was resurrected by the invite replay").toBeUndefined();
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, agent.id),
        ),
      );
    expect(bindings).toHaveLength(0);
  });
});
