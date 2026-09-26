import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import { AGENT_PALETTE_IDS, appearanceForPalette } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres config revision snapshot tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent config revision snapshots", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-config-revision-snapshots");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function revisionsFor(agentId: string) {
    return db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));
  }

  it("does not record a spurious appearance change when an unrelated field is edited and stored appearance is unresolved", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);

    const created = await service.create(companyId, {
      name: "Snapshot Agent",
      role: "engineer",
      // Created at the default status, not `pending_approval`: that state
      // deliberately freezes config edits until board approval, so an update
      // here would be refused for a reason unrelated to the snapshot.
      adapterType: "claude_local",
      // A null stored appearance is the legacy/never-set state. The public
      // hydrated read substitutes a deterministic fallback derived from the
      // agent id.
      appearance: null,
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // Force the exact pre-condition: a raw stored appearance that the schema
    // does not accept, so the raw read and the hydrated read disagree.
    await db.update(agents).set({ appearance: null }).where(eq(agents.id, created.id));

    const hydratedBefore = await service.getById(created.id);
    expect(hydratedBefore?.appearance).toBeTruthy();
    expect(hydratedBefore?.appearance).not.toBeNull();

    await service.update(
      created.id,
      { title: "Unrelated title edit" },
      { recordRevision: { source: "test" } },
    );

    const revisions = await revisionsFor(created.id);
    expect(revisions).toHaveLength(1);

    const beforeSnapshot = revisions[0].beforeConfig as Record<string, unknown>;
    const afterSnapshot = revisions[0].afterConfig as Record<string, unknown>;

    // The before-snapshot must be normalized the same way the after-snapshot
    // is. If it held the raw null, the diff would report an appearance change
    // for an edit that never touched appearance, and a rollback would then
    // rewrite appearance.
    expect(beforeSnapshot.appearance).toEqual(afterSnapshot.appearance);
    expect(beforeSnapshot.appearance).toBeTruthy();

    const changedKeys = Object.keys(beforeSnapshot).filter(
      (key) => JSON.stringify(beforeSnapshot[key]) !== JSON.stringify(afterSnapshot[key]),
    );
    expect(changedKeys).toEqual(["title"]);
  });

  it("still records a real appearance change", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);

    const created = await service.create(companyId, {
      name: "Real Appearance Agent",
      role: "engineer",
      adapterType: "claude_local",
      appearance: null,
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const target = (await service.getById(created.id))!.appearance!;
    const other = appearanceForPalette(
      target.paletteId === AGENT_PALETTE_IDS[0] ? AGENT_PALETTE_IDS[1] : AGENT_PALETTE_IDS[0],
    );

    await service.update(
      created.id,
      { appearance: other },
      { recordRevision: { source: "test" } },
    );

    const revisions = await revisionsFor(created.id);
    expect(revisions).toHaveLength(1);

    const beforeSnapshot = revisions[0].beforeConfig as Record<string, unknown>;
    const afterSnapshot = revisions[0].afterConfig as Record<string, unknown>;
    expect(beforeSnapshot.appearance).not.toEqual(afterSnapshot.appearance);
  });
});
