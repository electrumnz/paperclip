/**
 * End-to-end proof that the ported provider-failure classification reaches the
 * adapter's typed result, using the real observed Atria HTTP 502 output.
 *
 * The unit test covers the classifier in isolation. This file covers the wiring:
 * that `execute()` actually calls it and writes `errorCode` / `errorFamily` /
 * `retryNotBefore` onto the `AdapterExecutionResult` the heartbeat persists.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 1,
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
    runId: "test-run-provider-failure",
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

function failWith(stderr: string) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: null,
    startedAt: null,
  });
}

describe("hermes adapter provider failure classification wiring", () => {
  it("types the real observed Atria HTTP 502 as transient_upstream", async () => {
    // Verbatim from the 2026-09-23 pilot observation recorded in PILOT-FIXES.md.
    failWith(
      "API call failed after 1 retries: HTTP 502: Atria connection failed. No other model was used.",
    );

    const result = await execute(makeCtx() as never);

    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBeUndefined();
  });

  it("carries the provider's stated wait through to retryNotBefore", async () => {
    failWith('atria_rate_limited {"retry_after_seconds":120}');

    const before = Date.now();
    const result = await execute(makeCtx() as never);
    const after = Date.now();

    expect(result.errorCode).toBe("hermes_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    const retryNotBefore = new Date(result.retryNotBefore ?? "").getTime();
    // 120s backoff, allowing for the two reads of the clock.
    expect(retryNotBefore).toBeGreaterThanOrEqual(before + 119_000);
    expect(retryNotBefore).toBeLessThanOrEqual(after + 121_000);
  });

  it("marks a rendered quota exhaustion as terminal provider_quota", async () => {
    failWith("HTTP 429: Atria account quota exhausted; operator action required.");

    const result = await execute(makeCtx() as never);

    // The upstream literal, not `hermes_provider_quota`: only `provider_quota`
    // is allow-listed by `classifyAdapterFailureForRecovery` and registered in
    // `TRANSIENT_INFRA_CONTINUATION_ERROR_CODES`, so an adapter-prefixed name
    // would classify as `default` and never schedule quota recovery.
    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorFamily).toBe("provider_quota");
  });

  it("leaves an unrelated failure unclassified so existing handling is unchanged", async () => {
    failWith("Error: provider unavailable\n");

    const result = await execute(makeCtx() as never);

    expect(result.errorMessage).toBe("Error: provider unavailable");
    expect(result.errorFamily).toBeUndefined();
  });

  it("does not classify a timed-out run from provider text inside its output", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "HTTP 502: Atria connection failed",
      pid: null,
      startedAt: null,
    });

    const result = await execute(makeCtx() as never);

    // The port must not classify a timed-out run. `errorMessage` still carries
    // the stderr text, but that is pre-existing upstream behaviour (execute.ts
    // sets it from parseHermesOutput before the classification runs) and is the
    // diagnostic the heartbeat's timeout path wants to keep.
    expect(result.errorFamily).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
    expect(result.retryNotBefore).toBeUndefined();
  });
});
