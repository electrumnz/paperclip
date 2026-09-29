/**
 * Regression tests for the KEE-1154 false failure: a resumed-session banner
 * whose *title* contains an error keyword turned a successful exit-0 run into
 * `adapter_failed`.
 *
 * Observed on live run ea8f13f4-2c62-461a-a763-2f52d54d9049: Hermes wrote its
 * quiet-mode resume banner to stderr (so stdout stays machine-readable), the
 * session title contained the word "exceptional", and `parseHermesOutput`
 * scanned stderr with an unanchored `/error|exception|traceback|failed/i`.
 * The adapter therefore set `errorMessage` on an otherwise clean exit-0 run,
 * and `heartbeat.ts` maps a run with an `errorMessage` to `failed` /
 * `adapter_failed` even though the exit code was 0 and the outcome was saved.
 *
 * The fix must be narrow. These tests also pin the negative controls: a real
 * error on stderr must still be reported, including on exit 0, and the nonzero
 * exit / timeout / cancellation paths must be untouched.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
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

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx() {
  return {
    runId: "test-run-kee-1154",
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
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } satisfies Record<string, unknown>;
}

function runOnce(overrides: {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  signal?: string | null;
}) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: overrides.exitCode,
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    pid: null,
    startedAt: null,
  });
}

/**
 * Verbatim stderr from live run ea8f13f4-2c62-461a-a763-2f52d54d9049, whose
 * exit code was 0, which was not timed out, and which had already saved its
 * task outcome. The session title is the trigger: "exceptional" contains
 * "exception".
 */
const OBSERVED_RESUME_BANNER_STDERR =
  "[fleet] Using Paperclip resolved workspace: /home/love4vengeance/.paperclip/instances/default/projects/61c22786-c976-4903-bb57-62de53cc9877/764356a4-004b-463e-ac7b-122ff1eea14d/_default\n" +
  '↻ Resumed session 20260929_233038_078840 "Set Sam’s exceptional approval boundaries" (2 user messages, 222 total messages)\n';

describe("hermes adapter stderr banner handling (KEE-1154)", () => {
  it("does not report a successful run as failed when the resumed-session title contains an error keyword", async () => {
    // The reproduced defect: exit 0, no timeout, no genuine error anywhere in
    // stderr — only an informational resume banner whose title reads
    // "exceptional approval boundaries".
    runOnce({
      exitCode: 0,
      stdout: "[hermes] Starting Hermes Agent (model=local-router, provider=auto [auto], timeout=3600s)\n\nDone.\n\nsession_id: 20260929_233038_078840\n",
      stderr: OBSERVED_RESUME_BANNER_STDERR,
    });

    const result = await execute(makeCtx() as never);

    // No errorMessage is the exact precondition heartbeat.ts uses to decide
    // `succeeded` for an exit-0 run (see the `!adapterResult.errorMessage`
    // branch of the run-session outcome resolution).
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
    expect(result.errorFamily).toBeUndefined();
    // The run's actual work is still reported: only the failure signal is gone.
    expect(result.sessionParams).toEqual({ sessionId: "20260929_233038_078840" });
  });

  it.each([
    'a resumed session titled "Fix the error handling boundary"',
    'a resumed session titled "Failed deploy rollback"',
    'a resumed session titled "Set Sam’s exceptional approval boundaries"',
    'a resumed session titled "traceback capture for the router"',
  ])("ignores a resume banner for %s", async (title) => {
    runOnce({
      exitCode: 0,
      stdout: "ok\n\nsession_id: sess-1\n",
      stderr: `↻ Resumed session sess-1 "${title}" (2 user messages, 222 total messages)\n`,
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });

  it("ignores the informational no-messages resume banners", async () => {
    runOnce({
      exitCode: 0,
      stdout: "ok\n\nsession_id: sess-2\n",
      stderr:
        '↻ Resumed session sess-2 "Failed deploy rollback" — no messages, starting fresh.\n' +
        "Session sess-2 found but has no messages. Starting fresh.\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });

  // ── Negative controls: real errors must still be reported ───────────────

  it("still reports a genuine error on stderr when the run exited 0", async () => {
    // Not a banner. Exit 0 alone must not launder a real error line, which is
    // how a real exit-0 provider failure stays visible.
    runOnce({
      exitCode: 0,
      stdout: "",
      stderr: "Error: the model produced no usable response\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Error: the model produced no usable response");
  });

  it("still reports a real exception and traceback on stderr", async () => {
    runOnce({
      exitCode: 0,
      stdout: "",
      stderr:
        "Traceback (most recent call last):\n" +
        '  File "run.py", line 1\n' +
        "Exception: unhandled\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toContain("Traceback");
    expect(result.errorMessage).toContain("Exception");
  });

  it("still reports a nonzero exit whose only stderr line is an unmatched word", async () => {
    // "Session not found" never matched the failure regex, before or after the
    // fix, so the exit-code fallback is what carries this diagnostic. Pinning
    // it keeps the filter from silently swallowing non-matching stderr.
    runOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Session not found: sess-missing\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Hermes exited with code 1");
  });

  it("keeps the real error when a resume banner and a failure share stderr", async () => {
    runOnce({
      exitCode: 1,
      stdout: "",
      stderr:
        '↻ Resumed session sess-3 "exceptional approval boundaries" (1 user message, 9 total messages)\n' +
        "Error: provider unavailable\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("still classifies a real exit-0 provider failure on stderr", async () => {
    // Preserves the KEE-593 provider-failure typing: the informational banner
    // is not a reason to stop detecting genuine upstream failures.
    runOnce({
      exitCode: 0,
      stdout: "",
      stderr: "HTTP 502: Atria connection failed. No other model was used.\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("does not let the word exceptional in a real error line hide the failure", async () => {
    // Word-boundary precision: "exceptional" is not the keyword "exception",
    // but a line that also names a real error is still reported.
    runOnce({
      exitCode: 0,
      stdout: "",
      stderr: "RuntimeError: encountered an exceptional condition while calling the provider\n",
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe(
      "RuntimeError: encountered an exceptional condition while calling the provider",
    );
  });

  // ── Existing path guards must not regress ──────────────────────────────

  it("still reports the exit code for a nonzero exit carrying only a banner", async () => {
    runOnce({
      exitCode: 130,
      stdout: "",
      stderr:
        '↻ Resumed session sess-4 "exceptional approval boundaries" (1 user message, 9 total messages)\n',
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves a timeout to the heartbeat timeout path even with a banner present", async () => {
    runOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr:
        '↻ Resumed session sess-5 "exceptional approval boundaries" (1 user message, 9 total messages)\n',
    });

    const result = await execute(makeCtx() as never);

    expect(result.timedOut).toBe(true);
    expect(result.errorFamily).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });

  it("does not treat signal cancellation as a failure", async () => {
    runOnce({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr:
        '↻ Resumed session sess-6 "exceptional approval boundaries" (1 user message, 9 total messages)\n',
    });

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBeUndefined();
  });
});
