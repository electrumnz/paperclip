import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Installer tests for scripts/install-worktree-isolation-hook.mjs (KEE-929).
 *
 * The reviewer's action 5: a test that asserts the guard is *installed* and
 * actually *runs*, so that "the script exists and its unit tests pass" stops
 * being read as "commits are checked".
 *
 * That reading was wrong once already. The guard had 17 passing unit tests and
 * a CI lane, and a package.json script, and nothing ran it on a real commit --
 * the same defect class as the unrun adapter suites measured on KEE-930. So
 * this suite does the only thing that settles it: install the hook into a
 * throwaway repository and then run a real `git commit` through it, asserting
 * on whether the commit landed.
 *
 * Nothing here touches a real seat's worktree. Every repository is a fresh
 * mkdtemp fixture.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, "..", "install-worktree-isolation-hook.mjs");
const guardSource = path.join(here, "..", "check-worktree-isolation.mjs");

const SEAT_A = "4a323d0d-28ff-4974-ba69-9e0c9a3fc44d";
const SEAT_B = "0f4136b3-8cc6-4dc1-a956-106ba76877e4";
const SEAT_B_SHORT = "0f4136b3";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
}

/**
 * A repository laid out the way the fleet is: one common .git at the root, and
 * linked worktrees beside it. The hook is installed into the common dir, so the
 * commit has to run from a linked worktree to prove the coverage is real.
 */
function makeFleet() {
  const root = mkdtempSync(path.join(tmpdir(), "keece-hook-"));
  const main = path.join(root, "main");
  mkdirSync(main, { recursive: true });
  git(["init", "-q", "-b", "main", main], root);
  git(["config", "user.name", "Fixture"], main);
  git(["config", "user.email", "fixture@example.invalid"], main);
  // Give the repo the script the installer needs, and a commit to work from.
  const scripts = path.join(main, "scripts", "__tests__");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(guardSource, path.join(main, "scripts", "check-worktree-isolation.mjs"));
  copyFileSync(installer, path.join(main, "scripts", "install-worktree-isolation-hook.mjs"));
  writeFileSync(path.join(main, "seed.txt"), "seed\n");
  git(["add", "-A"], main);
  git(["commit", "-q", "-m", "seed"], main);
  return { root, main };
}

function installHook(main, args = []) {
  return spawnSync(process.execPath, [path.join(main, "scripts", "install-worktree-isolation-hook.mjs"), ...args], {
    cwd: main,
    encoding: "utf8",
  });
}

test.after(() => {
  // Nothing global to clean; each test removes its own fleet.
});

