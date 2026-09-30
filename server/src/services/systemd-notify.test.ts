import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { SYSTEMD_NOTIFY_TIMEOUT_MS, systemdNotify } from "./systemd-notify.js";

const originalSocket = process.env.NOTIFY_SOCKET;

describe("systemdNotify", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
  });

  afterEach(() => {
    if (originalSocket === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = originalSocket;
    vi.useRealTimers();
  });

  it("returns false without spawning when NOTIFY_SOCKET is unset", async () => {
    delete process.env.NOTIFY_SOCKET;
    await expect(systemdNotify(["--ready"])).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("passes the args through and reports success", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null));
    await expect(systemdNotify(["--ready", "--status=Listening"])).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["--ready", "--status=Listening"]);
  });

  it("reports failure when the child errors", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(new Error("spawn failed")),
    );
    await expect(systemdNotify(["--stopping"])).resolves.toBe(false);
  });

  // KEE-1149: this is the regression. The shutdown path awaits this function
  // before anything else, so a send that never calls back used to park the
  // teardown until the supervisor escalated to SIGKILL.
  it("resolves false at the deadline when the child never calls back", async () => {
    execFileMock.mockImplementation(() => {
      /* never invokes the callback: the wedged spawn */
    });
    const started = Date.now();
    await expect(systemdNotify(["--stopping"])).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(SYSTEMD_NOTIFY_TIMEOUT_MS * 5);
  });

  it("gives execFile its own timeout and killSignal", () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null));
    void systemdNotify(["--stopping"]);
    const opts = execFileMock.mock.calls[0]?.[2] as { timeout?: number; killSignal?: string };
    expect(opts.timeout).toBe(SYSTEMD_NOTIFY_TIMEOUT_MS);
    expect(opts.killSignal).toBe("SIGKILL");
  });

  it("does not let a late child error flip an already-settled result", async () => {
    let lateCb: ((err: Error | null) => void) | undefined;
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      lateCb = cb;
    });
    const pending = systemdNotify(["--stopping"], { timeoutMs: 5 });
    await expect(pending).resolves.toBe(false);
    lateCb?.(new Error("arrived after the deadline"));
    // The promise is already settled; a second settle must be a no-op.
    await expect(pending).resolves.toBe(false);
  });

  it("honours a caller-supplied timeout", async () => {
    execFileMock.mockImplementation(() => {
      /* never calls back */
    });
    const started = Date.now();
    await expect(systemdNotify(["--stopping"], { timeoutMs: 20 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
