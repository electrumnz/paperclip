type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

type ShutdownLogger = {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  /**
   * Optional so the existing bounded-drain callers, which only ever needed
   * `info`/`error`, keep their current logger shape.
   */
  warn?(obj: object, msg: string): void;
};

/**
 * How long a shutdown waits for the heartbeat scheduler to quiesce before it
 * forces the quiesce. The wait is a safety step, not a correctness step: the
 * run drain that follows is bounded and idempotent, and a sweep that never
 * settles must not spend the whole supervisor stop timeout waiting for it.
 * Sized well under the caller's stop timeout so the remaining teardown steps
 * (finalizer drain, HTTP listener, database) still fit inside it.
 */
export const HEARTBEAT_SCHEDULER_QUIESCE_TIMEOUT_MS = 5_000;

export type HeartbeatSchedulerQuiesce = "idle" | "timed_out";

export async function drainRunExecutionFinalizersForShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  drain: (() => Promise<void>) | null;
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"drained" | "timed_out" | "unavailable"> {
  if (!input.drain) return "unavailable";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    const result = await Promise.race([
      input.drain().then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === "timed_out") {
      input.log.info(
        { signal: input.signal, timeoutMs },
        "bounded heartbeat execution finalizer drain timed out",
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ShutdownHttpListener = {
  listening: boolean;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/**
 * Stops the HTTP listener from accepting new requests and waits, for at most
 * `timeoutMs`, for the open connections to finish. Idle keep-alive sockets
 * close at once; whatever is still open when the grace period ends is closed
 * forcibly, so the teardown never hangs on a long-lived client. Call this
 * before the database pool ends, so no request can reach a route after
 * `sql.end()` and fail with a connection-ended error.
 */
export async function closeHttpListenerForShutdown(input: {
  server: ShutdownHttpListener;
  signal: "SIGINT" | "SIGTERM";
  timeoutMs?: number;
  log: ShutdownLogger;
}): Promise<"closed" | "timed_out" | "not_listening"> {
  if (!input.server.listening) return "not_listening";
  const timeoutMs = input.timeoutMs ?? 5_000;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      new Promise<"closed">((resolve) => {
        input.server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            input.log.error({ err, signal: input.signal }, "HTTP listener close failed");
          }
          resolve("closed");
        });
        input.server.closeIdleConnections?.();
      }),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          input.log.info(
            { signal: input.signal, timeoutMs },
            "HTTP listener drain timed out; closing the remaining connections",
          );
          input.server.closeAllConnections?.();
          resolve("timed_out");
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the final, ordered teardown of the server. It awaits the application
 * service cleanup first, so a live setup-token login session stops and releases
 * its sandbox lease before the database and the provider stop. The caller runs
 * `process.exit(0)` only after this helper resolves, so an orderly shutdown
 * never leaves a sandbox lease or confidential login state alive past the
 * process exit.
 *
 * A step that rejects does not stop the teardown. The helper logs the error and
 * continues to the next step. A failed setup-token lease release stays a
 * durable record for the startup reaper; the helper surfaces it in the log
 * instead of blocking the exit path.
 */
export async function finalizeServerShutdown(input: {
  signal: "SIGINT" | "SIGTERM";
  shutdownAppServices: (() => Promise<void>) | undefined;
  /**
   * Stops the HTTP listener and drains its connections (see
   * `closeHttpListenerForShutdown`). Runs first, while every application
   * service is still available to the requests being drained, so no request
   * runs against a half-dismantled service or an ended pool.
   */
  closeHttpListener?: (() => Promise<unknown>) | null;
  /**
   * Waits for every run-failure Sentry report still in flight. Runs after the
   * application services and before the database pool ends, so a report that
   * started just before shutdown still gets its database read and reaches
   * Sentry before `shutdownSentry` flushes and closes the client.
   */
  drainPendingRunFailureReports?: (() => Promise<void>) | null;
  /**
   * Ends the server's PostgreSQL client pools. Runs after the application
   * services (which still need the database) and before the embedded
   * provider stops, so the backends close in order and none outlive the
   * process.
   */
  closeDatabase?: (() => Promise<void>) | null;
  stopEmbeddedPostgres: (() => Promise<void>) | null;
  shutdownInstrumentation: () => Promise<void>;
  shutdownSentry: () => Promise<void>;
  log: ShutdownLogger;
}): Promise<void> {
  const { signal } = input;

  // Stop accepting requests and drain the open ones before any service goes
  // away, so a request that is still in flight sees a fully working server.
  if (input.closeHttpListener) {
    try {
      await input.closeHttpListener();
    } catch (err) {
      input.log.error({ err, signal }, "HTTP listener shutdown failed");
    }
  }

  // Await the application service cleanup, so a live setup-token login session
  // releases its sandbox lease before the database and the provider stop. A
  // rejected cleanup stays durable for the reaper; it does not block the exit.
  try {
    await input.shutdownAppServices?.();
  } catch (err) {
    input.log.error({ err, signal }, "Application service shutdown failed");
  }

  // Wait for every in-flight run-failure Sentry report before the database
  // pool ends. `reportRunFailure` is fire-and-forget: without this wait, a
  // report that started just before shutdown can lose its database read to
  // the pool end below, or lose its Sentry call to the flush further down.
  if (input.drainPendingRunFailureReports) {
    try {
      await input.drainPendingRunFailureReports();
    } catch (err) {
      input.log.error({ err, signal }, "run-failure report drain failed");
    }
  }

  // End the client pools once nothing needs them any more. Without this the
  // process exit leaves the pooled backends to PostgreSQL's own TCP keepalive
  // reaping, and a restart loop can pile up enough of them to hit
  // `max_connections` before the next boot gets a connection.
  if (input.closeDatabase) {
    try {
      await input.closeDatabase();
    } catch (err) {
      input.log.error({ err, signal }, "Database client shutdown failed");
    }
  }

  if (input.stopEmbeddedPostgres) {
    input.log.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await input.stopEmbeddedPostgres();
    } catch (err) {
      input.log.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    }
  }

  // Flush buffered OTel spans before the process goes away; without this await
  // the exporter's final batch is dropped on exit.
  await input.shutdownInstrumentation();

  // Flush buffered Sentry events before the process goes away; without this
  // await the last events are dropped on exit.
  await input.shutdownSentry();
}

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
  /**
   * Stops the scheduler from admitting new work and keeps it stopped, even
   * after a forced quiesce. Called on every path, before the run drain begins,
   * so a sweep that is still outstanding when the quiesce times out cannot
   * claim a new run mid-drain and mutate state the drain has already read.
   */
  closeSchedulerAdmission?: () => void;
  quiesceTimeoutMs?: number;
  log?: ShutdownLogger;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
  quiesce: HeartbeatSchedulerQuiesce;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  //
  // The wait is bounded. `waitForHeartbeatSchedulerIdle` drains the tracked
  // sweep set, and a single sweep that never settles (a hung socket, a run
  // claim that never returns) would otherwise hold this await open forever:
  // the process would never reach its own exit, and a supervisor that escalates
  // on a stop timeout would SIGKILL the whole process group, losing every child
  // worker that was not drained. A timed-out quiesce is therefore reported and
  // the shutdown continues — the drain below is bounded and still runs.
  const quiesceTimeoutMs = input.quiesceTimeoutMs ?? HEARTBEAT_SCHEDULER_QUIESCE_TIMEOUT_MS;
  let quiesceTimer: NodeJS.Timeout | null = null;
  let quiesce: HeartbeatSchedulerQuiesce;
  try {
    quiesce = await Promise.race([
      input.waitForHeartbeatSchedulerIdle().then(() => "idle" as const),
      new Promise<"timed_out">((resolve) => {
        quiesceTimer = setTimeout(() => resolve("timed_out"), quiesceTimeoutMs);
        // Never hold the event loop open for the quiesce deadline on its own.
        quiesceTimer.unref?.();
      }),
    ]);
  } catch (err) {
    // A quiesce failure is not a shutdown failure: fall through to the drain.
    input.log?.error({ err, signal: input.signal }, "heartbeat scheduler idle wait failed");
    quiesce = "timed_out";
  } finally {
    if (quiesceTimer) clearTimeout(quiesceTimer);
  }
  if (quiesce === "timed_out") {
    input.log?.warn?.(
      { signal: input.signal, timeoutMs: quiesceTimeoutMs },
      "heartbeat scheduler quiesce timed out; continuing shutdown with sweeps still in flight",
    );
  }

  // Admission stays closed from here on. A sweep admitted before the signal is
  // allowed to finish above, but nothing may be admitted once the drain starts:
  // a late claim would create a run that is in neither the shutdown snapshot
  // nor the drain's selected set, and would race the drain that is already
  // reading and updating those rows.
  input.closeSchedulerAdmission?.();

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: quiesce === "idle",
    quiesce,
  };
}

