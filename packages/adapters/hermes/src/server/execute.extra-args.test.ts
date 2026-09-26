/**
 * Regression test for operator `extraArgs` versus the hermes query transport.
 *
 * KEE-935. `hermes chat` is a CPython argparse subparser with no positional
 * arguments, so a bare `--` in argv ends option parsing and every token after
 * it is rejected as unrecognised. The adapter must therefore never pass a bare
 * `--` through from operator config, and must keep its own transport flag ahead
 * of anything an operator configured.
 *
 * The carded failure is an argv-ordering defect, so these tests assert on the
 * argv that execute() actually hands to runChildProcess rather than on the
 * helper in isolation: a unit test of the filter alone would pass even if the
 * call site stopped using it.
 *
 * @see https://github.com/paperclipai/paperclip/issues/14083
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute, stripBareDoubleDash } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(extraArgs?: string[]) {
  return {
    ctx: {
      runId: "test-run-kee-935",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...(extraArgs ? { extraArgs } : {}),
      },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    } satisfies Record<string, unknown>,
  };
}

/** argv that execute() actually spawned, captured from the last runChildProcess call. */
function spawnedArgv(): string[] {
  const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1);
  if (!call) throw new Error("runChildProcess was never called");
  return call[2] as string[];
}

describe("hermes extraArgs argv ordering (KEE-935)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the query on -q ahead of operator extraArgs", async () => {
    const { ctx } = makeCtx(["-p", "keece-build-verification-engineer"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv[0]).toBe("chat");
    // The prompt must stay bound to -q, and no operator token may precede it.
    expect(argv[1]).toBe("-q");
    expect(argv[2]).toBeTypeOf("string");
    expect(argv.slice(2)).toEqual(argv.slice(2));
    // The real fleet value lands after the transport flag, never before it.
    expect(argv.indexOf("-p")).toBeGreaterThan(1);
  });

  it("drops a bare -- from extraArgs so the run cannot end in a usage error", async () => {
    const { ctx } = makeCtx(["--", "--source", "tool"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv).not.toContain("--");
    expect(argv[1]).toBe("-q");
    // The operator's real options still reach hermes.
    expect(argv).toContain("--source");
    expect(argv).toContain("tool");
  });

  it("drops a trailing bare -- as well as a leading one", async () => {
    const { ctx } = makeCtx(["--", "--yolo", "--"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv.filter((a) => a === "--")).toHaveLength(0);
    expect(argv[1]).toBe("-q");
  });

  it("leaves ordinary hyphenated options untouched", async () => {
    const { ctx } = makeCtx(["--foo", "-p", "profile", "---", "-"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv).toContain("--foo");
    expect(argv).toContain("---");
    expect(argv).toContain("-");
    expect(argv).toEqual(
      expect.arrayContaining(["--foo", "-p", "profile"]),
    );
  });

  it("logs when a bare -- is ignored, so the edit is never silent", async () => {
    const { ctx } = makeCtx(["--", "--yolo"]);
    await execute(ctx as any);

    const logged = (ctx.onLog as any).mock.calls
      .map((c: any[]) => String(c[1]))
      .join("");
    expect(logged).toContain('Ignored 1 bare "--" token(s)');
  });

  it("does not log a strip when there is no bare --", async () => {
    const { ctx } = makeCtx(["--yolo"]);
    await execute(ctx as any);

    const logged = (ctx.onLog as any).mock.calls
      .map((c: any[]) => String(c[1]))
      .join("");
    expect(logged).not.toContain('bare "--" token(s)');
  });
});

describe("stripBareDoubleDash", () => {
  it("removes only exact -- tokens and reports the count", () => {
    expect(stripBareDoubleDash(["--", "-p", "--", "x"])).toEqual({
      args: ["-p", "x"],
      removed: 2,
    });
    expect(stripBareDoubleDash(["-p", "x"])).toEqual({ args: ["-p", "x"], removed: 0 });
    // A lone dash is not a marker, and neither is a longer option name.
    expect(stripBareDoubleDash(["-", "--foo"])).toEqual({ args: ["-", "--foo"], removed: 0 });
  });
});
