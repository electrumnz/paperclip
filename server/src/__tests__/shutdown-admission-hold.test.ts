import { describe, expect, it, vi } from "vitest";
import { createShutdownAdmissionHold } from "../shutdown.ts";

/**
 * Behavioural coverage for the shutdown admission hold's lifetime (KEE-1149).
 *
 * These drive the real helper against a faithful stand-in for the real
 * process-local task-drain state, so they exercise the release rules rather
 * than matching source text. The two invariants under test:
 *
 *   1. The hold spans the whole run drain, which has no overall deadline.
 *   2. The hold cannot survive the teardown that created it — including the
 *      programmatic `StartedServer.shutdown` path, where the process outlives
 *      the teardown and no `process.exit` clears the state.
 */

function makeDrainState() {
  // Mirrors heartbeat.ts: module-scope `taskDrainState`, an expiry, and the
  // suppression check that every admission path reads.
  let state: { startedAt: Date; expiresAt: Date | null } | null = null;
  return {
    get draining() {
      if (state && state.expiresAt !== null && state.expiresAt.getTime() <= Date.now()) {
        state = null;
      }
      return state !== null;
    },
    get expiresAt() {
      return this.draining ? state!.expiresAt : null;
    },
    start(ttlMs: number | null = null) {
      const startedAt = new Date();
      state = {
        startedAt,
        expiresAt: ttlMs === null ? null : new Date(startedAt.getTime() + ttlMs),
      };
    },
    stop() {
      state = null;
    },
  };
}

function stubLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

describe("shutdown admission hold", () => {
  it("holds admission with no expiry, so a long drain cannot reopen the claim race", () => {
    const drain = makeDrainState();
    const hold = createShutdownAdmissionHold({
      engage: () => {
        drain.start(null);
        return true;
      },
      release: () => drain.stop(),
    });

    hold.hold();
    expect(drain.draining).toBe(true);
    // A TTL would lapse here and let an in-flight sweep claim a run mid-drain.
    // The run drain has no overall deadline, so the hold must not expire.
    expect(drain.expiresAt).toBeNull();

    vi.setSystemTime(new Date(Date.now() + 60 * 60_000));
    expect(drain.draining).toBe(true);
    vi.useRealTimers();
  });

  it("releases the hold when the teardown finishes without exiting the process", () => {
    // This is the programmatic `StartedServer.shutdown` path
    // (`shutdown(signal, false)`), reachable from cli/src/commands/run.ts when
    // an `afterStart` hook throws. Nothing calls `process.exit`, so process
    // memory — including the drain — would otherwise persist and suppress run
    // admission indefinitely in a process that stays alive.
    const drain = makeDrainState();
    const log = stubLogger();
    const hold = createShutdownAdmissionHold({
      engage: () => {
        drain.start();
        return true;
      },
      release: () => drain.stop(),
      log,
    });

    hold.hold();
    expect(drain.draining).toBe(true);

    hold.releaseIfHeld("SIGTERM", false);

    expect(drain.draining).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      expect.stringContaining("releasing"),
    );
  });

  it("leaves the hold in place on the signal path, where the process exits", () => {
    // `process.exit(0)` clears the process-local state, so releasing here would
    // be redundant. More importantly it must not run: a hold that an operator
    // owns must never be dropped by a shutdown.
    const drain = makeDrainState();
    const release = vi.fn(() => drain.stop());
    const hold = createShutdownAdmissionHold({
      engage: () => {
        drain.start();
        return true;
      },
      release,
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", true);

    expect(release).not.toHaveBeenCalled();
    expect(drain.draining).toBe(true);
  });

  it("never releases a pre-existing operator drain", () => {
    // Operator ownership is preserved: an operator drain that predates the
    // signal is released only by its own route.
    const drain = makeDrainState();
    drain.start(null); // operator engages it first
    const release = vi.fn(() => drain.stop());
    const hold = createShutdownAdmissionHold({
      engage: () => false, // shutdown declines to engage over it
      release,
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", false);

    expect(release).not.toHaveBeenCalled();
    expect(drain.draining).toBe(true);
  });

  it("does not re-engage on a second hold call", () => {
    // A second engage would restart an expiry clock on a drain an operator may
    // have lifted in the meantime.
    const drain = makeDrainState();
    const engage = vi.fn(() => {
      drain.start(null);
      return true;
    });
    const hold = createShutdownAdmissionHold({
      engage,
      release: () => drain.stop(),
    });

    hold.hold();
    hold.hold();
    hold.hold();

    expect(engage).toHaveBeenCalledTimes(1);
  });

  it("releases only once across a repeated non-exiting teardown", () => {
    const drain = makeDrainState();
    const release = vi.fn(() => drain.stop());
    const hold = createShutdownAdmissionHold({
      engage: () => {
        drain.start(null);
        return true;
      },
      release,
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", false);
    hold.releaseIfHeld("SIGTERM", false);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("can hold and release again across a second teardown", () => {
    // A retried startup (`afterStart` throws, the caller retries) must be able to
    // take a fresh hold, not be stuck with the previous call's released state.
    const drain = makeDrainState();
    const hold = createShutdownAdmissionHold({
      engage: () => {
        drain.start(null);
        return true;
      },
      release: () => drain.stop(),
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", false);
    expect(drain.draining).toBe(false);

    hold.hold();
    expect(drain.draining).toBe(true);
  });
});
