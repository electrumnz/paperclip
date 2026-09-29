import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The shutdown admission close is wired in `startServerWithDatabaseTeardown`
 * inside index.ts, which is not unit-testable without booting the server. These
 * assertions pin the wiring itself, because the regression they guard is a
 * change to that wiring rather than to any exported helper.
 */
const indexSource = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);

describe("shutdown scheduler admission close wiring", () => {
  it("engages the task drain without a TTL", () => {
    // A TTL re-opens the exact race the admission close prevents: it lifts the
    // drain part-way through a long run drain, so a scheduler sweep still in
    // flight can claim a run that is in neither the shutdown snapshot nor the
    // drain's selected set. The drain state is module-scope process memory, so
    // it cannot outlive the process and does not need to expire on its own.
    const close = indexSource.slice(
      indexSource.indexOf("closeSchedulerAdmission:"),
      indexSource.indexOf("log: logger,", indexSource.indexOf("closeSchedulerAdmission:")),
    );
    expect(close).toContain("heartbeat.startTaskDrain()");
    expect(close).not.toContain("ttlMs");
  });

  it("engages the drain at most once per shutdown", () => {
    // `startTaskDrain` replaces the stored drain and restarts its expiry clock,
    // so a second call would extend a drain an operator may have already lifted.
    const close = indexSource.slice(
      indexSource.indexOf("closeSchedulerAdmission:"),
      indexSource.indexOf("log: logger,", indexSource.indexOf("closeSchedulerAdmission:")),
    );
    expect(close).toContain("if (heartbeat.getTaskDrainStatus().draining) return;");
  });

  it("does not reintroduce a drain TTL constant", () => {
    expect(indexSource).not.toContain("SHUTDOWN_TASK_DRAIN_TTL_MS");
  });
});
