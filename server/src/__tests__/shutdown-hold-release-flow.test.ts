import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the real `shutdown()` control flow in index.ts, not a copy the test
 * supplies.
 *
 * The unit tests in `shutdown-admission-hold.test.ts` drive
 * `createShutdownAdmissionHold` and wrap their own calls in their own
 * try/finally, so they prove the helper behaves correctly but cannot prove the
 * production call site uses it. That gap is exactly what let RC5 through: the
 * helper was right, and the real `shutdown()` still called the release
 * unguarded between six awaits that can throw.
 *
 * This reads the actual source and asserts the shape that makes the release
 * unconditional. It is deliberately a structural assertion over the shipped
 * function rather than a second copy of its logic — the point is that the
 * production file has the guard, which a supplied copy could never show.
 */
const indexSource = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);

function shutdownFunctionSource(): string {
  const start = indexSource.indexOf("const shutdown = async (");
  expect(start, "shutdown() not found in index.ts").toBeGreaterThan(-1);
  const end = indexSource.indexOf('process.once("SIGINT"', start);
  expect(end, "end of shutdown() not found in index.ts").toBeGreaterThan(start);
  return indexSource.slice(start, end);
}

describe("shutdown() releases the admission hold on every path (RC5)", () => {
  it("runs the hold-to-release span under try/finally", () => {
    const body = shutdownFunctionSource();
    const finallyAt = body.lastIndexOf("} finally {");
    expect(finallyAt, "shutdown() has no finally around the release").toBeGreaterThan(-1);
    expect(body.slice(finallyAt)).toContain("admissionHold.releaseIfHeld");
  });

  it("engages the hold before the span and every teardown await is inside it", () => {
    const body = shutdownFunctionSource();
    const finallyAt = body.lastIndexOf("} finally {");
    const insideTry = body.slice(0, finallyAt);

    // The hold engages before the span opens. It cannot engage inside it: the
    // span exists to protect the hold that the engage created, and the engage
    // itself is reached through the coordinator's `closeSchedulerAdmission`.
    expect(insideTry.indexOf("admissionHold.hold()")).toBeGreaterThan(-1);

    // These awaits run after the hold is engaged and are each a point where the
    // teardown can throw. Any of them escaping the try would skip the release
    // and strand the marker.
    const throwableAwaits = [
      "await telemetryClient.flush()",
      "drainHeartbeatRunsForShutdown(",
      "drainRunExecutionFinalizersForShutdown(",
      "flushInFlightRunLogMirrors()",
      "finalizeServerShutdown(",
      "server.close(",
    ];
    for (const call of throwableAwaits) {
      const at = insideTry.indexOf(call);
      expect(at, `${call} not found before the finally`).toBeGreaterThan(-1);
    }

    // `systemdNotify` is the one await ahead of the engage, so it cannot
    // strand a hold that does not exist yet. Pin that ordering explicitly, so
    // moving the engage later cannot silently widen the uncovered window.
    expect(insideTry.indexOf("await systemdNotify(")).toBeGreaterThan(-1);
    expect(insideTry.indexOf("await systemdNotify(")).toBeLessThan(
      insideTry.indexOf("admissionHold.hold()"),
    );
  });

  it("awaits nothing after the release, so nothing can re-strand the hold", () => {
    const body = shutdownFunctionSource();
    const afterFinally = body.slice(body.lastIndexOf("} finally {"));
    // Only the synchronous `process.exit(0)` may follow. An await here would
    // be another way to throw past the release.
    expect(afterFinally).not.toMatch(/await\s/);
  });
});
