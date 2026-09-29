// Acceptance for the pv-* test temp root leak (KEE-206).
//
// The runner created one pv-* root per invocation and never removed it, so a
// full temp volume made suites fail for reasons unrelated to the code under
// test. These tests pin the three behaviours that close it:
//
//   * a root is released on the normal path and on process exit, including the
//     process.exit() failure path that previously skipped cleanup entirely;
//   * the keep flag retains a root for failure triage;
//   * the startup sweep reclaims a killed run's root but never a live run's.
//
// Every test builds its roots in a private temp parent, so none of it can
// remove a real `pnpm test:run` fixture root.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  __testing,
  createTestRoot,
  findOrphanedTestRoots,
  isMarkerOwnerAlive,
  registerExitCleanup,
  shouldKeepTestRoot,
  sweepOrphanedTestRoots,
  tempRootParent,
} from "./vitest-temp-root.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const created = [];

function tempParent(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), `kee206-${t.name.replace(/[^a-z0-9]+/gi, "-")}-`));
  created.push(parent);
  return parent;
}

after(() => {
  for (const parent of created) rmSync(parent, { recursive: true, force: true });
});

function rootsIn(parent, prefix = "pv-") {
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => path.join(parent, e.name));
}

// Runs a child that creates a root, then terminates in the given way. A child
// is the only honest way to test the exit hook, because process.on("exit") in
// this process would not distinguish the release path from the exit path.
function child(script, env = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return result;
}

describe("createTestRoot", () => {
  it("marks the root with the owning process identity", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    const marker = JSON.parse(readFileSync(path.join(handle.root, __testing.MARKER_FILE), "utf8"));
    assert.equal(marker.pid, process.pid);
    assert.ok(marker.createdAt);
    handle.release("test");
  });

  it("removes the root when released", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    const root = handle.root;
    assert.ok(existsSync(root));
    assert.equal(handle.release("test"), true);
    assert.equal(existsSync(root), false);
  });

  it("is idempotent, so a double release cannot throw or delete twice", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    assert.equal(handle.release("first"), true);
    assert.equal(handle.release("second"), false);
    assert.equal(handle.isReleased(), true);
  });

  it("keeps the root when keep is set, and still reports the release", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent, keep: true });
    const root = handle.root;
    assert.equal(handle.release("test"), false, "keep must not remove the root");
    assert.ok(existsSync(root), "a kept root must survive for triage");
    rmSync(root, { recursive: true, force: true });
  });

  it("tolerates a root that another party already removed", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    rmSync(handle.root, { recursive: true, force: true });
    assert.equal(handle.release("test"), true);
  });

  // Real fixtures make parts of the tree read-only: the runtime-context asset
  // bundles are installed 0555/0444. rmSync cannot unlink an entry under a
  // directory that denies write, and `force` only covers ENOENT, so before this
  // case was fixed the release threw EACCES and left most of the root on disk.
  // That is the same leak the module exists to close, reached by a second route.
  it("removes a root whose fixtures created read-only directories", (t) => {
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    const bundleDir = path.join(handle.root, "h", "instances", "vt-1", "runtime-context-assets", "bundles", "abc123");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(path.join(bundleDir, "SKILL.md"), "# fixture\n");
    writeFileSync(path.join(bundleDir, "TOOLS.json"), "{}\n");
    chmodSync(bundleDir, 0o555);
    chmodSync(path.join(bundleDir, "SKILL.md"), 0o444);
    chmodSync(path.join(bundleDir, "TOOLS.json"), 0o444);

    assert.equal(handle.release("test"), true);
    assert.equal(existsSync(handle.root), false, "a read-only fixture tree must not survive release");
  });

  it("does not throw out of release when a fixture cannot be removed", (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip("root bypasses directory write permissions");
      return;
    }
    const parent = tempParent(t);
    const handle = createTestRoot({ parent });
    // Deny write on the parent, so the root itself cannot be unlinked no matter
    // what the cleanup does inside it. This is the shape of a leftover under a
    // parent this process does not own.
    chmodSync(parent, 0o500);
    // Cleanup must degrade to "not removed", never to an exception that would
    // replace the real test result coming out of the exit hook.
    assert.equal(handle.release("test"), false);
    assert.ok(existsSync(handle.root), "an unremovable root is left in place, not half deleted");
    chmodSync(parent, 0o700);
    rmSync(handle.root, { recursive: true, force: true });
  });
});

