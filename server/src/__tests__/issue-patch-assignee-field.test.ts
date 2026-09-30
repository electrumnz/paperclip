import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { updateIssueSchema } from "@paperclipai/shared";
import { z } from "zod";
import { errorHandler } from "../middleware/error-handler.js";
import { validateIssueMutationBody } from "../middleware/validate.js";

// Mirrors the route-level schema in routes/issues.ts, including the `.strict()`
// that fixes KEE-579. The drift guard at the bottom of this file fails if the
// route stops being strict, so this mirror cannot quietly go stale.
const updateIssueRouteSchema = updateIssueSchema
  .extend({
    interrupt: z.boolean().optional(),
  })
  .strict();

const VALID_AGENT_ID = "4a323d0d-28ff-4974-ba69-9e0c9a3fc44d";

function buildApp(schema: Parameters<typeof validateIssueMutationBody>[0] = updateIssueRouteSchema) {
  const handler = vi.fn((req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true, body: req.body });
  });
  const app = express();
  app.use(express.json());
  app.patch("/issues/:id", validateIssueMutationBody(schema), handler);
  app.use(errorHandler);
  return { app, handler };
}

describe("issue PATCH assignee field contract (KEE-579)", () => {
  it("persists assigneeAgentId and keeps it in the parsed body handed to the route", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({ assigneeAgentId: VALID_AGENT_ID });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
    // The field must survive validation, not just the status code.
    expect(handler.mock.calls[0][0].body).toMatchObject({
      assigneeAgentId: VALID_AGENT_ID,
    });
    // An absent key must stay absent so a patch cannot overwrite a stored
    // assignee with a default.
    expect(handler.mock.calls[0][0].body).not.toHaveProperty("assigneeId");
  });

  // The card's core complaint: a caller sends a field that does not exist and
  // gets HTTP 200 with the mutation silently discarded. Under the non-strict
  // schema Zod stripped the unknown key, so this returned 200 and the route saw
  // a body with no assignment at all. It must now be a 400 naming the field.
  it("rejects a body whose only key is the non-existent assigneeId", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({ assigneeId: VALID_AGENT_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    // The reason must name the offending key, so the caller can see which
    // field was wrong rather than just that something was.
    const details = res.body.details as { code: string; keys?: string[] }[];
    expect(details).toHaveLength(1);
    expect(details[0].code).toBe("unrecognized_keys");
    expect(details[0].keys).toContain("assigneeId");
    expect(handler).not.toHaveBeenCalled();
  });

  it("still accepts a valid assigneeAgentId alongside other real fields", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({ assigneeAgentId: VALID_AGENT_ID, status: "in_progress" });

    expect(res.status).toBe(200);
    expect(handler.mock.calls[0][0].body).toMatchObject({
      assigneeAgentId: VALID_AGENT_ID,
      status: "in_progress",
    });
  });

  it("rejects assigneeId even when mixed with valid fields, so the error is not masked", async () => {
    const { app, handler } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({ assigneeId: VALID_AGENT_ID, status: "in_progress" });

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an empty assigneeAgentId rather than writing it", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({ assigneeAgentId: "" });

    expect(res.status).toBe(400);
  });

  it("keeps the existingBranch 422 contract intact", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/issues/0b066555-78db-4f6a-bf9e-3e189449403c`)
      .send({
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", existingBranch: "bad..branch" },
        },
      });

    expect(res.status).toBe(422);
  });
});

describe("issue PATCH route schema strictness (KEE-579)", () => {
  const routesSource = readFileSync(new URL("../routes/issues.ts", import.meta.url), "utf8");

  it("keeps the real issue PATCH route strict", () => {
    // The behaviour tests above use a mirror of this schema, so the mirror is
    // only trustworthy while the route itself is still strict. Match the whole
    // declaration up to its terminating `;` rather than the chain, so adding a
    // method call later does not silently defeat this guard.
    const declaration = routesSource.match(
      /const updateIssueRouteSchema = [\s\S]*?;/,
    )?.[0];
    expect(declaration).toBeDefined();
    expect(declaration).toMatch(/\.strict\(\)/);
  });

  it("still validates the issue PATCH route through the issue mutation validator", () => {
    const validators = Array.from(
      routesSource.matchAll(/\b(validate(?:IssueMutationBody)?)\(updateIssueRouteSchema\)/g),
      (match) => match[1],
    );
    expect(validators).toEqual(["validateIssueMutationBody"]);
  });
});
