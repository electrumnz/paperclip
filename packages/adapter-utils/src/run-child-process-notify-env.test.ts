import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { execPath } from "node:process";

/**
 * The property under test, stated end-to-end: a process Paperclip spawns must
 * not be able to address the systemd notify socket of the unit that spawned it.
 *
 * The unit is `Type=notify` with `NotifyAccess=all`, so an inherited
 * NOTIFY_SOCKET is a write capability on the parent unit's socket. A child
 * that sends `STOPPING=1` moves the unit into deactivating/stop-sigterm with no
 * signal ever reaching the main process, so the main process never runs its own
 * shutdown path and the supervisor SIGKILLs the whole control group undrained
 * at TimeoutStopSec (KEE-1149).
 *
 * These drive the real `runChildProcess`, not a simulation of it, because the
 * defect this guards against is a *merge order* defect: the caller can scrub its
 * own env object and still lose the key, because this function re-spreads
 * `process.env` and merges the caller's env on top of it.
 */
describe("runChildProcess supervisor-notify env", () => {
  it("does not hand the spawned process the unit's NOTIFY_SOCKET", async () => {
    const original = process.env.NOTIFY_SOCKET;
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    try {
      // No `env` opt at all: the child inherits whatever this function builds
      // from process.env. This is the pure default path.
      const res = await runChildProcess(
        `probe-default-${Date.now()}`,
        execPath,
        ["-e", "process.stdout.write(String(process.env.NOTIFY_SOCKET ?? ''))"],
        { timeoutSec: 20 },
      );
      expect(res.stdout).toBe("");
    } finally {
      if (original === undefined) delete process.env.NOTIFY_SOCKET;
      else process.env.NOTIFY_SOCKET = original;
    }
  });

  it("does not restore the key when the caller passes a scrubbed env", async () => {
    // This is the regression the call-site-only fix missed. The Hermes adapter
    // builds its env by spreading process.env and then removing the notify keys.
    // That is correct in isolation, but this function merges the caller's env
    // *over a fresh copy of process.env*, so a caller that removed a key is
    // silently undone here.
    const original = process.env.NOTIFY_SOCKET;
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    try {
      const callerEnv: Record<string, string> = {};
      // Caller deliberately omits NOTIFY_SOCKET, having stripped it.
      const res = await runChildProcess(
        `probe-scrubbed-${Date.now()}`,
        execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({ns: process.env.NOTIFY_SOCKET ?? null, wd: process.env.WATCHDOG_PID ?? null}))",
        ],
        { env: callerEnv, timeoutSec: 20 },
      );
      expect(JSON.parse(res.stdout || "{}")).toEqual({ ns: null, wd: null });
    } finally {
      if (original === undefined) delete process.env.NOTIFY_SOCKET;
      else process.env.NOTIFY_SOCKET = original;
    }
  });

  it("still passes the environment the caller does supply", async () => {
    // Guard against a fix that scrubs by deleting the whole env instead of the
    // two named keys: PATH and the Paperclip variables must survive.
    const original = process.env.NOTIFY_SOCKET;
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    try {
      const res = await runChildProcess(
        `probe-preserve-${Date.now()}`,
        execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({k: process.env.KEE_PROBE_KEEP ?? null, p: process.env.PATH ?? null}))",
        ],
        { env: { KEE_PROBE_KEEP: "kept" } as NodeJS.ProcessEnv, timeoutSec: 20 },
      );
      const parsed = JSON.parse(res.stdout || "{}");
      expect(parsed.k).toBe("kept");
      expect(typeof parsed.p).toBe("string");
    } finally {
      if (original === undefined) delete process.env.NOTIFY_SOCKET;
      else process.env.NOTIFY_SOCKET = original;
    }
  });
});
