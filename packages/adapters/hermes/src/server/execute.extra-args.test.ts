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
 * Ordering note: on this branch the adapter pushes extraArgs BEFORE the prompt
 * transport flag, so the real argv is
 *   chat -m <model> --source tool --yolo [extraArgs...] -q <prompt>
 * An earlier revision of this file asserted the prompt sat at argv[1]. That was
 * true of master, where the transport flag is pushed first, and false here.
 * The assertions below encode the invariant that actually holds on this
 * branch: the prompt stays bound to -q as the final pair, and no bare "--"
 * survives anywhere that could end option parsing before it.
 *
 * @see https://github.com/paperclipai/paperclip/issues/14083
 */

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { HERMES_ARGV_PROMPT_LIMIT_BYTES } from "../shared/constants.js";

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

// Pure passthrough, matching execute.large-prompt.test.ts. An earlier revision
// stubbed readFile/writeFile/stat to empty no-op values, which made it impossible
// to create the real executable that the --query-file capability probe has to
// run. Nothing here needs fs stubbed: every case supplies its own config, and the
// probe is the thing under test rather than a side effect to be faked away.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual };
});

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

const tempDirs: string[] = [];

describe("hermes extraArgs argv ordering (KEE-935)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the query on -q ahead of any operator token that could shadow it", async () => {
    const { ctx } = makeCtx(["-p", "keece-build-verification-engineer"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv[0]).toBe("chat");
    // The prompt must stay bound to -q. This branch pushes extraArgs BEFORE the
    // transport flag, so the invariant is that -q comes last and nothing after
    // it can end option parsing: no bare "--" may sit to the left of -q.
    expect(argv.indexOf("-q")).toBeGreaterThan(1);
    const dashIndex = argv.indexOf("--");
    expect(dashIndex === -1 || dashIndex > argv.indexOf("-q")).toBe(true);
    expect(argv.indexOf("-q") + 1).toBe(argv.length - 1);
    // The real fleet value still reaches hermes.
    expect(argv).toContain("-p");
    expect(argv).toContain("keece-build-verification-engineer");
  });

  it("drops a bare -- from extraArgs so the run cannot end in a usage error", async () => {
    const { ctx } = makeCtx(["--", "--source", "tool"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv).not.toContain("--");
    // The prompt keeps its own flag, and the operator's real options survive.
    expect(argv[argv.length - 2]).toBe("-q");
    expect(argv).toContain("--source");
    expect(argv).toContain("tool");
  });

  it("drops a trailing bare -- as well as a leading one", async () => {
    const { ctx } = makeCtx(["--", "--yolo", "--"]);
    await execute(ctx as any);

    const argv = spawnedArgv();
    expect(argv.filter((a) => a === "--")).toHaveLength(0);
    expect(argv[argv.length - 2]).toBe("-q");
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

/**
 * The extraArgs tests above all drive a small prompt, so they only ever reach
 * the `-q <prompt>` transport. KEE-923 added a second transport for oversized
 * prompts — `--query-file -`, pushed AFTER the extraArgs block — and a bare
 * `--` in extraArgs ends option parsing before it just as much as before `-q`.
 * Nothing in this file covered that path, so the 7-test count was weaker
 * evidence than it looked on the branch that actually needs the strip.
 *
 * These cases drive an oversized prompt so the real transport is selected, and
 * assert the transport flag survives with no bare `--` to its left.
 */
describe("extraArgs on the stdin (--query-file) transport", () => {
  /** Executable stand-in for the hermes CLI, advertising --query-file. */
  async function makeFakeHermes(body: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "hermes-extra-args-"));
    tempDirs.push(dir);
    const file = path.join(dir, "hermes");
    await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(file, 0o755);
    return file;
  }

  const ADVERTISES_QUERY_FILE =
    `echo "usage: hermes chat [-h] [-q QUERY | --query-file PATH]"\n` +
    `echo "  --query-file PATH  Read the single query from a file"`;

  function makeCtx(extraArgs: string[], command: string) {
    const onLog = vi.fn(async () => undefined);
    return {
      onLog,
      ctx: {
        runId: "test-run-kee-947",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes",
          adapterType: "hermes_local",
          adapterConfig: {},
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command, timeoutSec: 60, graceSec: 5, extraArgs },
        context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
        onLog,
        onMeta: vi.fn(async () => undefined),
        onSpawn: vi.fn(async () => undefined),
      } satisfies Record<string, unknown>,
    };
  }

  /** A prompt past HERMES_ARGV_PROMPT_LIMIT_BYTES, so stdin transport is chosen. */
  function oversizedPrompt(): string {
    const unit = "synthetic wake history line 0123456789abcdef\n";
    const target = HERMES_ARGV_PROMPT_LIMIT_BYTES + 4096;
    return (
      "SYNTHETIC-PROMPT-MARKER-ABC123 " +
      unit.repeat(Math.ceil(target / unit.length)).slice(0, target)
    );
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps --query-file on argv when extraArgs carries a bare --", async () => {
    const command = await makeFakeHermes(ADVERTISES_QUERY_FILE);
    const { ctx, onLog } = makeCtx(["--", "--yolo"], command);
    await execute({
      ...ctx,
      context: { ...ctx.context, paperclipTaskMarkdown: oversizedPrompt() },
    } as never);

    const argv = spawnedArgv();
    // The branch this fixes: --query-file is pushed after the extraArgs block,
    // so a surviving bare `--` here would swallow the transport flag.
    expect(argv).toContain("--query-file");
    expect(argv).toContain("-");
    expect(argv.filter((a) => a === "--")).toHaveLength(0);
    // -q and --query-file are mutually exclusive in hermes' own parser.
    expect(argv).not.toContain("-q");
    // The operator's real tokens and the full prompt both still arrive.
    expect(argv).toContain("--yolo");
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[3].stdin as string).toContain("SYNTHETIC-PROMPT-MARKER-ABC123");
    expect(
      String(onLog.mock.calls.map((c: any[]) => c[1]).join("")),
    ).toContain('Ignored 1 bare "--" token(s)');
  });

  it("sends an oversized prompt on stdin even without a bare --, and still drops any", async () => {
    const command = await makeFakeHermes(ADVERTISES_QUERY_FILE);
    const { ctx } = makeCtx(["--source", "tool", "--"], command);
    await execute({
      ...ctx,
      context: { ...ctx.context, paperclipTaskMarkdown: oversizedPrompt() },
    } as never);

    const argv = spawnedArgv();
    expect(argv).toContain("--query-file");
    expect(argv.filter((a) => a === "--")).toHaveLength(0);
    expect(argv).toContain("--source");
    expect(argv).toContain("tool");
  });
});
