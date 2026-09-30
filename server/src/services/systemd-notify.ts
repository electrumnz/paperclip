import { execFile } from "node:child_process";

// KEE-1149: the shutdown path's first await is
// `await systemdNotify(["--stopping", ...])`. An unbounded `execFile` there can
// park the teardown before it reaches anything else, and a supervisor that
// escalates on a stop timeout then SIGKILLs the whole process group, losing
// every child worker that was not drained. The notify send is a courtesy to the
// supervisor; it must never be able to hold the teardown open.
export const SYSTEMD_NOTIFY_TIMEOUT_MS = 2_000;

export async function systemdNotify(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  if (!process.env.NOTIFY_SOCKET?.trim()) return false;
  const timeoutMs = options.timeoutMs ?? SYSTEMD_NOTIFY_TIMEOUT_MS;
  return await new Promise<boolean>((resolve) => {
    // Resolve at most once even if the child later errors after the timeout has
    // already settled this promise; the caller's teardown moves on either way.
    let settled = false;
    const settle = (notified: boolean) => {
      if (settled) return;
      settled = true;
      resolve(notified);
    };
    execFile(
      "systemd-notify",
      args,
      { windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" },
      (error) => settle(!error),
    );
    // `execFile`'s own timeout does not fire if the process never spawns or the
    // event loop is starved, so the deadline is also enforced here. `unref` keeps
    // the timer from holding the process open on its own.
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
  });
}
