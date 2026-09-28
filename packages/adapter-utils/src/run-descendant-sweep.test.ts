// Regression coverage for the process-group escape that let run descendants
// accumulate until systemd-oomd killed the service (2026-09-28 12:10:56Z,
// 1390 processes, app.slice at 64.85% pressure).
//
// The defect: `runChildProcess` spawns detached and kills `-processGroupId`,
// but a login shell started inside the run (`bash -lic "set +m; ..."`) disables
// job control, so each backgrounded job lands in a NEW process group that the
// group kill cannot reach. Measured on the live service, a 1.45 GB `tsc` sat in
// pgid 1357089 while its run root was pgid 1238478.
//
// The fix sweeps by `PAPERCLIP_RUN_ID`, which every descendant inherits
// regardless of the process group it ended up in.
//
// These tests spawn real processes but nothing service-shaped: no systemd, no
// user bus, no install/uninstall path, and every spawned pid belongs to this
// test process only. They are safe to run on a host session, and they are the
// reason the fix can be validated at all without touching the live service.

import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { sweepRunDescendantsByRunId, signalRunningProcess } from "./server-utils.js";

const IS_LINUX = process.platform === "linux";

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

describe.skipIf(!IS_LINUX)("sweepRunDescendantsByRunId", () => {
  it("signals a descendant that escaped into its own process group", async () => {
    // Reproduce the production shape: a login shell runs a script, and the
    // script wraps its work in `timeout` (as `timeout 900 pnpm --filter server
    // exec vitest ...` does). `timeout` places its payload in a new process
    // group via setpgid(0,0) — same session, different group — so neither the
    // payload nor anything it spawns is reachable by signalling the run's
    // process group.
    //
    // Two earlier drafts of this test asserted the wrong mechanism and the
    // assertions caught both: `set +m` DISABLES job control (it keeps
    // background jobs in the shell's own group), and a plain `&` in a
    // non-interactive script does not regroup either. `timeout` is the vector.
    const marker = `sweep-escape-${process.pid}-${Date.now()}`;
    const scriptPath = `/tmp/${marker}.sh`;
    const pidFile = `/tmp/${marker}.pid`;
    execFileSync("/bin/bash", [
      "-c",
      `printf '#!/bin/bash\\ntimeout 120 sleep 120 &\\necho $! > ${pidFile}\\nwait\\n' > ${scriptPath}; chmod +x ${scriptPath}`,
    ]);
    // The run root, spawned detached exactly as `runChildProcess` does.
    const runRoot = spawn("/bin/bash", ["-lic", `bash ${scriptPath}`], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAPERCLIP_RUN_ID: marker },
    });
    const escapees: number[] = [];
    try {
      // Wait for the script to record the backgrounded `timeout` pid.
      let escapedPid = 0;
      for (let i = 0; i < 100 && escapedPid === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          escapedPid = Number.parseInt(
            execFileSync("cat", [pidFile], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
            10,
          );
        } catch {
          // not written yet
        }
      }
      expect(Number.isInteger(escapedPid)).toBe(true);
      expect(escapedPid).toBeGreaterThan(0);
      escapees.push(escapedPid);

      const readField = (pid: number, field: string) =>
        Number.parseInt(
          execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
            encoding: "utf8",
          }).trim(),
          10,
        );

      // The payload leads its own process group but stays in this run's
      // session: the condition that defeats `process.kill(-processGroupId)`.
      expect(readField(escapedPid, "pgid")).toBe(escapedPid);
      expect(readField(escapedPid, "pgid")).not.toBe(runRoot.pid);
      expect(readField(escapedPid, "sid")).toBe(readField(runRoot.pid as number, "sid"));

      // `timeout`'s own payload (the `sleep`) is what holds memory, so capture it
      // too. It is a grandchild, in `timeout`'s group, and carries the marker.
      const payloadPid = Number.parseInt(
        execFileSync("bash", [
          "-c",
          `pgrep -P ${escapedPid} | head -1`,
        ]).toString().trim(),
        10,
      );
      if (Number.isInteger(payloadPid) && payloadPid > 0) escapees.push(payloadPid);

      // Group-kill the run root the way production does. It must NOT reach the
      // escaped child — if this assertion ever starts failing, the escape is no
      // longer the defect and this test is asserting the wrong thing.
      signalRunningProcess(
        { child: runRoot, processGroupId: runRoot.pid ?? null },
        "SIGKILL",
      );
      expect(await waitForExit(escapedPid, 1_000)).toBe(false);

      // The run-id sweep reaches what the group signal could not.
      const sweep = sweepRunDescendantsByRunId(marker, "SIGKILL");
      expect(sweep.signaledPids).toContain(escapedPid);
      expect(await waitForExit(escapedPid, 5_000)).toBe(true);
    } finally {
      try {
        process.kill(-(runRoot.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
      for (const pid of escapees) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      try {
        execFileSync("rm", ["-f", pidFile, scriptPath]);
      } catch {
        // best effort
      }
    }
  });

  it("never signals an excluded pid, including this process", () => {
    const marker = `sweep-exclude-${process.pid}-${Date.now()}`;
    // This test process does not carry the marker in its own environment, so to
    // prove the exclusion path we inject a pid list and assert nothing is
    // signalled when everything matched is excluded.
    const result = sweepRunDescendantsByRunId("a-run-id-nobody-has", "SIGKILL", {
      listPids: () => [process.pid, 1],
      excludePids: [process.pid, 1],
    });
    expect(result.signaledPids).toEqual([]);
    expect(result.excludedPids).toEqual([process.pid, 1]);
    expect(result.alreadyExited).toEqual([]);
    expect(marker).toContain("sweep-exclude");
    // The scan must not have touched this process.
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("is a no-op for an empty run id", () => {
    const result = sweepRunDescendantsByRunId("", "SIGKILL", {
      listPids: () => [1, 2, 3],
    });
    expect(result.signaledPids).toEqual([]);
    expect(result.matchedRunIds).toEqual([]);
  });

  it("does not signal a process carrying a different run id", () => {
    const result = sweepRunDescendantsByRunId("run-id-that-does-not-exist", "SIGKILL", {
      listPids: () => [process.pid, process.ppid ?? 1],
    });
    expect(result.signaledPids).toEqual([]);
    expect(result.matchedRunIds).toEqual([]);
    expect(pidAlive(process.pid)).toBe(true);
  });
});
