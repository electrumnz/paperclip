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
  companySecretBindings,
  companySecretProposals,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";

// `services/secret-proposals.ts` imports `agentService` from `./agents.js`, so
// this mock is what `applyBindingApproval` actually calls. The real service is
// spread through untouched; only `getById` can be pinned to a stale snapshot.
//
// The interleaving is staged explicitly because one HTTP request reads and
// writes in one breath. To make the approval's own read of the target agent
// stale, a concurrent commit has to land between it and the write. Pinning
// `getById` reproduces exactly that, and it isolates what this suite is for --
// whether proposal approval passes the config it read to the service at all.
const staleRead = vi.hoisted(() => ({ snapshot: null as Record<string, unknown> | null }));

vi.mock("../services/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agents.js")>();
  return {
    ...actual,
    agentService: (db: Parameters<typeof actual.agentService>[0]) => {
      const svc = actual.agentService(db);
      return {
        ...svc,
        getById: async (id: string) => {
          if (staleRead.snapshot) {
            const real = await svc.getById(id);
            if (real && real.id === staleRead.snapshot.id) {
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
    `Skipping secret proposal approval concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// This suite covers the APPROVAL path, which is the third unguarded
// read-modify-write found in the revoke PR review.
//
// `applyBindingApproval` in `server/src/services/secret-proposals.ts` reads
// `target.adapterConfig`, merges the approved `secret_ref` into it, and writes
// the merge back. That is a plain read -> merge -> write against a row another
// request can be revoking a secret binding on.
//
// Without the optimistic guard, a revoke that commits between that read and the
// write is silently overwritten: the `secret_ref` is written straight back into
// `adapterConfig` and the `replaceAll` sync re-derives the binding row. A
// revocation that returns 200 and revokes nothing is precisely what this whole
// change exists to prevent, and it is the more dangerous direction -- the board
// approved a revocation and the secret keeps projecting into the agent's
// runtime environment.
//
// Without a test that drives this path, deleting the `expectedAdapterConfig`
// argument at the `agentSvc.update` call is a small, plausible-looking edit
// that leaves every other suite in the revoke PR green.
describeEmbeddedPostgres("secret proposal binding approval rejects a concurrently revoked binding", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-proposal-revoke-race-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("proposal-revoke-race");
    db = createDb(started.connectionString);
    stopDb = started.cleanup;
  }, 30_000);

  afterEach(async () => {
    staleRead.snapshot = null;
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretProposals);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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

  // Mirrors the fixture in `secret-proposals-routes.test.ts`: a board-resolved
  // agent run is what lets an agent propose a binding to itself.
  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Proposal Revoke Co",
      issuePrefix: `T${companyId.slice(0, 7).toUpperCase()}`,
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "SEC-RACE-1",
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  function createAgentApp(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source: "agent_jwt",
        keyScope: { kind: "standard" },
      } as never;
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: "local_implicit",
      } as never;
      next();
    });
    app.use("/api", secretRoutes(db));
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

  it("refuses to write a binding back over a secret that was revoked mid-approval", async () => {
    const fixture = await seedRun();
    const agentApp = createAgentApp(fixture);
    const boardApp = createBoardApp(fixture);
    const envKey = "SUPABASE_PROPOSAL_TOKEN";

    // A company secret the agent is allowed to bind to itself.
    const secret = await secretService(db).create(fixture.companyId, {
      name: `dev/proposal/${randomUUID()}`,
      provider: "local_encrypted",
      value: "sbp_proposal_live_value",
    });
    await agentService(db).update(fixture.agentId, {
      adapterConfig: { env: { [envKey]: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
    });

    const bindingProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: secret.id,
        configPath: `env.${envKey}`,
        justification: "Bind the token this agent already references",
      });
    expect(bindingProposal.status, JSON.stringify(bindingProposal.body)).toBe(201);

    // The board revokes the binding the proposal is about to write.
    const [binding] = await readBindingRows(fixture.companyId, fixture.agentId);
    expect(binding).toBeDefined();
    const revoked = await request(boardApp).delete(
      `/api/secrets/${secret.id}/bindings/${binding.id}`,
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(await readBindingRows(fixture.companyId, fixture.agentId)).toHaveLength(0);

    // The approval now reads the target agent, but observes the pre-revoke
    // config -- the snapshot a request that started just before the revoke
    // committed would hold.
    const proposalTargetRead = await agentService(db).getById(fixture.agentId);
    if (!proposalTargetRead) throw new Error("agent not found");
    staleRead.snapshot = {
      id: fixture.agentId,
      adapterConfig: {
        ...(proposalTargetRead.adapterConfig as Record<string, unknown>),
        env: { [envKey]: { type: "secret_ref", secretId: secret.id, version: "latest" } },
      },
    };

    const approved = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({});

    // The approval must be refused, not silently merged over the revocation.
    expect(approved.status, JSON.stringify(approved.body)).toBe(409);

    // The staged interleaving is over. Clearing it matters: while the snapshot
    // is pinned, this mock also rewrites reads made by the assertions below,
    // which would assert against the stale snapshot rather than the committed
    // state.
    staleRead.snapshot = null;

    // The security property: the revoked secret is not back in the config, not
    // re-derived as a binding, and not projected into the runtime environment.
    // The config is read straight from the table so the verdict cannot be
    // affected by any service-layer stubbing in this file.
    const [row] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(
      eq(agents.id, fixture.agentId),
    );
    const env = (row?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env;
    expect(
      (env?.[envKey] as { secretId?: string } | undefined)?.secretId,
      "a refused approval must not write the revoked secret ref back",
    ).toBeUndefined();
    expect(await readBindingRows(fixture.companyId, fixture.agentId)).toHaveLength(0);

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      fixture.companyId,
      row?.adapterConfig,
      { consumerType: "agent", consumerId: fixture.agentId },
      { adapterType: "codex_local" },
    );
    expect(
      JSON.stringify(resolved.config),
      "secret value must not be projected again after a refused approval",
    ).not.toContain("sbp_proposal_live_value");
  });

  // The guard must not refuse an approval whose read is genuinely current, or
  // the whole proposal workflow would be unusable. This pins the false-positive
  // side of the guard: no stale read staged, so the write is allowed through.
  it("allows a binding approval whose target config read is current", async () => {
    const fixture = await seedRun();
    const agentApp = createAgentApp(fixture);
    const boardApp = createBoardApp(fixture);
    const envKey = "SUPABASE_CURRENT_PROPOSAL_TOKEN";

    const secret = await secretService(db).create(fixture.companyId, {
      name: `dev/current/${randomUUID()}`,
      provider: "local_encrypted",
      value: "sbp_current_live_value",
    });

    const bindingProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: secret.id,
        configPath: `env.${envKey}`,
        justification: "Bind a new token to this agent",
      });
    expect(bindingProposal.status, JSON.stringify(bindingProposal.body)).toBe(201);

    const approved = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({});

    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      status: "approved",
      appliedBindingConfigPath: `env.${envKey}`,
    });

    const reloaded = await agentService(db).getById(fixture.agentId);
    const env = (reloaded?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env;
    expect(env?.[envKey]).toMatchObject({ type: "secret_ref", secretId: secret.id });
    expect(await readBindingRows(fixture.companyId, fixture.agentId)).toHaveLength(1);
  });
});
