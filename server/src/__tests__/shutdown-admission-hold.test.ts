import { describe, expect, it, vi } from "vitest";
import {
  createShutdownAdmissionHold,
  engageShutdownAdmissionHold,
} from "../shutdown.ts";

/**
 * Behavioural coverage for the shutdown admission hold's lifetime (KEE-1149).
 *
 * These drive the real helper against a faithful stand-in for the real
 * process-local task-drain state, so they exercise the release and ownership
 * rules rather than matching source text. The invariants under test:
 *
 *   1. The hold spans the whole run drain, which has no overall deadline.
 *   2. The hold cannot survive the teardown that created it, including the
 *      programmatic `StartedServer.shutdown` path where the process outlives
 *      the teardown and no `process.exit` clears the state.
 *   3. An operator drain keeps its own semantics: the hold must not inherit the
 *      operator's expiry, and the operator's route must still be able to
 *      release the drain.
 */

function makeDrainState() {
  // Mirrors heartbeat.ts: module-scope `taskDrainState`, a per-drain expiry,
  // `startedAt`, and the suppression check every admission path reads.
  let state: { startedAt: Date; expiresAt: Date | null } | null = null;
  const read = () => {
    if (state && state.expiresAt !== null && state.expiresAt.getTime() <= Date.now()) {
      state = null;
    }
    return state;
  };
  return {
    get draining() {
      return read() !== null;
    },
    get startedAt() {
      return read()?.startedAt ?? null;
    },
    get expiresAt() {
      return read()?.expiresAt ?? null;
    },
    start(ttlMs: number | null = null) {
      const startedAt = new Date();
      state = {
        startedAt,
        expiresAt: ttlMs === null ? null : new Date(startedAt.getTime() + ttlMs),
      };
      return { startedAt, expiresAt: state.expiresAt };
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
      engage: () => drain.start(null),
      release: () => drain.stop(),
    });

    hold.hold();
    expect(drain.draining).toBe(true);
    // A TTL would lapse here and let an in-flight sweep claim a run mid-drain.
    // The run drain has no overall deadline, so the hold must not expire.
    expect(drain.expiresAt).toBeNull();

    vi.useFakeTimers();
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
      engage: () => drain.start(null),
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
    // be redundant. More importantly it must not run.
    const drain = makeDrainState();
    const release = vi.fn(() => drain.stop());
    const hold = createShutdownAdmissionHold({
      engage: () => drain.start(null),
      release,
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", true);

    expect(release).not.toHaveBeenCalled();
    expect(drain.draining).toBe(true);
  });

  it("does not re-engage on a second hold call", () => {
    // A second engage would restart the expiry clock on a drain an operator may
    // have lifted in the meantime.
    const drain = makeDrainState();
    const engage = vi.fn(() => drain.start(null));
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
      engage: () => drain.start(null),
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
      engage: () => drain.start(null),
      release: () => drain.stop(),
    });

    hold.hold();
    hold.releaseIfHeld("SIGTERM", false);
    expect(drain.draining).toBe(false);

    hold.hold();
    expect(drain.draining).toBe(true);
  });

  describe("operator drain ownership (RC3)", () => {
    it("engages its own drain even when an operator drain is already active", () => {
      // This drives the real engage used by index.ts, not a stand-in. The
      // defect it pins: the engage used to open with
      // `if (getTaskDrainStatus().draining) return`, so an already-active
      // operator drain made it skip engaging anything of its own. Admission
      // then rode the *operator's* expiry and reopened mid-drain — the same
      // failure the no-TTL hold was introduced to prevent, arriving by the
      // opposite door.
      const drain = makeDrainState();
      drain.start(2 * 60_000); // operator drain, with a TTL

      const engaged = engageShutdownAdmissionHold({
        startTaskDrain: () => void drain.start(null),
        getTaskDrainStatus: () => ({ startedAt: drain.startedAt }),
      });

      // It engaged: the drain is now ours, and our drain has no expiry.
      expect(engaged).not.toBeNull();
      expect(drain.expiresAt).toBeNull();
    });

    it("keeps admission held past the operator's TTL when one was already active", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const drain = makeDrainState();
        drain.start(2 * 60_000); // operator drain, with a TTL

        const hold = createShutdownAdmissionHold({
          engage: () =>
            engageShutdownAdmissionHold({
              startTaskDrain: () => void drain.start(null),
              getTaskDrainStatus: () => ({ startedAt: drain.startedAt }),
            }),
          release: () => drain.stop(),
        });

        hold.hold();

        // Held at 1 minute...
        vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
        expect(drain.draining).toBe(true);
        // ...and at 3 minutes, well past the operator's 2-minute TTL. With the
        // old deferral guard this reopened here, violating the guarantee.
        vi.setSystemTime(new Date("2026-01-01T00:03:00.000Z"));
        expect(drain.draining).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("still lets the operator route release the drain during the teardown", () => {
      // Operator ownership is preserved: the operator's DELETE route stops the
      // drain, and the hold must not paper over that by re-engaging.
      const drain = makeDrainState();
      const hold = createShutdownAdmissionHold({
        engage: () =>
          engageShutdownAdmissionHold({
            startTaskDrain: () => void drain.start(null),
            getTaskDrainStatus: () => ({ startedAt: drain.startedAt }),
          }),
        release: () => drain.stop(),
      });

      hold.hold();
      expect(drain.draining).toBe(true);

      drain.stop(); // the operator's route
      expect(drain.draining).toBe(false);
    });

    it("does not re-engage after the operator released the drain", () => {
      const drain = makeDrainState();
      const startTaskDrain = vi.fn(() => void drain.start(null));
      const hold = createShutdownAdmissionHold({
        engage: () =>
          engageShutdownAdmissionHold({
            startTaskDrain,
            getTaskDrainStatus: () => ({ startedAt: drain.startedAt }),
          }),
        release: () => drain.stop(),
      });

      hold.hold();
      hold.hold();
      expect(startTaskDrain).toHaveBeenCalledTimes(1);
    });

    it("reports no ownership when the teardown cannot engage a drain", () => {
      // `engage` returns null when there is no heartbeat service, so there is
      // nothing to release later.
      const drain = makeDrainState();
      const release = vi.fn(() => drain.stop());
      const hold = createShutdownAdmissionHold({
        engage: () => null,
        release,
      });

      hold.hold();
      hold.releaseIfHeld("SIGTERM", false);

      expect(release).not.toHaveBeenCalled();
    });
  });
});