describe("shouldKeepTestRoot", () => {
  it("defaults to off so the leak cannot come back by default", () => {
    assert.equal(shouldKeepTestRoot({}), false);
  });

  it("accepts either keep variable as a truthy value", () => {
    assert.equal(shouldKeepTestRoot({ PAPERCLIP_TEST_KEEP_TEMP: "1" }), true);
    assert.equal(shouldKeepTestRoot({ PAPERCLIP_VITEST_KEEP_TEMP: "1" }), true);
    assert.equal(shouldKeepTestRoot({ PAPERCLIP_TEST_KEEP_TEMP: "yes" }), true);
  });

  it("treats an explicit off value and an empty value as off", () => {
    for (const value of ["0", "false", "no", "off", " 0 ", ""]) {
      assert.equal(shouldKeepTestRoot({ PAPERCLIP_TEST_KEEP_TEMP: value }), false, `value=${JSON.stringify(value)}`);
    }
  });
});

describe("registerExitCleanup", () => {
  it("removes an owned root when the process exits normally", (t) => {
    const parent = tempParent(t);
    const result = child(`
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      const owned = new Set([createTestRoot({ parent: ${JSON.stringify(parent)} })]);
      registerExitCleanup(owned);
      process.stdout.write(owned.values().next().value.root);
    `);
    assert.equal(result.status, 0, result.stderr);
    const root = result.stdout.trim();
    assert.ok(root, "child should report the root it created");
    assert.equal(existsSync(root), false, "exit hook must remove the owned root");
    assert.deepEqual(rootsIn(parent), [], "no root may be left behind");
  });

  it("removes an owned root on the process.exit() failure path", (t) => {
    const parent = tempParent(t);
    // This is the path the old runner got wrong: process.exit() from a failure
    // branch skipped every chance to clean up.
    const result = child(`
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      const owned = new Set([createTestRoot({ parent: ${JSON.stringify(parent)} })]);
      registerExitCleanup(owned);
      process.stdout.write(owned.values().next().value.root);
      process.exit(1);
    `);
    assert.equal(result.status, 1, "child should exit non-zero");
    const root = result.stdout.trim();
    assert.ok(root, "child should report the root it created");
    assert.equal(existsSync(root), false, "process.exit() must still clean up");
  });

  it("removes an owned root on an uncaught exception", (t) => {
    const parent = tempParent(t);
    const result = child(`
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      registerExitCleanup(new Set([createTestRoot({ parent: ${JSON.stringify(parent)} })]));
      setTimeout(() => { throw new Error("boom"); }, 10);
    `);
    assert.notEqual(result.status, 0, "child should die on the throw");
    assert.deepEqual(rootsIn(parent), [], "an uncaught exception must still clean up");
  });

  it("releases a root added after the hook was registered", (t) => {
    const parent = tempParent(t);
    // Regression: the runner registers the hook once at startup and adds a root
    // per invocation. Copying the Set inside registerExitCleanup made the hook
    // release nothing while every test that added roots first still passed.
    const result = child(`
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      const owned = new Set();
      registerExitCleanup(owned);
      owned.add(createTestRoot({ parent: ${JSON.stringify(parent)} }));
      process.exit(1);
    `);
    assert.equal(result.status, 1);
    assert.deepEqual(rootsIn(parent), [], "a root added after registration must still be released");
  });

  it("removes every root when one process created several", (t) => {
    const parent = tempParent(t);
    const result = child(`
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      const owned = new Set([
        createTestRoot({ parent: ${JSON.stringify(parent)} }),
        createTestRoot({ parent: ${JSON.stringify(parent)} }),
      ]);
      registerExitCleanup(owned);
      process.exit(2);
    `);
    assert.equal(result.status, 2);
    assert.deepEqual(rootsIn(parent), [], "both roots must be released");
  });
});

