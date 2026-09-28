import { runningProcesses, sweepRunDescendantsByRunId } from "../../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import type { RunProcessController } from "../application/ports.js";
import type { RunProcessCleanupOutcome, RunProcessMetadata } from "../application/types.js";

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

function isValidPositivePid(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createProcessAdapter(): RunProcessController {
  return {
    async cleanupRunProcess(input: RunProcessMetadata): Promise<RunProcessCleanupOutcome> {
      if (!SESSIONED_LOCAL_ADAPTERS.has(input.adapterType)) {
        return { attempted: false, outcome: "skipped_non_local_adapter", adapterType: input.adapterType };
      }

      const running = runningProcesses.get(input.runId);
      const registeredPid = running?.child.pid ?? null;
      const registeredProcessGroupId = running?.processGroupId ?? null;
      const pid = isValidPositivePid(registeredPid)
        ? registeredPid
        : isValidPositivePid(input.fallbackPid)
          ? input.fallbackPid
          : null;
      const processGroupId = isValidPositivePid(registeredProcessGroupId)
        ? registeredProcessGroupId
        : isValidPositivePid(input.fallbackProcessGroupId)
          ? input.fallbackProcessGroupId
          : null;
      const terminationPid = pid ?? processGroupId;

      // Descendant cleanup is keyed on the run id in the environment, not on the
      // run's own process being alive.
      //
      // The orphan case is the common one after a crash or an oomd kill: Hermes
      // and the main process group are already gone, but a `timeout`-wrapped or
      // login-shell descendant is still holding hundreds of MB. Returning early
      // on "no metadata" or "not running" left exactly those holding memory
      // forever, because the group signal has nothing left to signal.
      //
      // So the sweep runs on every path, including the early returns below, and
      // its result is attached to the outcome. The direct child is excluded only
      // when it is still ours to signal; the helper always excludes this
      // process.
      const sweepDescendants = (): number => {
        try {
          return sweepRunDescendantsByRunId(input.runId, "SIGKILL", {
            excludePids: [process.pid],
          }).signaledPids.length;
        } catch {
          // Best effort: never turn a cleanup outcome into a reported failure.
          return 0;
        }
      };

      if (terminationPid === null) {
        const escapedDescendantsSignaled = sweepDescendants();
        if (escapedDescendantsSignaled > 0) {
          return {
            attempted: true,
            outcome: "terminated",
            adapterType: input.adapterType,
            pid,
            processGroupId,
            escapedDescendantsSignaled,
          };
        }
        return {
          attempted: false,
          outcome: "no_process_metadata",
          adapterType: input.adapterType,
          pid,
          processGroupId,
        };
      }

      const wasAlive =
        (pid !== null && isPidAlive(pid)) ||
        (processGroupId !== null && isProcessGroupAlive(processGroupId));
      if (!wasAlive) {
        // No process group left to signal, but attributed descendants may still
        // be alive. Sweep before reporting, otherwise this is the branch that
        // leaks the memory this whole change exists to reclaim.
        const escapedDescendantsSignaled = sweepDescendants();
        runningProcesses.delete(input.runId);
        if (escapedDescendantsSignaled > 0) {
          return {
            attempted: true,
            outcome: "terminated",
            adapterType: input.adapterType,
            pid,
            processGroupId,
            escapedDescendantsSignaled,
          };
        }
        return {
          attempted: false,
          outcome: "not_running",
          adapterType: input.adapterType,
          pid,
          processGroupId,
        };
      }

      try {
        await terminateLocalService(
          {
            pid: terminationPid,
            processGroupId,
          },
          running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
        );
        // `terminateLocalService` signals the run's process group, which does not
        // contain descendants a `timeout`-wrapped command placed in a group of
        // their own. Those escapees are what accumulated until oomd killed the
        // service, so sweep them by run id as well.
        const escapedDescendantsSignaled = sweepDescendants();
        runningProcesses.delete(input.runId);
        const stillAlive =
          (pid !== null && isPidAlive(pid)) ||
          (processGroupId !== null && isProcessGroupAlive(processGroupId));
        return {
          attempted: true,
          outcome: stillAlive ? "termination_sent_still_running" : "terminated",
          adapterType: input.adapterType,
          pid,
          processGroupId,
          ...(escapedDescendantsSignaled > 0 ? { escapedDescendantsSignaled } : {}),
        };
      } catch (error) {
        return {
          attempted: true,
          outcome: "failed",
          adapterType: input.adapterType,
          pid,
          processGroupId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
