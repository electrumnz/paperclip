/**
 * Regression tests for the Hermes large-prompt transport.
 *
 * `hermes chat -q <prompt>` passes the prompt as a single argv string. Linux
 * caps one argv string at MAX_ARG_STRLEN (131072 bytes) regardless of ARG_MAX,
 * so a run whose wake history plus agent instructions cross that size used to
 * fail in `spawn()` with E2BIG and the agent never started.
 *
 * These tests cover three things:
 *   1. the byte threshold, measured against a real spawn, not a constant;
 *   2. the adapter's routing decision, for both transports;
 *   3. that the stdin path survives a child that never reads its input.
 *
 * Every payload here is synthetic. No real task, wake history, or credential
 * material is committed to this repository.
 *
 * @see KEE-923
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HERMES_ARGV_PROMPT_LIMIT_BYTES } from "../shared/constants.js";
import {
  hermesCommandSupportsQueryFile,
  promptExceedsArgvLimit,
} from "./cli-capabilities.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "done\n\nsession_id: synthetic-session\n",
      stderr: "",
      pid: null,
      startedAt: null,
      stdinWriteError: null,
    })),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * Build a prompt larger than the argv limit out of synthetic filler.
 * The marker at the head lets a test assert the content survived transport.
 */
function syntheticOversizedPrompt(totalBytes: number): string {
  const head = "SYNTHETIC-PROMPT-MARKER-ABC123 ";
  const fillerUnit = "synthetic wake history line 0123456789abcdef\n";
  const target = Math.max(totalBytes, HERMES_ARGV_PROMPT_LIMIT_BYTES + 4096);
  return head + fillerUnit.repeat(Math.ceil(target / fillerUnit.length)).slice(0, target - head.length);
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  const onLog = vi.fn(async () => undefined);
  const ctx = {
    runId: "run-kee-923",
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
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...overrides,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog,
    onMeta: vi.fn(async () => undefined),
    onSpawn,
  };
  return { ctx, onSpawn, onLog };
}

/** Write an executable stand-in for the hermes CLI and return its path. */
async function makeFakeHermes(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-fake-"));
  tempDirs.push(dir);
  const file = path.join(dir, "hermes");
  await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

describe("argv byte limit is a real kernel ceiling, not a constant", () => {
  // MAX_ARG_STRLEN is a Linux/BSD limit. macOS has no such per-string cap and
  // Windows has a 32KiB command-line limit instead, so the exact boundary is
  // only meaningful on Linux. The adapter itself is portable: this test pins
  // the premise of the threshold, not the portability of the fix.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("spawn fails with E2BIG exactly at MAX_ARG_STRLEN", () => {
    // Guards the premise of the whole fix: if Linux raised this ceiling, the
    // stdin transport would be unnecessary and the threshold would be wrong.
    const env = { PATH: "/usr/bin:/bin" };
    const limit = HERMES_ARGV_PROMPT_LIMIT_BYTES;

    const under = spawnSync("/bin/true", ["x".repeat(limit - 1)], { env });
    const atLimit = spawnSync("/bin/true", ["x".repeat(limit)], { env });

    expect(under.error).toBeUndefined();
    expect(under.status).toBe(0);
    expect(atLimit.error).toBeDefined();
    expect((atLimit.error as NodeJS.ErrnoException).code).toBe("E2BIG");
  });

  it("delivers a >128KB prompt over stdin where argv cannot", async () => {
    // A stand-in that reports how many bytes arrived on stdin, so this
    // asserts real transport, not just that spawn() did not throw.
    const script = `
payload=$(cat)
bytes=$(printf %s "$payload" | wc -c)
printf 'received_bytes=%s\\n' "$bytes"
`;
    const fake = await makeFakeHermes(script);

    const prompt = syntheticOversizedPrompt(HERMES_ARGV_PROMPT_LIMIT_BYTES + 50_000);
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(fake, ["chat", "--query-file", "-"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("close", (code) => resolve({ code, stdout: out }));
      child.stdin.end(prompt);
    });

    const received = Number(result.stdout.match(/received_bytes=(\d+)/)?.[1]);
    expect(result.code).toBe(0);
    // stdin carries the full prompt with no per-string truncation.
    expect(received).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(received).toBeGreaterThan(HERMES_ARGV_PROMPT_LIMIT_BYTES);
  });
});

describe("promptExceedsArgvLimit", () => {
  it("measures UTF-8 bytes, not string length", () => {
    // 40_000 astral-plane characters are 160_000 bytes but only 80_000 UTF-16
    // code units. A length-based check would wrongly pass this to argv.
    const astral = "🎉".repeat(40_000);
    expect(astral.length).toBeLessThan(HERMES_ARGV_PROMPT_LIMIT_BYTES);
    expect(Buffer.byteLength(astral, "utf8")).toBeGreaterThan(
      HERMES_ARGV_PROMPT_LIMIT_BYTES,
    );
    expect(promptExceedsArgvLimit(astral)).toBe(true);
  });

  it("leaves ordinary prompts on the existing argv transport", () => {
    expect(promptExceedsArgvLimit("short prompt")).toBe(false);
    expect(
      promptExceedsArgvLimit("x".repeat(HERMES_ARGV_PROMPT_LIMIT_BYTES - 1)),
    ).toBe(false);
    expect(
      promptExceedsArgvLimit("x".repeat(HERMES_ARGV_PROMPT_LIMIT_BYTES)),
    ).toBe(true);
  });
});

