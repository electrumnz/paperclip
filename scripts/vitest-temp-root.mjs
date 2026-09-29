// Ownership and cleanup for the per-invocation temp root that the vitest
// runner hands to every test process.
//
// The runner creates one `pv-*` root per invocation and points PAPERCLIP_HOME,
// PAPERCLIP_CONFIG and TMPDIR inside it. It used to never remove that root, so
// every `pnpm test:run` left its fixtures on disk. Because a full temp volume
// makes suites fail for reasons unrelated to the code under test, the leak
// presents as flakiness.
//
// Two halves keep the volume bounded:
//
//   * createTestRoot() marks the new root with the identity of the process that
//     owns it, and removes it on release or on process exit. release() is
//     idempotent and safe to call from an exit hook, so the `process.exit()`
//     failure paths clean up too.
//   * sweepOrphanedTestRoots() reclaims roots left behind by runs that were
//     killed rather than exited (CI cancellation, an OOM kill, a terminated
//     container step). It only removes a root whose owner is provably gone, so
//     it cannot race a concurrent test run.

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A root is only swept once it is older than this. It keeps the sweep from
// touching a root that another invocation created moments ago and has not yet
// written its marker for, which is the only real window between mkdir and mark.
const DEFAULT_GRACE_MS = 60 * 60 * 1000;

const MARKER_FILE = ".paperclip-test-root.json";
const TEST_ROOT_PREFIX = "pv-";

// Keep the root when triage needs the fixtures it left behind. Opt-in only:
// an unconditional keep would reintroduce the leak this module exists to close.
const KEEP_ENV_VARS = ["PAPERCLIP_TEST_KEEP_TEMP", "PAPERCLIP_VITEST_KEEP_TEMP"];

export function tempRootParent() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

export function shouldKeepTestRoot(env = process.env) {
  return KEEP_ENV_VARS.some((name) => {
    const value = env[name];
    if (value === undefined || value === "") return false;
    return !/^(0|false|no|off)$/i.test(String(value).trim());
  });
}

// The boot id makes a recycled pid distinguishable from a live one: if the
// marker was written before the current boot, its pid cannot be the same
// process even when the number is in use again.
function readBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

// Field 22 of /proc/<pid>/stat is the process start time in clock ticks since
// boot. The comm field can contain spaces and parentheses, so read past its
// closing paren rather than splitting the whole line.
function readProcessStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const startTicks = fields[19];
    return startTicks ? Number(startTicks) : null;
  } catch {
    return null;
  }
}

function processIdentity(pid) {
  return { bootId: readBootId(), startTicks: readProcessStartTicks(pid) };
}

// Signal 0 performs the permission and existence check without delivering
// anything. EPERM means the pid exists but belongs to another user, which
// still counts as alive.
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function isMarkerOwnerAlive(marker) {
  const pid = Number(marker?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (marker.bootId && readBootId() && marker.bootId !== readBootId()) {
    return false;
  }

  if (Number.isInteger(marker.startTicks)) {
    const current = readProcessStartTicks(pid);
    if (current === null) return false;
    return current === marker.startTicks;
  }

  // No start-time evidence to compare (non-Linux). Fall back to the weaker
  // existence check; the grace period covers a recycled pid in that window.
  if (hasLiveFallbackLookup()) return pidExists(pid);
  return pidExists(pid);
}

function readMarker(root) {
  const markerPath = path.join(root, MARKER_FILE);
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function ageMs(target, now) {
  try {
    return now - statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

// A root is reclaimable when its recorded owner is provably gone. A root with
// no marker is not assumed dead on sight: an invocation that died between
// mkdir and write has no marker, so age is the only evidence available.
function classifyRoot(root, now, graceMs) {
  const marker = readMarker(root);
  if (marker) {
    if (isMarkerOwnerAlive(marker)) return { root, reclaimable: false, reason: "owner-alive" };
    return { root, reclaimable: true, reason: "owner-gone" };
  }
  if (ageMs(root, now) < graceMs) return { root, reclaimable: false, reason: "no-marker-within-grace" };
  return { root, reclaimable: true, reason: "no-marker-past-grace" };
}

export function findOrphanedTestRoots({
  parent = tempRootParent(),
  graceMs = DEFAULT_GRACE_MS,
  now = Date.now(),
} = {}) {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_ROOT_PREFIX))
    .map((entry) => classifyRoot(path.join(parent, entry.name), now, graceMs));
}

export function sweepOrphanedTestRoots(options = {}) {
  const results = findOrphanedTestRoots(options);
  const swept = [];
  for (const result of results) {
    if (!result.reclaimable) continue;
    rmSync(result.root, { recursive: true, force: true });
    swept.push(result);
  }
  return swept;
}

export function createTestRoot({
  parent = tempRootParent(),
  keep = shouldKeepTestRoot(),
  onRelease = null,
  clock = Date.now,
} = {}) {
  // Production workspace/security checks reject symlink aliases. In particular
  // /tmp is /private/tmp on macOS, so fixture roots must use the canonical path.
  const root = realpathSync(mkdtempSync(path.join(parent, TEST_ROOT_PREFIX)));
  const marker = {
    pid: process.pid,
    ...processIdentity(process.pid),
    createdAt: new Date(clock()).toISOString(),
  };
  writeFileSync(path.join(root, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);

  let released = false;
  const release = (reason = "released") => {
    if (released) return false;
    released = true;
    if (onRelease) onRelease(root, reason);
    if (keep) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  };

  return { root, keep, marker, release, isReleased: () => released };
}

// Installs one exit hook that releases every root this process still owns.
// The exit hook is what makes the `process.exit()` failure paths clean up, and
// it runs on an uncaught exception too. Only synchronous work is legal here,
// which is why removal is rmSync.
//
// `roots` is held by reference, not copied: the runner registers the hook once
// at startup and adds a root per invocation, so a copy taken here would be
// empty by the time the process exits and the cleanup would silently do
// nothing.
export function registerExitCleanup(roots) {
  const onExit = () => {
    for (const handle of roots) handle.release("process-exit");
    roots.clear();
  };
  process.on("exit", onExit);
  return () => {
    process.off("exit", onExit);
  };
}

export const __testing = { readMarker, classifyRoot, ageMs, DEFAULT_GRACE_MS, MARKER_FILE, TEST_ROOT_PREFIX };
