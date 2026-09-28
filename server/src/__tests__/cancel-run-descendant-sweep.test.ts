// Regression coverage for the cancellation path that left descendants alive.
//
// The operator's 12:21Z evidence: cancelled runs e1b9d30b, e65ddac3 and
// 3e71cf0e retained 24 / 22 / 6 child processes, including 11 and 19 embedded
// postgres fixture processes. `cancelRun` terminates through
// `terminateHeartbeatRunProcess`, which signalled only `-processGroupId`.
//
// A `timeout`-wrapped tool command makes `timeout` place its payload in a new
// process group (setpgid(0,0)), so the payload, pnpm and the vitest worker under
// it sit outside the run's group and survive cancellation. The fix sweeps by
// `PAPERCLIP_RUN_ID`, which every descendant inherits regardless of its group.
//
// Tested against `terminateHeartbeatRunProcess` directly rather than through
// `heartbeatService(...).cancelRun`, which needs a live database. This is the
// function the fix changes and every cancel call site funnels through it.
//
// These tests spawn only their own processes. No service, systemd unit, user bus
// or install path is touched, so this is safe to run on a host session.

import { describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";

const IS_LINUX = process.platform === "linux";

import { terminateHeartbeatRunProcess } from "../services/heartbeat.js";

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

function pgidOf(pid: number): number {
  return Number.parseInt(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
    10,
  );
}

describe.skipIf(!IS_LINUX)("terminateHeartbeatRunProcess descendant sweep", () => {
  it("reaps a descendant that escaped the run's process group", async () => {
    // The run root, spawned detached exactly as runChildProcess does.
    const runId = `cancel-sweep-${process.pid}-${Date.now()}`;
    const runRoot = spawn("/bin/bash", ["-c", "sleep 120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    // The escapee: `timeout` puts its payload in a new process group, so this is
    // outside the run root's group while carrying the same run id.
    const escapee = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(pidAlive(runRoot.pid!)).toBe(true);
      expect(pidAlive(escapee.pid!)).toBe(true);

      // The escapee must be provably outside the run root's group, otherwise this
      // test asserts nothing about the defect.
      expect(pgidOf(escapee.pid!)).not.toBe(pgidOf(runRoot.pid!));

      // Terminate exactly as a cancellation does.
      await terminateHeartbeatRunProcess({
        runId,
        pid: runRoot.pid,
        processGroupId: runRoot.pid,
        graceMs: 1_000,
      });

      // The escapee the group signal could not reach is now gone.
      expect(await waitForExit(escapee.pid!, 5_000)).toBe(true);
    } finally {
      for (const pid of [runRoot.pid, escapee.pid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      try {
        process.kill(-(runRoot.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 20_000);

  it("leaves a different run's descendants alone", async () => {
    // A descendant of some other run must survive our cancellation: the sweep
    // matches on the exact run id, so it is scoped to one run.
    const ourRunId = `ours-${process.pid}-${Date.now()}`;
    const otherRunId = `theirs-${process.pid}-${Date.now()}`;

    const ourRoot = spawn("/bin/bash", ["-c", "sleep 120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: ourRunId },
    });
    const otherRoot = spawn("/bin/bash", ["-c", "sleep 120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: otherRunId },
    });
    const otherEscapee = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: otherRunId },
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(pidAlive(otherEscapee.pid!)).toBe(true);

      await terminateHeartbeatRunProcess({
        runId: ourRunId,
        pid: ourRoot.pid,
        processGroupId: ourRoot.pid,
        graceMs: 1_000,
      });

      // The other run's escapee is untouched.
      expect(pidAlive(otherEscapee.pid!)).toBe(true);
      expect(pidAlive(otherRoot.pid!)).toBe(true);
    } finally {
      for (const pid of [ourRoot.pid, otherRoot.pid, otherEscapee.pid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);
});