describe("hermesCommandSupportsQueryFile", () => {
  const env = { PATH: "/usr/bin:/bin" };

  it("detects a CLI that advertises the flag", async () => {
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"\necho "  --query-file PATH  Read the single query from a file"`,
    );
    await expect(
      hermesCommandSupportsQueryFile({ command: fake, cwd: ".", env }),
    ).resolves.toBe(true);
  });

  it("detects a CLI that lacks the flag", async () => {
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY]"\necho "  -q QUERY  the single query"`,
    );
    await expect(
      hermesCommandSupportsQueryFile({ command: fake, cwd: ".", env }),
    ).resolves.toBe(false);
  });

  it("returns null rather than guessing when the binary is missing", async () => {
    // A spawn failure must not be read as "no support": that would report a
    // misleading reason for a run that cannot start for an unrelated reason.
    await expect(
      hermesCommandSupportsQueryFile({
        command: "/nonexistent/hermes-binary",
        cwd: ".",
        env,
      }),
    ).resolves.toBeNull();
  });

  it("returns null on a nonzero help exit that printed no usage", async () => {
    const fake = await makeFakeHermes(`echo "boom" >&2\nexit 2`);
    await expect(
      hermesCommandSupportsQueryFile({ command: fake, cwd: ".", env }),
    ).resolves.toBeNull();
  });

  it("kills the probe and reports null when the run is cancelled", async () => {
    // A probe that ignores SIGTERM and never prints help: cancellation must
    // still take the process tree down, and must not hang the run.
    const fake = await makeFakeHermes(`trap '' TERM\nsleep 30`);
    const controller = new AbortController();
    const started = Date.now();
    const pending = hermesCommandSupportsQueryFile({
      command: fake,
      cwd: ".",
      env,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).resolves.toBeNull();
    // Resolve well inside the fake's own 30s sleep: the kill, not the sleep.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never spawns when the signal is already aborted", async () => {
    // A cancelled run must not start a new child at all.
    const fake = await makeFakeHermes(`echo "usage: hermes chat [-q QUERY | --query-file PATH]"`);
    const controller = new AbortController();
    controller.abort();
    await expect(
      hermesCommandSupportsQueryFile({
        command: fake,
        cwd: ".",
        env,
        signal: controller.signal,
      }),
    ).resolves.toBeNull();
  });

  it("still resolves normally when no signal is supplied", async () => {
    // Backwards compatibility: the signal is optional and must not change the
    // result of an ordinary probe.
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"`,
    );
    await expect(
      hermesCommandSupportsQueryFile({ command: fake, cwd: ".", env }),
    ).resolves.toBe(true);
  });
});

