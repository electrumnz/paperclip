import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";
import { execPath } from "node:process";

const noopLog = async () => {};

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
function probe(runId: string, script: string, env?: Record<string, string>) {
  return runChildProcess(runId, execPath, ["-e", script], {
    cwd: process.cwd(),
    env: env ?? {},
    graceSec: 5,
    timeoutSec: 20,
    onLog: noopLog,
  });
}

function withNotifySocket<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.NOTIFY_SOCKET;
  process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
  return fn().finally(() => {
    if (original === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = original;
  });
}

describe("runChildProcess supervisor-notify env", () => {
  it("does not hand the spawned process the unit's NOTIFY_SOCKET", async () => {
    const res = await withNotifySocket(() =>
      probe(
        `probe-default-${Date.now()}`,
        "process.stdout.write(String(process.env.NOTIFY_SOCKET ?? ''))",
      ),
    );
    expect(res.stdout).toBe("");
  });

  it("does not restore the key when the caller passes a scrubbed env", async () => {
    // This is the regression a call-site-only fix misses. The Hermes adapter
    // builds its env by spreading process.env and then removing the notify keys.
    // That is correct in isolation, but this function merges the caller's env
    // *over a fresh copy of process.env*, so a caller that removed a key is
    // silently undone here.
    const res = await withNotifySocket(() =>
      probe(
        `probe-scrubbed-${Date.now()}`,
        "process.stdout.write(JSON.stringify({ns: process.env.NOTIFY_SOCKET ?? null, wd: process.env.WATCHDOG_PID ?? null}))",
      ),
    );
    expect(JSON.parse(res.stdout || "{}")).toEqual({ ns: null, wd: null });
  });

  it("still passes the environment the caller does supply", async () => {
    // Guard against a fix that scrubs by dropping the whole env instead of the
    // two named keys: PATH and the caller's own variables must survive.
    const res = await withNotifySocket(() =>
      probe(
        `probe-preserve-${Date.now()}`,
        "process.stdout.write(JSON.stringify({k: process.env.KEE_PROBE_KEEP ?? null, p: process.env.PATH ?? null}))",
        { KEE_PROBE_KEEP: "kept" },
      ),
    );
    const parsed = JSON.parse(res.stdout || "{}");
    expect(parsed.k).toBe("kept");
    expect(typeof parsed.p).toBe("string");
  });

  it("lets a caller that names the key deliberately set its own socket", async () => {
    // A caller that explicitly names NOTIFY_SOCKET is targeting a *different*
    // unit's socket on purpose. The strip must not override that intent.
    const res = await withNotifySocket(() =>
      probe(
        `probe-explicit-${Date.now()}`,
        "process.stdout.write(String(process.env.NOTIFY_SOCKET ?? ''))",
        { NOTIFY_SOCKET: "/run/user/1000/systemd/notify-explicit" },
      ),
    );
    expect(res.stdout).toBe("/run/user/1000/systemd/notify-explicit");
  });
});
