import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTaskDrainStatus,
  resolveHeartbeatSchedulingSuppression,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    vi.useRealTimers();
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

  // Regression for the shutdown admission close (KEE-1149). The shutdown path
  // engages this drain with no TTL and must keep it for the whole teardown. A
  // TTL here would lift the drain in the middle of a long run drain and let a
  // still-in-flight scheduler sweep claim a run that is in neither the
  // shutdown snapshot nor the drain's selected set, which is the exact race
  // the drain exists to prevent. The state is process memory, so it cannot
  // outlive the process and needs no expiry.
  it("a_shutdown_drain_never_expires_mid_drain", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain();
    expect(getTaskDrainStatus().expiresAt).toBeNull();

    // Well past the 5 minutes the old fix allowed, and past a plausible
    // worst-case drain, admission must still be held.
    vi.setSystemTime(new Date("2026-01-01T00:30:00.000Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
    expect(getTaskDrainStatus().draining).toBe(true);
  });

});