/**
 * Engage the teardown's own admission hold and report which drain it took.
 *
 * Kept separate from `createShutdownAdmissionHold` so the decision itself is
 * testable: `index.ts` wires it to the real heartbeat service, and a test can
 * drive it against a stand-in state machine. The rule is deliberately
 * unconditional.
 *
 * The defect this replaces: the engage used to open with
 * `if (getTaskDrainStatus().draining) return`, skipping its own drain whenever
 * one was already active. An already-active *operator* drain therefore made the
 * teardown inherit the operator's expiry, so admission reopened mid-drain once
 * that TTL lapsed — the same failure the no-TTL hold was introduced to prevent,
 * arriving by the opposite door. `draining === true` cannot distinguish the
 * operator's drain from our own, so it is not used as a guard at all.
 *
 * Engaging over an operator drain does not shorten it: the operator's route
 * still stops it, and the operator's TTL simply stops being what governs
 * admission during the teardown. That is the teardown's own protection, not a
 * change to the operator's decision.
 */
export function engageShutdownAdmissionHold(input: {
  startTaskDrain: () => void;
  getTaskDrainStatus: () => { startedAt: Date | null } | null;
}): { startedAt: Date } | null {
  input.startTaskDrain();
  return { startedAt: input.getTaskDrainStatus()?.startedAt ?? new Date() };
}