test("install, check, idempotent re-install, uninstall, check", () => {
  const { root, main } = makeFleet();
  try {
    const before = installHook(main, ["--check"]);
    assert.equal(before.status, 1, "a fresh fleet must report NOT installed");
    assert.match(before.stdout, /NOT installed/);

    assert.equal(installHook(main, ["--install"]).status, 0);

    const afterCheck = installHook(main, ["--check"]);
    assert.equal(afterCheck.status, 0, afterCheck.stdout);
    assert.match(afterCheck.stdout, /installed at/);
    assert.match(afterCheck.stdout, /guard /);

    const again = installHook(main, ["--install"]);
    assert.equal(again.status, 0, again.stdout);
    assert.match(again.stdout, /already installed/);

    assert.equal(installHook(main, ["--uninstall"]).status, 0);
    const afterUninstall = installHook(main, ["--check"]);
    assert.equal(afterUninstall.status, 1, "--check must fail after uninstall");
    assert.match(afterUninstall.stdout, /NOT installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("it refuses to overwrite a hook it did not write, and says so", () => {
  const { root, main } = makeFleet();
  try {
    const commonDir = path.join(main, ".git");
    const hookPath = path.join(commonDir, "hooks", "pre-commit");
    mkdirSync(path.join(commonDir, "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\n# somebody else's hook\nexit 0\n", { mode: 0o755 });
    const before = readFileSync(hookPath, "utf8");

    const result = installHook(main, ["--install"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not installed by this script/);
    assert.equal(readFileSync(hookPath, "utf8"), before, "a foreign hook must not be modified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installed hook stops a real cross-seat commit in a linked worktree", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const otherSeatLane = path.join(worktrees, `paperclip-kee-923-${SEAT_B_SHORT}`);
    git(["worktree", "add", "-q", otherSeatLane, "-b", "keece/kee-923-x"], main);
    writeFileSync(path.join(otherSeatLane, "a.txt"), "a\n");
    git(["add", "a.txt"], otherSeatLane);

    // A real commit, run through the real hook, by the wrong seat. This is the
    // whole point of the card: the answer that matters is whether the commit
    // landed, not whether the script printed something.
    const commit = spawnSync("git", ["commit", "-q", "-m", "cross-seat"], {
      cwd: otherSeatLane,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.notEqual(commit.status, 0, "the commit was allowed into another seat's lane");
    const log = spawnSync("git", ["log", "--oneline"], { cwd: otherSeatLane, encoding: "utf8" }).stdout;
    assert.doesNotMatch(log, /cross-seat/, "the cross-seat commit landed despite the hook");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installed hook allows a real commit in the seat's own lane", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const ownLane = path.join(worktrees, "paperclip-kee-929-4a323d0d");
    git(["worktree", "add", "-q", ownLane, "-b", "keece/kee-929-4a323d0d"], main);
    writeFileSync(path.join(ownLane, "b.txt"), "b\n");
    git(["add", "b.txt"], ownLane);

    const commit = spawnSync("git", ["commit", "-q", "-m", "own-lane"], {
      cwd: ownLane,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.equal(commit.status, 0, `own-lane commit was blocked: ${commit.stdout} ${commit.stderr}`);
    const log = spawnSync("git", ["log", "--oneline"], { cwd: ownLane, encoding: "utf8" }).stdout;
    assert.match(log, /own-lane/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression for the finding that decided this, and a correction to how I first
// wrote it.
//
// The shim originally pointed at the absolute path of the worktree that ran the
// installer. On this host 118 of 119 worktree HEADs do not carry the guard, so
// the guard in whatever checkout happens to run the commit is the wrong source
// to depend on.
//
// My first attempt at this test deleted the guard from one checkout and
// expected the old shim to fail open. It passed against the old installer, and
// that was correct: the old shim's hard-coded path still pointed at a checkout
// that had the guard, so it kept enforcing. The fixture was wrong, not the
// finding.
//
// The hazard that is real is a STALE guard. Install from a lane, change the
// guard on the branch, and every lane whose HEAD lacks the guard keeps running
// the copy that happened to be there at install time -- so a fixed or tightened
// guard is not in force on 118 of 119 worktrees. This asserts the stored copy
// is refreshed instead, by giving the new checkout a guard that refuses and
// checking the shared lane is actually governed by the new one.
test("the guard in force is the checkout's, not a stale copy from install time", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const shared = path.join(worktrees, "paperclip-kee-923");
    git(["worktree", "add", "-q", shared, "-b", "keece/kee-923"], main);
    // This lane's HEAD genuinely lacks the guard, which is the real state of
    // nearly every lane on this host, so the stored copy is what governs it.
    rmSync(path.join(shared, "scripts", "check-worktree-isolation.mjs"), { force: true });

    // A permissive guard is installed, and a permissive guard lets this commit
    // through. Without this control step the test below cannot fail.
    const permissive = `process.stdout.write("check-worktree-isolation: ok, permissive\\n");\nprocess.exit(0);\n`;
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), permissive);
    assert.equal(installHook(main, ["--install"]).status, 0);
    writeFileSync(path.join(shared, "d.txt"), "d\n");
    git(["add", "d.txt"], shared);
    const permissiveCommit = spawnSync("git", ["commit", "-q", "-m", "permissive"], {
      cwd: shared,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.equal(permissiveCommit.status, 0, "control failed: the permissive guard did not allow the commit");

    // Now install the real guard. The shared lane must immediately be governed
    // by it. A shim that only ever ran the copy it had at install time would
    // still be running the permissive one, and this commit would land.
    copyFileSync(guardSource, path.join(main, "scripts", "check-worktree-isolation.mjs"));
    assert.equal(installHook(main, ["--install"]).status, 0);
    writeFileSync(path.join(shared, "e.txt"), "e\n");
    git(["add", "e.txt"], shared);
    const afterTighten = spawnSync("git", ["commit", "-q", "-m", "after-tighten"], {
      cwd: shared,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.notEqual(afterTighten.status, 0, "a stale permissive guard was still in force on this lane");
    const log = spawnSync("git", ["log", "--oneline"], { cwd: shared, encoding: "utf8" }).stdout;
    assert.doesNotMatch(log, /after-tighten/, "commit landed under a stale guard");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree whose HEAD lacks the guard is still covered, after the installer lane is gone", () => {
  const { root, main } = makeFleet();
  try {
    // The installer runs from a throwaway seat lane, which is then removed. The
    // hook and the stored guard live in the common git dir, so neither the
    // lane's checkout nor its copy of the guard may be load-bearing.
    const installerLane = path.join(root, "installer-lane");
    git(["worktree", "add", "-q", installerLane, "-b", "keece/installer-lane"], main);
    const installed = installHook(installerLane, ["--install"]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    git(["worktree", "remove", "--force", installerLane], main);
    rmSync(installerLane, { recursive: true, force: true });
    assert.ok(
      !existsSync(path.join(installerLane, "scripts", "check-worktree-isolation.mjs")),
      "fixture is wrong: the installing checkout should be gone",
    );

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const shared = path.join(worktrees, "paperclip-kee-923");
    git(["worktree", "add", "-q", shared, "-b", "keece/kee-923"], main);
    rmSync(path.join(shared, "scripts", "check-worktree-isolation.mjs"), { force: true });
    writeFileSync(path.join(shared, "c.txt"), "c\n");
    git(["add", "c.txt"], shared);
    assert.ok(
      !existsSync(path.join(shared, "scripts", "check-worktree-isolation.mjs")),
      "fixture is wrong: this lane's HEAD is supposed to lack the guard",
    );

    const commit = spawnSync("git", ["commit", "-m", "shared-tree"], {
      cwd: shared,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.notEqual(commit.status, 0, "commit landed in a shared pre-isolation worktree with no guard in HEAD");
    // The refusal must name the rule, not be a crash. A shim whose hard-coded
    // guard path has vanished also exits non-zero -- node cannot find the
    // module -- so asserting on the status alone cannot tell a working guard
    // from a broken one, and would have passed against the old shim. The seat
    // meets this message mid-task; it has to say what happened and what to do.
    const output = `${commit.stdout}${commit.stderr}`;
    assert.match(output, /pre-isolation shared worktree/, `no rule was named: ${output}`);
    assert.doesNotMatch(output, /Cannot find module/, "the shim crashed instead of deciding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stored guard is refreshed when the installer runs again", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const commonDir = path.join(main, ".git");
    const stored = path.join(commonDir, "hooks", "worktree-isolation-guard.mjs");
    const original = readFileSync(stored, "utf8");

    // A guard update in the checkout must reach the stored copy, or every lane
    // whose HEAD lacks the guard keeps running a stale version forever.
    const updated = `${original}\n// guard update marker\n`;
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), updated);
    const again = installHook(main, ["--install"]);
    assert.equal(again.status, 0, again.stdout);
    assert.match(again.stdout, /guard refreshed/);
    assert.equal(readFileSync(stored, "utf8"), updated, "stored guard went stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall removes the stored guard as well as the hook", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    assert.ok(existsSync(stored), "stored guard missing after install");
    assert.equal(installHook(main, ["--uninstall"]).status, 0);
    assert.ok(!existsSync(stored), "stored guard survived uninstall");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
