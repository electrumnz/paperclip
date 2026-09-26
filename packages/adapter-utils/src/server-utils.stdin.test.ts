/**
 * Regression test for runChildProcess's stdin write hardening.
 *
 * The hermes adapter pipes an oversized prompt into the child over stdin. A
 * child that exits before draining that input (a bad flag, an early crash, a
 * fast nonzero exit) closes the pipe, and the pending write fails with EPIPE.
 *
 * `child.stdin` is an EventEmitter with no default 'error' handling, so an
 * unhandled 'error' event is an uncaught exception that terminates the whole
 * Paperclip server rather than just the run. This test reproduces that failure
 * mode on the real implementation and asserts the run still completes.
 *
 * @see KEE-923
 */

import { describe, expect, it } from "vitest";

import { runChildProcess } from "./server-utils.js";

const baseEnv = { PATH: "/usr/bin:/bin" };

describe("runChildProcess stdin write failures", () => {
  it("does not raise an unhandled error when the child exits before reading stdin", async () => {
    // /bin/sh exits 3 immediately without draining stdin. A 1 MB write then
    // lands on a closed pipe.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const result = await runChildProcess(
        "run-kee-923-epipe",
        "/bin/sh",
        ["-c", "exit 3"],
        {
          cwd: ".",
          env: baseEnv,
          timeoutSec: 20,
          graceSec: 2,
          stdin: "x".repeat(1_000_000),
          onLog: async () => {},
        },
      );

      // The child's own failure is still reported faithfully.
      expect(result.exitCode).toBe(3);
      // The side-channel write failure is recorded rather than thrown.
      expect(result.stdinWriteError).toBeTruthy();
    } finally {
      // Give any stray async error a tick to surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.off("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
  });

  it("reports a clean run as having no stdin write error", async () => {
    // A child that drains stdin must not be reported as failed.
    const result = await runChildProcess(
      "run-kee-923-clean",
      "/bin/sh",
      ["-c", "cat > /dev/null"],
      {
        cwd: ".",
        env: baseEnv,
        timeoutSec: 20,
        graceSec: 2,
        stdin: "x".repeat(1_000_000),
        onLog: async () => {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdinWriteError ?? null).toBeNull();
  });

  it("routes a failing log store to onLogError instead of rejecting unhandled", async () => {
    // The stdin EPIPE handler logs its failure. If that log call rejects and
    // the promise is left unhandled, an EPIPE on the stdin path becomes an
    // unhandled rejection — the same class of failure as the uncaught
    // exception the handler above exists to prevent, just one level up. The
    // stdout/stderr handlers already chain .catch(onLogError); these two sites
    // must do the same.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const onLogErrors: Array<{ runId: string; message: string }> = [];

    try {
      const result = await runChildProcess(
        "run-kee-923-logfail",
        "/bin/sh",
        ["-c", "exit 3"],
        {
          cwd: ".",
          env: baseEnv,
          timeoutSec: 20,
          graceSec: 2,
          stdin: "x".repeat(1_000_000),
          // Every log call rejects, including the stdin write-failure line.
          onLog: async () => {
            throw new Error("log store unavailable");
          },
          onLogError: (err, runId, message) => {
            onLogErrors.push({ runId, message });
          },
        },
      );

      // The run still terminates on the child's own status, not on log failure.
      expect(result.exitCode).toBe(3);
      expect(result.stdinWriteError).toBeTruthy();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // The rejection was handled and attributed, not swallowed silently.
    expect(onLogErrors.length).toBeGreaterThan(0);
    expect(onLogErrors.some((entry) => entry.runId === "run-kee-923-logfail")).toBe(true);
  });
});