/**
 * Tracks whether a shutdown currently owns the admission hold, so an operator
 * drain-release can be refused instead of allowed to reopen admission while a
 * teardown is still draining (KEE-1149, RC4).
 *
 * The hold registers its own identity here when it engages and clears the entry
 * when it releases. Deriving the route's view from the hold's own lifecycle —
 * rather than a flag maintained somewhere else — is what keeps the two
 * consistent, because a separate flag can drift from the hold that actually
 * governs the drain.
 *
 * Keyed by lifecycle id so two concurrent teardowns (a signal and a
 * programmatic `StartedServer.shutdown`) cannot clear each other's entry.
 */
const shutdownAdmissionHolds = new Set<string>();

/** True while any registered shutdown-owned hold is engaged. */
export function isShutdownAdmissionHoldActive(): boolean {
  return shutdownAdmissionHolds.size > 0;
}

/**
 * Own the lifetime of the shutdown admission hold so the release rules are
 * testable without booting a server.
 *
 * Three invariants, and they pull against each other:
 *
 * 1. The hold must span the whole run drain. `drainRunningRunsForShutdown` has
 *    no overall deadline, so a hold with an expiry would lapse mid-drain and a
 *    sweep still in flight could then claim a run that is in neither the
 *    shutdown snapshot nor the drain's selected set.
 * 2. The hold must not survive the teardown that created it. The state is
 *    process memory, so a signal-driven shutdown always clears it by exiting,
 *    but `StartedServer.shutdown` is `shutdown(signal, false)` and its caller
 *    can hold a process that outlives the teardown. Without a release that
 *    process would suppress run admission forever.
 * 3. A drain the operator owns keeps its own semantics, and the operator's
 *    route must stay able to release it.
 *
 * A TTL on the hold satisfies none of 1 cleanly: too short breaks it, long
 * enough is unbounded in practice. So the hold is never given an expiry.
 *
 * Ownership is tracked by *identity* (`startedAt`), not by the `draining`
 * boolean: an active operator drain and our own both read `draining === true`,
 * so that boolean cannot distinguish them. `getTaskDrainStatus()` already
 * reports `startedAt`, so the hold records which drain it engaged and treats
 * any other active drain as the operator's. See
 * `engageShutdownAdmissionHold` for why the engage is unconditional.
 */
export function createShutdownAdmissionHold(input: {
  /** Engage the hold. Returns the identity of the drain now active. */
  engage: () => { startedAt: Date } | null;
  /** Release a hold this lifecycle engaged. */
  release: () => void;
  /** Identity for the hold marker, so concurrent teardowns stay distinct. */
  lifecycleId?: string;
  log?: ShutdownLogger;
}): { hold: () => void; releaseIfHeld: (signal: "SIGINT" | "SIGTERM", exitsProcess: boolean) => void } {
  // The identity of the drain this lifecycle engaged, or null if it has
  // engaged none. Compared by timestamp because the real state machine hands
  // back a fresh `Date` per engage.
  let engagedSince: number | null = null;
  const lifecycleId = input.lifecycleId ?? `shutdown-${Math.random().toString(36).slice(2)}`;

  return {
    hold: () => {
      if (engagedSince !== null) return;
      const engaged = input.engage();
      engagedSince = engaged ? engaged.startedAt.getTime() : null;
      if (engagedSince !== null) {
        // Mark the hold as shutdown-owned so the operator route can refuse to
        // release it while this teardown is still draining.
        shutdownAdmissionHolds.add(lifecycleId);
        input.log?.info?.(
          {},
          "task drain engaged for the remainder of shutdown",
        );
      }
    },
    releaseIfHeld: (signal, exitsProcess) => {
      // A signal-driven shutdown reaches `process.exit(0)`, which clears the
      // process-local state anyway. Releasing here would be harmless but would
      // also drop a drain the operator may still own.
      if (exitsProcess || engagedSince === null) return;
      engagedSince = null;
      // Clear the marker as soon as this teardown stops owning the hold, so a
      // stale entry cannot refuse a later operator release in a process that
      // outlived the teardown. The exiting path needs no marker cleanup: that
      // process is on its way out.
      shutdownAdmissionHolds.delete(lifecycleId);
      input.release();
      input.log?.info?.(
        { signal },
        "teardown finished without exiting; releasing the shutdown task drain",
      );
    },
  };
}