describe("sweepOrphanedTestRoots", () => {
  it("reclaims a root whose owner is gone", (t) => {
    const parent = tempParent(t);
    const result = child(`
      import { createTestRoot } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      process.stdout.write(createTestRoot({ parent: ${JSON.stringify(parent)} }).root);
    `);
    assert.equal(result.status, 0, result.stderr);
    const root = result.stdout.trim();
    // The child never registered cleanup, exactly like a SIGKILLed run.
    assert.ok(existsSync(root), "precondition: the orphaned root exists");

    const swept = sweepOrphanedTestRoots({ parent });
    assert.equal(swept.length, 1);
    assert.equal(swept[0].root, root);
    assert.equal(swept[0].reason, "owner-gone");
    assert.equal(existsSync(root), false);
  });

  it("leaves a root whose owner is still running", (t) => {
    const parent = tempParent(t);
    // The child holds the root open, then gets SIGKILLed only after the sweep
    // has run, so the root has a live owner at the moment that matters.
    const script = `
      import { createTestRoot, registerExitCleanup } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      const handle = createTestRoot({ parent: ${JSON.stringify(parent)} });
      registerExitCleanup(new Set([handle]));
      console.log(handle.root);
      setInterval(() => {}, 1000);
    `;
    const owner = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 4_000,
      killSignal: "SIGKILL",
    });
    // The timeout kill is expected; stdout still carries the root path.
    const root = owner.stdout.trim().split("\n").pop();
    assert.ok(root, "precondition: a live-owner root was created");
    // The child is dead by now, so re-create liveness by marker: rewrite the
    // marker to this process, which is unambiguously alive.
    const markerPath = path.join(root, __testing.MARKER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const bootId = process.platform === "linux"
      ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : marker.bootId;
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);
    writeFileSync(markerPath, JSON.stringify({ ...marker, pid: process.pid, bootId, startTicks }));
    try {
      const classified = findOrphanedTestRoots({ parent });
      assert.equal(classified.length, 1);
      assert.equal(classified[0].reclaimable, false, "a live owner's root must be kept");
      assert.equal(classified[0].reason, "owner-alive");

      assert.deepEqual(sweepOrphanedTestRoots({ parent }), [], "the sweep must not remove a live run's root");
      assert.ok(existsSync(root), "the live root must survive the sweep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims a marker-less root only once it is past the grace period", (t) => {
    const parent = tempParent(t);
    const root = path.join(parent, "pv-nomarker");
    mkdirSync(root, { recursive: true });

    const fresh = findOrphanedTestRoots({ parent, graceMs: 60_000, now: Date.now() });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].reclaimable, false, "a fresh marker-less root may still be mid-create");
    assert.equal(fresh[0].reason, "no-marker-within-grace");

    // Age it past the grace period the way a stale run would be aged.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(root, old, old);
    const stale = findOrphanedTestRoots({ parent, graceMs: 60_000, now: Date.now() });
    assert.equal(stale[0].reclaimable, true);
    assert.equal(stale[0].reason, "no-marker-past-grace");

    const swept = sweepOrphanedTestRoots({ parent, graceMs: 60_000 });
    assert.equal(swept.length, 1);
    assert.equal(existsSync(root), false);
  });

  it("ignores directories that are not test roots", (t) => {
    const parent = tempParent(t);
    mkdirSync(path.join(parent, "other-run"), { recursive: true });
    mkdirSync(path.join(parent, "pvfile-root"), { recursive: true });
    const result = child(`
      import { createTestRoot } from ${JSON.stringify(path.join(scriptsDir, "vitest-temp-root.mjs"))};
      createTestRoot({ parent: ${JSON.stringify(parent)} });
    `);
    assert.equal(result.status, 0, result.stderr);
    // Only the real pv-* root is a candidate, so only it is classified.
    const classified = findOrphanedTestRoots({ parent });
    assert.equal(classified.length, 1);
    assert.ok(classified[0].root.endsWith(path.join(parent, "other-run")) === false);
    assert.ok(existsSync(path.join(parent, "other-run")), "unrelated dirs must be left alone");
  });

  it("returns nothing when the parent does not exist", () => {
    assert.deepEqual(sweepOrphanedTestRoots({ parent: path.join(os.tmpdir(), "kee206-absent-dir") }), []);
  });
});

describe("isMarkerOwnerAlive", () => {
  it("recognises the current process as alive", () => {
    const handle = createTestRoot({ parent: tempParent({ name: "alive" }) });
    const marker = JSON.parse(readFileSync(path.join(handle.root, __testing.MARKER_FILE), "utf8"));
    assert.equal(isMarkerOwnerAlive(marker), true);
    handle.release("test");
  });

  it("treats a marker from another boot as dead even when the pid is in use", () => {
    assert.equal(isMarkerOwnerAlive({ pid: process.pid, bootId: "00000000-dead-beef-0000-000000000000" }), false);
  });

  it("treats a start-time mismatch as a recycled pid", () => {
    assert.equal(isMarkerOwnerAlive({ pid: process.pid, startTicks: 1 }), false);
  });

  it("treats a malformed pid as dead rather than throwing", () => {
    for (const marker of [{}, { pid: 0 }, { pid: -1 }, { pid: "x" }, { pid: null }]) {
      assert.equal(isMarkerOwnerAlive(marker), false, JSON.stringify(marker));
    }
  });
});

describe("tempRootParent", () => {
  it("uses the platform temp directory", () => {
    assert.ok(existsSync(tempRootParent()));
  });
});
