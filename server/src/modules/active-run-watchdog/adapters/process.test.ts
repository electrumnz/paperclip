import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { runningProcesses } from "../../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import { createProcessAdapter } from "./process.js";

vi.mock("../../../services/local-service-supervisor.js", () => ({
  isPidAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  terminateLocalService: vi.fn(),
}));

const mockedIsPidAlive = vi.mocked(isPidAlive);
const mockedIsProcessGroupAlive = vi.mocked(isProcessGroupAlive);
const mockedTerminateLocalService = vi.mocked(terminateLocalService);

// Real-process helpers. The orphan cases need genuinely live processes carrying a
// real `PAPERCLIP_RUN_ID`, because the production sweep reads /proc; a mocked
// liveness probe would not exercise the attribution at all.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

describe("adapters", () => {
  describe("createProcessAdapter", () => {
    beforeEach(() => {
      mockedIsPidAlive.mockReset();
      mockedIsProcessGroupAlive.mockReset();
      mockedTerminateLocalService.mockReset();
      runningProcesses.clear();
    });

    it("reports skipped_non_local_adapter for a non-sessioned adapter type", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "hermes_gateway",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({ attempted: false, outcome: "skipped_non_local_adapter", adapterType: "hermes_gateway" });
      expect(mockedIsPidAlive).not.toHaveBeenCalled();
    });

    it("reports no_process_metadata when no pid or process group is known", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: null,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: "codex_local",
        pid: null,
        processGroupId: null,
      });
    });

    it("reports not_running when the process is dead", async () => {
      mockedIsPidAlive.mockReturnValue(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: false,
        outcome: "not_running",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).not.toHaveBeenCalled();
    });

    it("reports terminated when the live process stops after termination", async () => {
      mockedIsPidAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "terminated",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).toHaveBeenCalledTimes(1);
    });

    it("reports failed when termination throws", async () => {
      mockedIsPidAlive.mockReturnValue(true);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockRejectedValue(new Error("kill failed"));
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "failed",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
        error: "kill failed",
      });
    });

    it("uses a valid process group when no pid is available", async () => {
      mockedIsProcessGroupAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: null,
        fallbackProcessGroupId: 4242,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "terminated",
        adapterType: "codex_local",
        pid: null,
        processGroupId: 4242,
      });
      expect(mockedTerminateLocalService).toHaveBeenCalledWith(
        { pid: 4242, processGroupId: 4242 },
        undefined,
      );
    });

    it.each([
      { fallbackPid: 0, fallbackProcessGroupId: null },
      { fallbackPid: -7, fallbackProcessGroupId: null },
      { fallbackPid: 4.5, fallbackProcessGroupId: null },
      { fallbackPid: null, fallbackProcessGroupId: 0 },
      { fallbackPid: null, fallbackProcessGroupId: -7 },
      { fallbackPid: null, fallbackProcessGroupId: 4.5 },
    ])(
      "reports no_process_metadata for invalid identifiers ($fallbackPid, $fallbackProcessGroupId)",
      async ({ fallbackPid, fallbackProcessGroupId }) => {
        mockedIsPidAlive.mockReturnValue(true);
        mockedIsProcessGroupAlive.mockReturnValue(false);
        mockedTerminateLocalService.mockResolvedValue(undefined);
        const adapter = createProcessAdapter();

        const outcome = await adapter.cleanupRunProcess({
          runId: "run-1",
          adapterType: "codex_local",
          fallbackPid,
          fallbackProcessGroupId,
        });

        expect(outcome).toEqual({
          attempted: false,
          outcome: "no_process_metadata",
          adapterType: "codex_local",
          pid: null,
          processGroupId: null,
        });
        expect(mockedIsPidAlive).not.toHaveBeenCalled();
        expect(mockedIsProcessGroupAlive).not.toHaveBeenCalled();
        expect(mockedTerminateLocalService).not.toHaveBeenCalled();
      },
    );

    // The orphan cases the 12:10:56Z oomd kill and the operator's 12:21Z
    // attribution both showed: the run's own process is gone, but a
    // `timeout`-wrapped descendant still carries the run id and is still holding
    // memory. The early returns below used to skip the sweep entirely, so
    // exactly these processes were the ones that accumulated.
    describe("orphan descendants (run process already gone)", () => {
      it("sweeps a live tagged descendant when the main pid and group are dead", async () => {
        const runId = `orphan-pgid-${process.pid}-${Date.now()}`;
        // A `timeout`-wrapped payload: its own process group, carrying the run id.
        const orphan = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
          stdio: "ignore",
          env: { ...process.env, PAPERCLIP_RUN_ID: runId },
        });
        // An unrelated process that must survive the sweep.
        const bystanderRunId = `bystander-${process.pid}-${Date.now()}`;
        const bystander = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
          stdio: "ignore",
          env: { ...process.env, PAPERCLIP_RUN_ID: bystanderRunId },
        });
        try {
          await new Promise((r) => setTimeout(r, 400));
          expect(pidAlive(orphan.pid!)).toBe(true);
          expect(pidAlive(bystander.pid!)).toBe(true);

          // Main process and its group are both dead: the group signal cannot
          // reach anything, which is the whole point of this branch.
          mockedIsPidAlive.mockReturnValue(false);
          mockedIsProcessGroupAlive.mockReturnValue(false);

          const outcome = await createProcessAdapter().cleanupRunProcess({
            runId,
            adapterType: "hermes_local",
            // A pid that is long gone.
            fallbackPid: 999_001,
            fallbackProcessGroupId: null,
          });

          // The orphan is reaped even though the main process was already dead.
          expect(await waitForExit(orphan.pid!, 5_000)).toBe(true);
          expect(outcome.attempted).toBe(true);
          expect(outcome.outcome).toBe("terminated");
          expect(
            (outcome as { escapedDescendantsSignaled?: number }).escapedDescendantsSignaled,
          ).toBeGreaterThan(0);
          expect(mockedTerminateLocalService).not.toHaveBeenCalled();

          // An unrelated run's process is untouched.
          expect(pidAlive(bystander.pid!)).toBe(true);
        } finally {
          for (const p of [orphan.pid, bystander.pid]) {
            try {
              process.kill(p!, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
      }, 20_000);

      it("sweeps a live tagged descendant when no process metadata exists at all", async () => {
        const runId = `orphan-nometa-${process.pid}-${Date.now()}`;
        const orphan = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
          stdio: "ignore",
          env: { ...process.env, PAPERCLIP_RUN_ID: runId },
        });
        try {
          await new Promise((r) => setTimeout(r, 400));
          expect(pidAlive(orphan.pid!)).toBe(true);

          // No pid and no process group: previously an immediate no-op return.
          const outcome = await createProcessAdapter().cleanupRunProcess({
            runId,
            adapterType: "hermes_local",
            fallbackPid: null,
            fallbackProcessGroupId: null,
          });

          expect(await waitForExit(orphan.pid!, 5_000)).toBe(true);
          expect(outcome.attempted).toBe(true);
          expect(outcome.outcome).toBe("terminated");
          expect(mockedTerminateLocalService).not.toHaveBeenCalled();
        } finally {
          try {
            process.kill(orphan.pid!, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }, 20_000);

      it("still reports not_running when there is nothing attributed to the run", async () => {
        mockedIsPidAlive.mockReturnValue(false);
        mockedIsProcessGroupAlive.mockReturnValue(false);

        const outcome = await createProcessAdapter().cleanupRunProcess({
          runId: `no-such-run-${process.pid}-${Date.now()}`,
          adapterType: "hermes_local",
          fallbackPid: 999_002,
          fallbackProcessGroupId: null,
        });

        expect(outcome).toEqual({
          attempted: false,
          outcome: "not_running",
          adapterType: "hermes_local",
          pid: 999_002,
          processGroupId: null,
        });
      });
    });
  });
});
