import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(again.stdout, /worktree isolation guard: refreshed/);
    assert.equal(readFileSync(stored, "utf8"), updated, "stored guard went stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile found five defects; this is the sixth, and I found it myself while
// installing the fix. The re-install path refreshed the stored guard but
// returned before rewriting the shim, so after the shim was corrected every
// host that already had the older shim kept running it. The fixed installer
// never reached the live hook -- the same "the code that runs is not the code I
// fixed" shape as the guard itself.
test("re-install replaces an outdated shim, and refuses a hook it cannot recognise", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const currentShim = readFileSync(hookPath, "utf8");

    // An older revision of our shim: the same header, but the checkout-first
    // resolution order that 1023ffe31 shipped. The first three lines of the
    // header are what identify the shim as ours, so those are kept.
    const currentBlock = /  if \[ -f "\/tmp\/[^"]+" \]; then\n[\s\S]*?\n  fi\n/;
    assert.ok(currentBlock.test(currentShim), "fixture is wrong: no stored-guard branch found");
    const staleBlock =
      '  TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""\n' +
      '  if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/scripts/check-worktree-isolation.mjs" ]; then\n' +
      '    GUARD="$TOPLEVEL/scripts/check-worktree-isolation.mjs"\n' +
      '  elif [ -f "/tmp/stored-elsewhere.mjs" ]; then\n' +
      '    GUARD="/tmp/stored-elsewhere.mjs"\n' +
      '  fi\n';
    const staleShim = currentShim.replace(currentBlock, staleBlock);
    assert.notEqual(staleShim, currentShim, "fixture is wrong: could not make an older shim");
    writeFileSync(hookPath, staleShim, { mode: 0o755 });

    const reinstall = installHook(main, ["--install"]);
    assert.equal(reinstall.status, 0, reinstall.stdout + reinstall.stderr);
    assert.match(reinstall.stdout, /outdated shim replaced/);
    // Compared on trimmed content: the installer writes `shim` with its
    // trailing newline and compares normalised, so the raw file is not
    // byte-identical to the in-memory template.
    assert.equal(
      readFileSync(hookPath, "utf8").trimEnd(),
      currentShim.trimEnd(),
      "the outdated shim was not replaced",
    );

    // Idempotence: a second run must report the shim is current, not rewrite it.
    const third = installHook(main, ["--install"]);
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.match(third.stdout, /already current/);
    assert.doesNotMatch(third.stdout, /outdated shim replaced/, "an up-to-date shim is reported outdated");

    // And an unrecognised hook carrying our marker must be refused, not
    // silently rewritten or silently left as a false success.
    writeFileSync(hookPath, `#!/bin/sh\n# installed by scripts/install-worktree-isolation-hook.mjs\n# hand-edited beyond recognition\nexit 0\n`, { mode: 0o755 });
    const refused = installHook(main, ["--install"]);
    assert.equal(refused.status, 1, "an unrecognisable hook was overwritten or accepted");
    assert.match(refused.stderr, /not a revision of this/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The KEE-943 review found this decision completely untested: changing
// NO GUARD FOUND from exit 0 to exit 1 changed no test result, so the one
// branch in the shim that has a stated argument behind it had no coverage at
// all. It is pinned here deliberately, so the next person to "fix" it has to
// come here and say why.
test("with no guard anywhere the shim warns loudly and exits 0, and says what to do", () => {
  const { root, main } = makeFleet();
  try {
    // Install, then remove the guard everywhere the shim can look: the stored
    // copy, the checkout it was installed from, AND the committing worktree's
    // own copy. Removing only the first two is not enough -- git restores the
    // worktree's file from HEAD, so the checkout fallback finds it and the
    // shim correctly keeps working. That is the fallback doing its job, not the
    // branch under test.
    assert.equal(installHook(main, ["--install"]).status, 0);
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    rmSync(stored);
    rmSync(path.join(main, "scripts", "check-worktree-isolation.mjs"));

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const own = path.join(worktrees, "paperclip-kee-929-4a323d0d");
    git(["worktree", "add", "-q", own, "-b", "keece/kee-929-4a323d0d"], main);
    rmSync(path.join(own, "scripts", "check-worktree-isolation.mjs"), { force: true });
    assert.ok(
      !existsSync(path.join(own, "scripts", "check-worktree-isolation.mjs")),
      "fixture is wrong: this lane's checkout still has a guard",
    );
    writeFileSync(path.join(own, "h.txt"), "h\n");
    git(["add", "h.txt"], own);

    const commit = spawnSync("git", ["commit", "-m", "unguarded"], {
      cwd: own,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    const output = `${commit.stdout}${commit.stderr}`;
    assert.equal(commit.status, 0, `NO GUARD FOUND should not block a commit: ${output}`);
    assert.match(output, /NO GUARD FOUND/, "the unguarded state was silent");
    assert.match(output, /install-worktree-isolation-hook/, "the warning does not say how to fix it");
    // And --check must not call this healthy.
    assert.notEqual(installHook(main, ["--check"]).status, 0, "--check reported a guard that is gone");
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

// The four tests below are the automated review's findings on 1023ffe31, each
// reproduced by me before fixing. The premise is the same as above: a fix that
// is not asserted cannot be shown to have fixed anything.

// Greptile P1 "stale guard takes precedence". A worktree whose own guard is an
// older revision used to decide its own commits, so a fixed or tightened guard
// was not in force there -- the original defect of this card, one level up.
test("an older guard in the committing worktree does not outrank the stored guard", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const shared = path.join(worktrees, "paperclip-kee-923");
    git(["worktree", "add", "-q", shared, "-b", "keece/kee-923"], main);

    // A permissive, older guard sitting in the committing worktree.
    const stale = path.join(shared, "scripts", "check-worktree-isolation.mjs");
    writeFileSync(stale, 'process.stdout.write("PERMISSIVE-STALE\\n");\nprocess.exit(0);\n');
    writeFileSync(path.join(shared, "f.txt"), "f\n");
    git(["add", "f.txt"], shared);

    const commit = spawnSync("git", ["commit", "-m", "stale-guard"], {
      cwd: shared,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    const output = `${commit.stdout}${commit.stderr}`;
    assert.doesNotMatch(output, /PERMISSIVE-STALE/, "the stale worktree guard was in force");
    assert.notEqual(commit.status, 0, "a permissive guard allowed the commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P1 "hook installation can falsely succeed", both halves. Reproduced
// by me: with core.hooksPath pointing elsewhere a cross-seat commit landed
// while --check reported the hook installed.
test("--check fails when the hook is not executable, and install refuses a foreign core.hooksPath", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");

    chmodSync(hookPath, 0o644);
    const notExecutable = installHook(main, ["--check"]);
    assert.equal(notExecutable.status, 1, "a non-executable hook was reported installed");
    assert.match(notExecutable.stderr, /not executable/);
    chmodSync(hookPath, 0o755);
    assert.equal(installHook(main, ["--check"]).status, 0);

    const elsewhere = path.join(root, "elsewhere-hooks");
    mkdirSync(elsewhere, { recursive: true });
    git(["config", "core.hooksPath", elsewhere], main);
    const refused = installHook(main, ["--install"]);
    assert.equal(refused.status, 1, "install succeeded although git would never run the hook");
    assert.match(refused.stderr, /core\.hooksPath/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P1 "commits never run the guard" in the core.hooksPath form: the
// installer refusing is not enough, the commit has to be shown landing.
test("a cross-seat commit lands when core.hooksPath hides the hook, and the installer says why", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const elsewhere = path.join(root, "hidden-hooks");
    mkdirSync(elsewhere, { recursive: true });
    git(["config", "core.hooksPath", elsewhere], main);

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const foreign = path.join(worktrees, `paperclip-kee-923-${SEAT_B_SHORT}`);
    git(["worktree", "add", "-q", foreign, "-b", "keece/kee-923-x"], main);
    writeFileSync(path.join(foreign, "g.txt"), "g\n");
    git(["add", "g.txt"], foreign);

    const commit = spawnSync("git", ["commit", "-m", "unhooked"], {
      cwd: foreign,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.equal(commit.status, 0, "control failed: the commit should land when the hook is hidden");
    const log = spawnSync("git", ["log", "--oneline"], { cwd: foreign, encoding: "utf8" }).stdout;
    assert.match(log, /unhooked/);

    // And the installer must not claim success while that is the situation.
    const check = installHook(main, ["--check"]);
    assert.notEqual(check.status, 0, "--check claimed installed while core.hooksPath hides the hook");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P2 "uninstall deletes other checks". Somebody else's check appended
// to the same hook must survive, for every worktree sharing it.
test("uninstall keeps a check that somebody else added to the same hook", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, `${readFileSync(hookPath, "utf8")}# somebody else's important check\nexit 0\n`);

    assert.equal(installHook(main, ["--uninstall"]).status, 0);
    assert.ok(existsSync(hookPath), "uninstall deleted a hook that also contained someone else's check");
    const after = readFileSync(hookPath, "utf8");
    assert.match(after, /somebody else's important check/, "someone else's check was deleted");
    assert.doesNotMatch(after, /installed by scripts\/install-worktree-isolation-hook/, "our block survived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P2 "interrupted install leaves unguarded hook". The stored guard is
// now written first, through a temp file and a rename, so there is never a
// live hook with no guard and never a half-written guard for node to choke on.
//
// The ordering half of this is asserted on the source rather than by racing an
// interruption, which is not something a test can do reliably. The previous
// version wrote the hook first and the guard second, so an install interrupted
// between the two left a live hook with no guard: it warns and allows every
// commit. Reading the write order is honest about what it checks.
test("the stored guard is written before the hook, and no staging file is left behind", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hooksDir = path.join(main, ".git", "hooks");
    const leftovers = readdirSync(hooksDir).filter((f) => f.includes("worktree-isolation-guard.mjs.tmp"));
    assert.deepEqual(leftovers, [], "a staging file was left behind");
    assert.ok(existsSync(path.join(hooksDir, "worktree-isolation-guard.mjs")), "no stored guard");
    assert.ok(existsSync(path.join(hooksDir, "pre-commit")), "no hook");

    const source = readFileSync(installer, "utf8");
    const storeAt = source.indexOf("renameSync(staging, storedGuardPath)");
    const hookAt = source.indexOf("writeFileSync(hookPath, shim");
    assert.ok(storeAt > -1 && hookAt > -1, "fixture is wrong: both writes should be present");
    assert.ok(
      storeAt < hookAt,
      "the hook is written before the stored guard, so an interrupted install leaves a live hook with no guard",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
