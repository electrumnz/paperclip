/**
 * Regression test: the hermes-local adapter must honour Paperclip's workspace
 * resolver instead of falling back to its own adapterConfig / server cwd.
 *
 * Before this change `execute()` resolved
 *   config.cwd || ctx.config?.workspaceDir || "."
 * and never called `refreshPaperclipWorkspaceEnvForExecution`, so a run whose
 * agent had no `adapterConfig.cwd` spawned Hermes in the Paperclip server's own
 * working directory and exported no workspace env at all. The agent then
 * inherited whatever its own profile default happened to be — a silent
 * landing in an unrelated tree.
 *
 * Every other local adapter (claude-local, codex-local, gemini-local, …) already
 * performs this handoff; hermes and hermes-gateway were the outliers.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

let realStat: typeof fs.stat;

function makeCtx(overrides: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return {
    ctx: {
      runId: "test-run-cwd",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
        sessionCwd: null,
      },
      config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5, ...overrides },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null, ...context },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    } satisfies Record<string, unknown>,
  };
}

/** The cwd runChildProcess was last invoked with. */
function spawnedCwd(): unknown {
  const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
  return (call[3] as Record<string, unknown>).cwd;
}

/** The env runChildProcess was last invoked with. */
function spawnedEnv(): Record<string, string> {
  const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
  return (call[3] as Record<string, unknown>).env as Record<string, string>;
}

describe("hermes-local adapter workspace resolution", () => {
  let realWorkspace: string;

  beforeEach(() => {
    vi.clearAllMocks();
    realStat = fs.stat;
    realWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ws-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(realWorkspace, { recursive: true, force: true });
  });

  it("spawns in the resolved workspace and exports it, with no adapterConfig.cwd", async () => {
    const { ctx } = makeCtx(
      {},
      { paperclipWorkspace: { cwd: realWorkspace, source: "project_primary", strategy: "project_primary" } },
    );

    await execute(ctx as any);

    expect(spawnedCwd()).toBe(realWorkspace);
    expect(spawnedEnv().PAPERCLIP_WORKSPACE_CWD).toBe(realWorkspace);
    expect(spawnedEnv().PAPERCLIP_WORKSPACE_SOURCE).toBe("project_primary");
  });

  it("prefers the resolved workspace over an operator-configured cwd", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-other-"));
    try {
      const { ctx } = makeCtx(
        { cwd: other },
        { paperclipWorkspace: { cwd: realWorkspace, source: "project_primary" } },
      );

      await execute(ctx as any);

      // The resolver is authoritative; adapterConfig.cwd is a fallback, not a
      // silent override of where the run is actually anchored.
      expect(spawnedCwd()).toBe(realWorkspace);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("still honours an explicit cwd for agent_home workspaces", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
    try {
      const { ctx } = makeCtx(
        { cwd: other },
        { paperclipWorkspace: { cwd: realWorkspace, source: "agent_home" } },
      );

      await execute(ctx as any);

      expect(spawnedCwd()).toBe(other);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("never spawns in the Paperclip server cwd when the resolver is absent", async () => {
    // Pre-fix this produced "." — the server's own working directory.
    const { ctx } = makeCtx();
    await execute(ctx as any);

    const cwd = spawnedCwd() as string;
    expect(cwd).not.toBe(".");
    expect(path.isAbsolute(cwd)).toBe(true);
  });

  it("falls back to the configured cwd and logs when the workspace is gone", async () => {
    const onLog = vi.fn(async () => undefined);
    const gone = path.join(realWorkspace, "deleted-tree");
    const { ctx } = makeCtx(
      { cwd: realWorkspace },
      { paperclipWorkspace: { cwd: gone, source: "project_primary" } },
    );

    await execute({ ...ctx, onLog } as any);

    expect(spawnedCwd()).toBe(realWorkspace);
    const logged = onLog.mock.calls
      .map((call) => String((call as unknown as [string, string])[1]))
      .join("");
    expect(logged).toContain(gone);
    expect(logged).toContain("falling back to");
  });

  it("does not export a workspace that was not resolved", async () => {
    const { ctx } = makeCtx();
    await execute(ctx as any);

    expect(spawnedEnv().PAPERCLIP_WORKSPACE_CWD).toBeUndefined();
  });

  it("tolerates non-string env entries (secret_ref bindings) when exporting", async () => {
    // Real adapterConfig.env in this fleet carries {type:"secret_ref",...}
    // objects alongside strings; the workspace handoff must not throw on them.
    const { ctx } = makeCtx(
      { env: { TYPESAFE_API_KEY: { type: "secret_ref", secretId: "abc" } } },
      { paperclipWorkspace: { cwd: realWorkspace, source: "project_primary" } },
    );

    await expect(execute(ctx as any)).resolves.toBeDefined();
    expect(spawnedCwd()).toBe(realWorkspace);
    expect(spawnedEnv().PAPERCLIP_WORKSPACE_CWD).toBe(realWorkspace);
  });
});