describe("adapter transport selection", () => {
  it("passes a small prompt as -q on argv and leaves stdin unset", async () => {
    const fake = await makeFakeHermes("true");
    const { ctx } = makeCtx({ command: fake });
    await execute(ctx as never);

    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    const args = call[2];
    expect(args).toContain("-q");
    expect(args).not.toContain("--query-file");
    expect(call[3].stdin).toBeUndefined();
  });

  it("keeps the quiet flag on both transports", async () => {
    // -Q is what makes hermes print only the response and the session_id line
    // that parseHermesOutput depends on. An oversized prompt must not change
    // that: dropping -Q here would break session resumption, not just output.
    const advertises = `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"`;

    const quietCtx = makeCtx({ command: await makeFakeHermes("true"), quiet: true });
    await execute(quietCtx.ctx as never);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2]).toContain("-Q");

    const fake = await makeFakeHermes(advertises);
    const { ctx } = makeCtx({ command: fake, quiet: true });
    const prompt = syntheticOversizedPrompt(137_659);
    await execute({
      ...ctx,
      context: { ...ctx.context, paperclipTaskMarkdown: prompt },
    } as never);

    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2];
    expect(args).toContain("-Q");
    expect(args).toContain("--query-file");
    expect(args).not.toContain("-q");
  });

  it("sends an oversized prompt on stdin and keeps it off argv", async () => {
    // This is the regression for KEE-923: the exact shape that produced E2BIG
    // on run 6932c727 (137659 bytes in one argv argument).
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"\necho "  --query-file PATH  Read the single query from a file"`,
    );
    const { ctx } = makeCtx({ command: fake });
    const prompt = syntheticOversizedPrompt(137_659);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(
      HERMES_ARGV_PROMPT_LIMIT_BYTES,
    );

    await execute({
      ...ctx,
      context: {
        ...ctx.context,
        // paperclipTaskMarkdown is the authoritative brief on this lane and is
        // what actually lands in the rendered prompt.
        paperclipTaskMarkdown: prompt,
      },
    } as never);

    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    const args = call[2];
    // The prompt must not appear in any argv string: that is the defect.
    const longestArg = Math.max(...args.map((a: string) => Buffer.byteLength(a, "utf8")));
    expect(longestArg).toBeLessThan(HERMES_ARGV_PROMPT_LIMIT_BYTES);
    expect(args).toContain("--query-file");
    expect(args).toContain("-");
    // -q and --query-file are mutually exclusive in hermes' own parser.
    expect(args).not.toContain("-q");
    // stdin carries the whole rendered prompt: the task brief plus the agent
    // template and runtime identity that surround it.
    const stdin = call[3].stdin as string;
    expect(stdin).toContain("SYNTHETIC-PROMPT-MARKER-ABC123");
    expect(Buffer.byteLength(stdin, "utf8")).toBeGreaterThan(
      HERMES_ARGV_PROMPT_LIMIT_BYTES,
    );
  });

  it("does not spawn at all, and names the limit, when the CLI lacks the flag", async () => {
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY]"\necho "  -q QUERY  the single query"`,
    );
    const { ctx, onLog } = makeCtx({ command: fake });
    const prompt = syntheticOversizedPrompt(137_659);

    const result = await execute({
      ...ctx,
      context: { ...ctx.context, paperclipTaskMarkdown: prompt },
    } as never);

    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
    expect(result.errorMessage).toContain(String(HERMES_ARGV_PROMPT_LIMIT_BYTES));
    // The refusal is explained in the run log, with the size and the remedy.
    const logs = (onLog.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ""))
      .join("");
    expect(logs).toContain("--query-file");
  });

  it("preserves the wake payload content across the stdin transport", async () => {
    // Source-trust boundary check: moving the prompt off argv must not drop,
    // reorder, or truncate authorized task history.
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"\necho "  --query-file PATH  Read the single query from a file"`,
    );
    const { ctx } = makeCtx({ command: fake });
    const marker = "SYNTHETIC-UNTRUSTED-BLOCK-MARKER";
    const padding = syntheticOversizedPrompt(HERMES_ARGV_PROMPT_LIMIT_BYTES + 4096);
    const description = `${padding}\n${marker}`;

    await execute({
      ...ctx,
      context: { ...ctx.context, paperclipTaskMarkdown: description },
    } as never);

    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    const stdin = call[3].stdin as string;
    // The authorized task history survives the move off argv, byte for byte,
    // with the rest of the rendered prompt wrapped around it.
    expect(stdin).toContain(marker);
    expect(stdin).toContain(padding);
    expect(Buffer.byteLength(stdin, "utf8")).toBeGreaterThanOrEqual(
      Buffer.byteLength(description, "utf8"),
    );
    // Still no Paperclip credential in the child environment.
    expect(call[3].env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");
  });

  it("reports cancellation instead of blaming the CLI when the run is cancelled mid-probe", async () => {
    // The probe returns "inconclusive" for cancellation, timeout and spawn
    // failure alike. Without this branch the operator is told to upgrade
    // Hermes when they are the reason the run stopped, and heartbeat.ts
    // records that wrong reason as the run error.
    const fake = await makeFakeHermes(`trap '' TERM\nsleep 30`);
    const { ctx, onLog } = makeCtx({ command: fake });
    const controller = new AbortController();
    const oversized = {
      ...ctx,
      signal: controller.signal,
      context: {
        ...ctx.context,
        paperclipTaskMarkdown: syntheticOversizedPrompt(137_659),
      },
    } as never;

    const pending = execute(oversized);
    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    // A cancelled run must not start the provider at all.
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("cancelled");
    expect(result.errorMessage).not.toContain("--query-file");
    // The refusal message must not be the one shown for a genuine gap.
    const logs = (onLog.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ""))
      .join("");
    expect(logs).toContain("cancelled");
    expect(logs).not.toContain("does not support --query-file");
  });

  it("surfaces a stdin write failure on the stdin transport", async () => {
    // EPIPE here means the prompt may never have reached the CLI, so a silent
    // exit 0 is indistinguishable from a complete answer without this line.
    const fake = await makeFakeHermes(
      `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"\necho "  --query-file PATH  Read the single query from a file"`,
    );
    const { ctx, onLog } = makeCtx({ command: fake });

    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "done\n\nsession_id: synthetic-session\n",
      stderr: "",
      pid: null,
      startedAt: null,
      stdinWriteError: "write EPIPE",
    } as never);

    await execute({
      ...ctx,
      context: {
        ...ctx.context,
        paperclipTaskMarkdown: syntheticOversizedPrompt(137_659),
      },
    } as never);

    const logs = (onLog.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ""))
      .join("");
    expect(logs).toContain("stdin write failed");
    expect(logs).toContain("EPIPE");
  });
});
