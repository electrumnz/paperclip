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

/**
 * The same invocation as a full argv, for the one test that has to run the
 * installer under `ulimit`, which needs to go through a shell.
 */
function installArgs(main, args = []) {
  return [process.execPath, path.join(main, "scripts", "install-worktree-isolation-hook.mjs"), ...args];
}

/**
 * The branch of the shim that prefers the stored guard, as a matcher.
 *
 * The shim is written with the absolute stored-guard path already interpolated
 * into it, so the block is found by shape -- `if [ -f "<path>" ]` -- rather
 * than by a hard-coded /tmp. The literal form only ever passed because mkdtemp
 * happened to hand back a POSIX-looking path, which is the portability defect
 * the KEE-954 review flagged, not a property of the installer.
 */
function storedGuardBranch() {
  return /  if \[ -f "[^"]+" \]; then\n[\s\S]*?\n  fi\n/;
}

test.after(() => {
  // Nothing global to clean; each test removes its own fleet.
});

/**
 * A guard that is genuinely NEWER, not merely different.
 *
 * The version lives on one comment line inside the guard's header block, so a
 * fixture that wants a newer guard has to say so there. Appending a marker
 * comment and leaving the version alone does NOT produce a newer guard: it
 * produces two guards at the same version with different bytes, which is the
 * hand-edit state, and the installer correctly refuses to choose between those.
 *
 * Several tests here used to express "newer" the other way, and passed only
 * because the succeeding path took the checkout's copy unconditionally. Now
 * that the rule is the same on both paths, they have to state what they mean.
 * This helper is that statement.
 */
function stampGuardVersion(guardText, version) {
  return guardText.replace(
    /^([ \t]*(?:\*[ \t]*)?#?[ \t]*worktree-isolation-guard-version:[ \t]*)\d+/m,
    `$1${version}`,
  );
}

/**
 * The version a guard claims, read the way the installer reads it.
 *
 * Deliberately a re-implementation rather than a copy of the installer's own
 * expression: a test that imported the regex under test would agree with a
 * broken regex, and these tests exist to catch that.
 */
function versionIn(guardText) {
  const match = /^[ \t]*(?:\*[ \t]*)?#?[ \t]*worktree-isolation-guard-version:[ \t]*(\d+)[ \t]*$/m.exec(guardText);
  return match ? Number.parseInt(match[1], 10) : 0;
}

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
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
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
    //
    // --force is required here and is itself part of what this test records. The
    // permissive stub carries no version stamp, so under the KEE-966 ruling an
    // ordinary --install will NOT let it displace the stamped guard already in
    // force. It used to: this step used to be a plain --install, which is
    // precisely the hole the ruling closes -- an unmeasured copy taking over a
    // measured one on an ordinary run. To construct a fleet that genuinely runs
    // a permissive guard, the operator has to say --force, and now the test has
    // to as well.
    const permissive = `process.stdout.write("check-worktree-isolation: ok, permissive\\n");\nprocess.exit(0);\n`;
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), permissive);
    const forcedPermissive = installHook(main, ["--install", "--force"]);
    assert.equal(forcedPermissive.status, 0, forcedPermissive.stdout + forcedPermissive.stderr);
    assert.equal(
      readFileSync(stored, "utf8"),
      permissive,
      "control is wrong: --force did not install the permissive guard, so the commit below proves nothing",
    );
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
    //
    // This is the DIRECTION the ruling protects, and it is worth being precise
    // about, because the ruling's name is "unstamped". Here the STORED copy is
    // the unstamped one and the CHECKOUT copy is stamped, so this is a normal
    // install and the stamped guard is written: a measured guard positively
    // outranks an unmeasured one. The withheld case is the mirror image, where
    // an unstamped CHECKOUT copy is trying to displace a stamped stored guard.
    // Both are covered, in this file, in both directions.
    copyFileSync(guardSource, path.join(main, "scripts", "check-worktree-isolation.mjs"));
    const tighten = installHook(main, ["--install"]);
    assert.equal(tighten.status, 0, tighten.stdout);
    assert.equal(
      readFileSync(stored, "utf8"),
      readFileSync(guardSource, "utf8"),
      "a stamped guard could not displace an unmeasured permissive one",
    );
    assert.match(
      tighten.stdout,
      /guard: refreshed/,
      "the tightening install did not say it refreshed the guard",
    );
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
    //
    // This fixture has to state a REAL version bump, not just append a comment.
    // It used to append `// guard update marker` and leave the version alone,
    // which is two guards at the same version with different bytes -- the
    // hand-edit state, not a newer guard. The succeeding path took it anyway,
    // so the test passed while asserting something untrue about the installer.
    // The marker is kept, because a real guard update does change the body; the
    // stamp is what makes the claim true.
    const updated = stampGuardVersion(`${original}\n// guard update marker\n`, versionIn(original) + 1);
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
// A shim that carries our marker but is not the revision this script would
// write is refused, not replaced. "Unmodified older revision" and "somebody
// hand-edited it" are the same observation, and guessing either way is a false
// success: replacing destroys their check, refusing strands a host on a
// known-bad shim. --force is the deliberate override, and the refusal has to
// tell the operator which of the two commands applies.
test("re-install refuses a shim it cannot recognise, and --force replaces it", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const currentShim = readFileSync(hookPath, "utf8");

    // An older revision of our shim: the same header, but the checkout-first
    // resolution order that 1023ffe31 shipped. The first three lines of the
    // header are what identify the shim as ours, so those are kept.
    //
    // The branch is matched by shape and the injected path is a real one under
    // this fleet's own root, so the fixture reads the same on any platform.
    // See storedGuardBranch for why a literal /tmp was wrong here.
    const currentBlock = storedGuardBranch();
    assert.ok(currentBlock.test(currentShim), "fixture is wrong: no stored-guard branch found");
    const elsewhere = path.join(root, "stored-elsewhere.mjs").split(path.sep).join("/");
    const staleBlock =
      '  TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""\n' +
      '  if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/scripts/check-worktree-isolation.mjs" ]; then\n' +
      '    GUARD="$TOPLEVEL/scripts/check-worktree-isolation.mjs"\n' +
      `  elif [ -f "${elsewhere}" ]; then\n` +
      `    GUARD="${elsewhere}"\n` +
      '  fi\n';
    const staleShim = currentShim.replace(currentBlock, staleBlock);
    assert.notEqual(staleShim, currentShim, "fixture is wrong: could not make an older shim");
    writeFileSync(hookPath, staleShim, { mode: 0o755 });

    // Refused, and it says how to resolve it both ways.
    const refusedStale = installHook(main, ["--install"]);
    assert.equal(refusedStale.status, 1, "a stale shim was replaced without being asked");
    assert.match(refusedStale.stderr, /cannot be told\s+apart from a hand-edited hook/);
    assert.match(refusedStale.stderr, /rm /, "the refusal does not say how to resolve it");
    assert.match(refusedStale.stderr, /--force/, "the refusal does not mention the override");
    assert.equal(
      readFileSync(hookPath, "utf8"),
      staleShim,
      "a refused shim was modified anyway",
    );

    // The deliberate override does replace it, and says that it discarded
    // whatever was there.
    const forced = installHook(main, ["--install", "--force"]);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(forced.stderr, /--force/);
    assert.match(forced.stdout, /outdated shim replaced/);
    // Compared on trimmed content: the installer writes `shim` with its
    // trailing newline and compares normalised, so the raw file is not
    // byte-identical to the in-memory template.
    assert.equal(
      readFileSync(hookPath, "utf8").trimEnd(),
      currentShim.trimEnd(),
      "--force did not replace the shim",
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
//
// The argument has since changed sides. I chose exit 0 and put the decision to
// the review to be made by someone other than me; the security review reached
// the opposite conclusion independently, and on reflection it is right. A hook
// that cannot enforce anything is indistinguishable from no hook, and a guard
// that reports success while enforcing nothing is the failure this card exists
// to end. So: fail CLOSED when a seat identity is set, which is the case the
// control exists for, and keep the loud warning for a human with no seat
// identity, who is not governed by the seat rule.
test("with no guard anywhere a seat commit is refused, and a human commit is warned", () => {
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
    const headBefore = git(["rev-parse", "HEAD"], own).trim();

    // A SEAT commit with no guard: refused, and the refusal is not silent.
    const seatCommit = spawnSync("git", ["commit", "-m", "unguarded-seat"], {
      cwd: own,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    const seatOutput = `${seatCommit.stdout}${seatCommit.stderr}`;
    assert.notEqual(seatCommit.status, 0, `a seat commit with no guard was allowed: ${seatOutput}`);
    assert.equal(
      git(["rev-parse", "HEAD"], own).trim(),
      headBefore,
      "the commit landed even though the hook refused it",
    );
    assert.match(seatOutput, /NO GUARD FOUND/, "the refusal was silent");
    assert.match(seatOutput, /refusing the commit/, "the refusal does not say what it is doing");
    assert.match(seatOutput, /install-worktree-isolation-hook/, "the refusal does not say how to fix it");
    // A hook that exits 0 having enforced nothing is the defect, so a crash is
    // not an acceptable substitute for a decision.
    assert.doesNotMatch(seatOutput, /Cannot find module/, "the shim crashed instead of deciding");

    // A HUMAN commit with no guard: warned loudly, not blocked, and the
    // warning still says that seat commits are refused.
    writeFileSync(path.join(own, "h2.txt"), "h2\n");
    git(["add", "h2.txt"], own);
    const humanEnv = { ...gitEnv, KEE_WORKTREE_ROOT: worktrees };
    delete humanEnv.PAPERCLIP_AGENT_ID;
    const humanCommit = spawnSync("git", ["commit", "-m", "unguarded-human"], {
      cwd: own,
      encoding: "utf8",
      env: humanEnv,
    });
    const humanOutput = `${humanCommit.stdout}${humanCommit.stderr}`;
    assert.equal(humanCommit.status, 0, `a human commit should not be blocked: ${humanOutput}`);
    assert.match(humanOutput, /NO GUARD FOUND/, "the unguarded state was silent for a human either");
    assert.match(humanOutput, /will be refused/, "the human is not told seat commits are refused");
    assert.match(humanOutput, /install-worktree-isolation-hook/, "the warning does not say how to fix it");

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
    const hookAt = source.indexOf("writeFileAtomic(hookPath, shim");
    assert.ok(storeAt > -1 && hookAt > -1, "fixture is wrong: both writes should be present");
    assert.ok(
      storeAt < hookAt,
      "the hook is written before the stored guard, so an interrupted install leaves a live hook with no guard",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The findings that arrived on e5788c1e0, after the KEE-943 review closed. All
// four were reproduced by hand against the previous revision before being
// fixed, and each is pinned here against the same shapes.

// Greptile P1 "relative hooks path misses worktrees". Git resolves a relative
// core.hooksPath against the repository the commit happens in. A linked
// worktree's .git is a FILE, not a directory, so a relative path that is
// correct from the installing checkout resolves somewhere else -- usually
// nowhere -- from a linked worktree.
//
// The probe has to be decisive. A commit landing does not show whether the hook
// ran and allowed it, or never ran at all, so the fixture replaces the hook
// with one that always refuses and prints where it ran. That is the only way to
// tell "allowed" from "never invoked".
test("a relative core.hooksPath is refused: it does not resolve in a linked worktree", () => {
  const { root, main } = makeFleet();
  try {
    // A hook that always refuses, so the result cannot be ambiguous.
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho HOOK-RAN >&2\nexit 1\n", { mode: 0o755 });
    git(["config", "core.hooksPath", ".git/hooks"], main);

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const lane = path.join(worktrees, "paperclip-kee-923");
    git(["worktree", "add", "-q", lane, "-b", "keece/kee-923"], main);

    // From the primary checkout the relative path IS correct, so this is the
    // case the previous check resolved and accepted.
    writeFileSync(path.join(main, "p.txt"), "p\n");
    git(["add", "p.txt"], main);
    const primary = spawnSync("git", ["commit", "-m", "primary"], {
      cwd: main,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.notEqual(primary.status, 0, "fixture is wrong: the probe hook did not refuse in the primary checkout");
    assert.match(primary.stderr, /HOOK-RAN/, "the probe hook did not run in the primary checkout");

    // And the shape that is broken: in the linked worktree git resolves the
    // same relative path somewhere that has no hook, so the commit lands.
    writeFileSync(path.join(lane, "l.txt"), "l\n");
    git(["add", "l.txt"], lane);
    const headBefore = git(["rev-parse", "HEAD"], lane).trim();
    const inLane = spawnSync("git", ["commit", "-m", "linked"], {
      cwd: lane,
      encoding: "utf8",
      env: gitEnv,
    });
    assert.equal(inLane.status, 0, "fixture is wrong: the linked worktree was not unguarded");
    assert.doesNotMatch(inLane.stderr, /HOOK-RAN/, "fixture is wrong: the hook did run in the linked worktree");
    assert.notEqual(git(["rev-parse", "HEAD"], lane).trim(), headBefore, "the probe commit did not land");

    // So the installer must refuse this configuration rather than report a
    // success that enforces nothing in the very worktrees that need it.
    const refused = installHook(main, ["--install"]);
    assert.equal(refused.status, 1, "a relative core.hooksPath was accepted");
    assert.match(refused.stderr, /relative path/, "the refusal does not name the relative path as the problem");
    assert.match(refused.stderr, /Unset core\.hooksPath/, "the refusal does not say how to fix it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P1 "reinstall can truncate live hook". writeFileSync opens with
// O_TRUNC and then writes, so an interrupted write leaves the live hook
// truncated. That is worse than skipping the guard: the shim ends mid-string,
// the shell fails to parse it, prints "unexpected EOF", and git ALLOWS the
// commit anyway.
//
// Reproduced with `ulimit -f 1`, which lets the truncate land and then fails
// the write. chmod 444 does not reproduce it: that fails at open(), before
// anything is truncated, which is why an earlier attempt at this check passed
// against the broken code.
test("an interrupted re-install leaves the live hook byte-identical, not truncated", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0);
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");

    // Make it a shim this script would not write, so the replace path is the
    // one under test. --force is what an operator would use to get past the
    // new refusal, and it is the path that used to truncate.
    const stale = readFileSync(hookPath, "utf8").replace(
      "# Runs on every commit in every linked worktree of this repository.\n",
      "",
    );
    writeFileSync(hookPath, stale, { mode: 0o755 });
    const before = readFileSync(hookPath, "utf8");

    // RLIMIT_FSIZE of one block: the write fails part way, after the file has
    // been opened for truncation.
    const interrupted = spawnSync("sh", ["-c", 'ulimit -f 1; exec "$0" "$@"', ...installArgs(main, ["--install", "--force"])], {
      cwd: main,
      encoding: "utf8",
    });
    assert.notEqual(interrupted.status, 0, "fixture is wrong: the write was not interrupted");

    const after = readFileSync(hookPath, "utf8");
    assert.equal(after, before, "the live hook was truncated by an interrupted install");
    assert.match(after, /\nexit \$\?\n$/, "the surviving shim does not end with the guard invocation");
    // The staging file must be cleaned up, or it accumulates in .git/hooks.
    const leftovers = readdirSync(path.join(main, ".git", "hooks")).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, [], "a staging file was left behind by the failed install");

    // And the shim still enforces: a cross-seat commit is refused.
    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const shared = path.join(worktrees, "paperclip-kee-923");
    git(["worktree", "add", "-q", shared, "-b", "keece/kee-923"], main);
    writeFileSync(path.join(shared, "s.txt"), "s\n");
    git(["add", "s.txt"], shared);
    const headBefore = git(["rev-parse", "HEAD"], shared).trim();
    const crossSeat = spawnSync("git", ["commit", "-m", "cross-seat"], {
      cwd: shared,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    assert.notEqual(crossSeat.status, 0, "the surviving hook stopped enforcing");
    assert.equal(git(["rev-parse", "HEAD"], shared).trim(), headBefore, "a cross-seat commit landed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Greptile P2 "reinstall discards hook edits". An operator's hand-edited hook
// and an unmodified older revision of ours are the same observation, and the
// previous behaviour picked "older revision" and destroyed their edit while
// printing "outdated shim replaced" and exiting 0.
//
// Three shapes, because they are three different things and the distinction is
// the point:
//
//   appended, body unchanged  -- our block is current, their check follows it.
//                               Replacing our block keeps their content, which
//                               is what the remainder path is for. Pinned so the
//                               refusal below does not over-reach and start
//                               blocking a case that is actually safe.
//   appended, body changed   -- our block is stale AND their check follows it.
//                               Ambiguous, so it must refuse rather than pick.
//   in-block                 -- their edit is inside the shim we would rewrite,
//                               so there is no remainder to preserve and the
//                               only way to keep it is to refuse.
test("re-install keeps an appended check, and refuses when the shim itself was edited", () => {
  const shapes = [
    { name: "appended, body unchanged", editBody: false, expectStatus: 0 },
    { name: "appended, body changed", editBody: true, expectStatus: 1 },
    { name: "in-block", editBody: true, expectStatus: 1, inBlock: true },
  ];

  for (const { name, editBody, expectStatus, inBlock = false } of shapes) {
    const { root, main } = makeFleet();
    try {
      assert.equal(installHook(main, ["--install"]).status, 0, `fixture is wrong (${name})`);
      const hookPath = path.join(main, ".git", "hooks", "pre-commit");
      const current = readFileSync(hookPath, "utf8");

      // Staleness, if this shape needs it: drop a line from our own block, so
      // the shim on disk is not the revision this script would write.
      const stale = editBody
        ? current.replace("# Runs on every commit in every linked worktree of this repository.\n", "")
        : current;

      const edited = inBlock
        ? stale.replace(
            'GUARD="${KEE_WORKTREE_ISOLATION_GUARD:-}"',
            'echo OPERATOR-CHECK >&2\nGUARD="${KEE_WORKTREE_ISOLATION_GUARD:-}"',
          )
        : `${stale}# operator's own check\necho OPERATOR-CHECK >&2\n`;
      assert.match(edited, /OPERATOR-CHECK/, `fixture is wrong: the ${name} edit did not apply`);
      writeFileSync(hookPath, edited, { mode: 0o755 });

      const reinstall = installHook(main, ["--install"]);
      assert.equal(
        reinstall.status,
        expectStatus,
        `wrong outcome for ${name}: ${reinstall.stdout}${reinstall.stderr}`,
      );
      assert.match(
        readFileSync(hookPath, "utf8"),
        /OPERATOR-CHECK/,
        `the operator's check was silently discarded in the ${name} case`,
      );
      if (expectStatus !== 0) {
        assert.doesNotMatch(
          reinstall.stdout,
          /outdated shim replaced/,
          `claimed to replace an edited hook in the ${name} case`,
        );
        assert.match(reinstall.stderr, /--force/, `the ${name} refusal does not say how to resolve it`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// KEE-955, from the third review of this branch (KEE-954). Four findings, each
// reproduced by hand against 62d784879 before being fixed, and each pinned here
// against the same shape so the fix cannot be quietly undone.
//
// The first one is the blocker. --check is the supported health command for
// this hook, and it answered "is there a file carrying our marker" -- which is
// true of a shim written by any revision of this script, including one written
// before the fix. The re-install refusal makes that state permanent on purpose,
// so the two commands disagreed about the same file and only one of them was
// right. Measured at head: --check exit 0 and --install exit 1, on the same
// host, on the same bytes.
test("--check reports a shim that is not this revision, the way --install does", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const current = readFileSync(hookPath, "utf8");

    // The same older revision the neighbouring test builds, made here by
    // dropping one line from our own block instead. Simpler, and it is the
    // honest shape of the real host: a shim from a revision that had fewer
    // lines than this one.
    const stale = current.replace(
      "# Runs on every commit in every linked worktree of this repository.\n",
      "",
    );
    assert.notEqual(stale, current, "fixture is wrong: could not make an older shim");
    writeFileSync(hookPath, stale, { mode: 0o755 });

    const check = installHook(main, ["--check"]);
    assert.equal(check.status, 1, `--check called a stale shim installed: ${check.stdout}`);
    assert.match(
      check.stderr,
      /not the revision this script would write/,
      "--check does not report the revision problem",
    );
    // It has to name both resolutions, or an operator reading it cannot act.
    assert.match(check.stderr, /rm /, "--check does not say how to resolve a stale shim");
    assert.match(check.stderr, /--force/, "--check does not mention the deliberate override");

    // And --check and --install must agree, which is the entire finding.
    const install = installHook(main, ["--install"]);
    assert.equal(install.status, 1, "control: --install should also refuse this shim");
    assert.equal(
      check.status,
      install.status,
      "--check and --install disagree about the same file, which is the defect this test pins",
    );

    // A hook somebody appended a check to is NOT a revision problem: that
    // addition is ours to keep, and the installer keeps it. Reporting it as
    // stale would point an operator at a file that is actually fine.
    writeFileSync(hookPath, current, { mode: 0o755 });
    assert.equal(installHook(main, ["--check"]).status, 0, "the current shim is not reported current");
    const withAppended = `${current}# somebody else's important check\nexit 0\n`;
    writeFileSync(hookPath, withAppended, { mode: 0o755 });
    const appended = installHook(main, ["--check"]);
    assert.equal(
      appended.status,
      0,
      `--check called a foreign appended check a revision problem: ${appended.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --force is the one place this script destroys content it cannot reconstruct,
// and it used to do so silently: the operator was told an edit was being
// discarded, was not shown it, and no copy was left. This host already carries
// a backup from a hand repair (pre-commit.pre-1023ffe31...bak), so the
// convention exists and the installer was the only part not following it.
test("--force keeps a copy of the hook it replaces, and says where", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const hooksDir = path.dirname(hookPath);
    const current = readFileSync(hookPath, "utf8");

    // An edit INSIDE our block, leaving header and terminator in place. This is
    // the case the review measured and the one that is unrecoverable: the file
    // still looks like a revision of ours, so the installer cannot tell it from
    // a stale shim, and the whole reason --force exists is that it cannot.
    const edited = current.replace(
      'GUARD="${KEE_WORKTREE_ISOLATION_GUARD:-}"',
      'echo OPERATOR-CHECK >&2\nGUARD="${KEE_WORKTREE_ISOLATION_GUARD:-}"',
    );
    assert.match(edited, /OPERATOR-CHECK/, "fixture is wrong: the edit did not apply");
    writeFileSync(hookPath, edited, { mode: 0o755 });

    const before = readdirSync(hooksDir).filter((f) => f.endsWith(".bak"));
    const forced = installHook(main, ["--install", "--force"]);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);

    // The operator's edit is gone from the live hook, as --force promises...
    assert.doesNotMatch(
      readFileSync(hookPath, "utf8"),
      /OPERATOR-CHECK/,
      "--force did not replace the shim",
    );
    // ...and is recoverable, which is the whole point of the fix.
    const after = readdirSync(hooksDir).filter((f) => f.endsWith(".bak"));
    assert.equal(after.length, before.length + 1, "--force left no backup of the hook it replaced");
    const backup = readFileSync(path.join(hooksDir, after.find((f) => !before.includes(f))), "utf8");
    assert.match(backup, /OPERATOR-CHECK/, "the backup does not contain the edit that was discarded");
    assert.equal(backup, edited, "the backup is not the file that was actually replaced");
    // It is named so an operator can tell which revision was replaced and when,
    // and it is the same convention the hand repair on this host used.
    const name = after.find((f) => !before.includes(f));
    assert.match(name, /^pre-commit\.pre-[0-9a-f]+\.\d{8}T\d{6}Z\.bak$/, `unexpected backup name: ${name}`);
    // And the message says where it went, rather than only that something was lost.
    assert.match(forced.stderr, /kept at/, "--force does not say where the outgoing hook went");
    assert.match(forced.stderr, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A seat blocked by NO GUARD FOUND is, on this host, almost always in a
// worktree whose HEAD has no scripts/install-worktree-isolation-hook.mjs -- 56
// of 58 at the time of the review. The message told it to run that script, which
// is advice the blocked seat cannot follow, so the one command that would fix
// the block pointed at a file that is not there.
test("the no-guard refusal names a checkout that has the installer in it", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    rmSync(stored);
    rmSync(path.join(main, "scripts", "check-worktree-isolation.mjs"));

    const worktrees = path.join(root, "keece-issue-worktrees");
    mkdirSync(worktrees, { recursive: true });
    const blocked = path.join(worktrees, `paperclip-kee-923-${SEAT_B_SHORT}`);
    git(["worktree", "add", "-q", blocked, "-b", "keece/kee-923-y"], main);
    rmSync(path.join(blocked, "scripts", "check-worktree-isolation.mjs"), { force: true });
    writeFileSync(path.join(blocked, "g.txt"), "g\n");
    git(["add", "g.txt"], blocked);

    const commit = spawnSync("git", ["commit", "-m", "unguarded"], {
      cwd: blocked,
      encoding: "utf8",
      env: { ...gitEnv, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: worktrees },
    });
    const output = `${commit.stdout}${commit.stderr}`;
    assert.notEqual(commit.status, 0, "control: a seat commit with no guard should be refused");
    assert.match(output, /NO GUARD FOUND/, "control: the refusal did not fire");

    // It has to name an absolute path a human can act on, and name the actor.
    assert.match(
      output,
      new RegExp(main.split(path.sep).join("/")),
      "the refusal does not name the lane the shim was installed from",
    );
    assert.match(output, /operator/i, "the refusal does not say who has to act");
    assert.doesNotMatch(
      output,
      /^\s+Run: node scripts\/install-worktree-isolation-hook\.js\s*$/m,
      "the refusal still tells a lane with no installer to run the installer",
    );
    // The bare relative instruction is what cannot work from the blocked lane.
    assert.doesNotMatch(output, /Run: node scripts\/install-worktree-isolation-hook\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The stored guard is preferred over the checkout's on purpose, because most
// lanes have no guard of their own. But the two copies have different freshness
// guarantees: the checkout's is refreshed by git pull on every merge, the
// stored one only when an operator re-runs this script. The preference is
// therefore systematically for the staler of the two, and --check said nothing
// about it. Measured before the fix: stored sha1 9a015171 against checkout
// f742cfbb, --check exit 0, no mention of either.
test("--check names which guard is in force when the stored copy has drifted", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");

    // In step, and --check is quiet: there is nothing to say.
    const agreed = installHook(main, ["--check"]);
    assert.equal(agreed.status, 0, `control: a fleet in step is reported broken: ${agreed.stderr}`);

    // Update the guard in the checkout only -- exactly what a `git pull` of a
    // lane that carries the guard does, with no re-install anywhere. Stamped as
    // a real version bump: an appended comment alone leaves the version where it
    // was, which is the hand-edit state and is NOT something a re-install is
    // expected to resolve.
    const updated = stampGuardVersion(
      `${readFileSync(stored, "utf8")}\n// guard update marker\n`,
      versionIn(readFileSync(stored, "utf8")) + 1,
    );
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), updated);

    const drifted = installHook(main, ["--check"]);
    assert.equal(
      drifted.status,
      1,
      `--check said nothing about a stored guard that is not the checkout's: ${drifted.stdout}`,
    );
    assert.match(drifted.stderr, /stored sha1 [0-9a-f]{8} vs checkout sha1 [0-9a-f]{8}/, "no hashes");
    assert.match(drifted.stderr, /STORED/, "--check does not say which copy the shim runs");
    assert.match(
      drifted.stderr,
      /install-worktree-isolation-hook\.mjs/,
      "--check does not name the command that makes them agree",
    );

    // Re-installing resolves it, because the re-install path refreshes the
    // stored copy from this checkout. This is the assertion that makes the
    // message above a real instruction rather than a complaint.
    assert.equal(installHook(main, ["--install"]).status, 0);
    assert.equal(readFileSync(stored, "utf8"), updated, "the re-install did not refresh the stored guard");
    assert.equal(installHook(main, ["--check"]).status, 0, "--check still complains after a re-install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The refusal path's other half. The shim is ambiguous and is left alone, which
// is right. The stored guard is not the ambiguous object -- it is this script's
// own file, copied from a known path, and every commit in the fleet runs it --
// but it is not safe to overwrite merely because it is unambiguous. It is
// refreshed only where doing so cannot lose ground, because a refresh from a
// lane that is behind the fleet is a fleet-wide downgrade of the guard on a run
// that refused. This is the deliberate decision the review asked to be made
// rather than defaulted to, so it is pinned in both directions: the guard is
// refreshed where it can be, withheld where it cannot, and the shim is never
// touched either way.
test("the refusal path leaves the shim alone, and refreshes the guard only when it cannot lose ground", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");

    // A shim this script cannot read the state of. The refusal is the point, and
    // it must be a refusal in every case below.
    const staleShim = readFileSync(hookPath, "utf8").replace(
      "# Runs on every commit in every linked worktree of this repository.\n",
      "",
    );
    writeFileSync(hookPath, staleShim, { mode: 0o755 });

    // Case 1: no stored guard at all. There is nothing to lose, so the guard is
    // written from this checkout and the message says so.
    rmSync(stored, { force: true });
    const created = installHook(main, ["--install"]);
    assert.equal(created.status, 1, "control: the shim should still be refused");
    assert.equal(readFileSync(hookPath, "utf8"), staleShim, "the refusal path modified the shim anyway");
    assert.equal(
      readFileSync(stored, "utf8"),
      readFileSync(guardInCheckout, "utf8"),
      "with no stored guard there is nothing to downgrade, so it should be written",
    );
    assert.match(created.stderr, /stored guard has been refreshed/, "the refusal does not say what it did fix");

    // Case 2: the stored guard and this checkout's already agree. Refreshing is
    // a no-op in content, but the claim it makes is still a real one and is
    // still what the operator is told.
    const agreed = installHook(main, ["--install"]);
    assert.equal(agreed.status, 1);
    assert.equal(readFileSync(stored, "utf8"), readFileSync(guardInCheckout, "utf8"));
    assert.match(agreed.stderr, /stored guard has been refreshed/);

    // Case 3: they differ. The installer cannot tell which is newer, and the
    // stored copy is the one every commit in every worktree runs, so it is left
    // alone -- in BOTH directions, because a guess in the other direction is
    // just as wrong. This is the KEE-957 finding 3 regression: a lane behind the
    // fleet used to overwrite the fleet's guard with its own older one, on a run
    // that exited 1 and said "Refusing to guess".
    const otherLaneGuard = `${readFileSync(guardInCheckout, "utf8")}\n// a different lane's guard\n`;
    writeFileSync(stored, otherLaneGuard);
    writeFileSync(guardInCheckout, `${readFileSync(guardInCheckout, "utf8")}\n// this lane's guard\n`);
    const withheld = installHook(main, ["--install"]);
    assert.equal(withheld.status, 1, "control: the shim should still be refused");
    assert.equal(
      readFileSync(stored, "utf8"),
      otherLaneGuard,
      "the refusal replaced a fleet-wide guard with one lane's copy, which is a downgrade when that lane is behind",
    );
    assert.match(
      withheld.stderr,
      /stored guard has NOT been changed/,
      "the refusal does not say it withheld the refresh, so the operator cannot tell what happened to the guard in force",
    );
    assert.doesNotMatch(
      withheld.stderr,
      /stored guard has been refreshed/,
      "the refusal claims a refresh it did not perform",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check and --install agree on a whitespace-only edit inside the shim's block", () => {
  // Not a defect, and not something the design set out to catch: the comparison
  // is on bytes, so a change that only moves whitespace is a difference like any
  // other and the installer refuses it. What matters, and what was untested, is
  // that the two commands agree about it -- the KEE-955 blocker was precisely
  // that they did not. Pinned so a future normalisation pass cannot change
  // --check's answer without somebody deciding to.
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");

    // Indent a comment line inside our own block. Still valid sh, still ours,
    // still running the same guard -- but not the bytes this script writes.
    const respaced = readFileSync(hookPath, "utf8").replace(
      "# One seat owns one worktree. See scripts/check-worktree-isolation.mjs.\n",
      "#   One seat owns one worktree. See scripts/check-worktree-isolation.mjs.\n",
    );
    writeFileSync(hookPath, respaced, { mode: 0o755 });

    const check = installHook(main, ["--check"]);
    const install = installHook(main, ["--install"]);
    assert.equal(check.status, 1, `--check accepted a shim that is not this revision: ${check.stdout}`);
    assert.equal(install.status, 1, "the installer accepted a shim that is not this revision");
    assert.match(check.stderr, /not the revision this script would write/, "--check does not name the problem");
    assert.equal(
      readFileSync(hookPath, "utf8"),
      respaced,
      "a refusal modified the shim it was refusing to guess about",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// KEE-966: one write path, and the ruling on an unmeasured guard.
//
// Everything below is about the moment a write happens. Before this, the
// installer had two answers to one question: guardRefreshOutcome() on the
// succeeding path, and an inline copy of the rule on the refusing path. They
// disagreed in two states, and both disagreements were the wrong way -- the
// succeeding path wrote where it should have withheld.
//
// Measured on 6f99a78f0, same state, two answers:
//
//   state (stored / checkout)   succeeding path    refusing path
//   v2 / v1                     withheld           withheld
//   v2 / v3                     takes over         takes over
//   v2 / v2 edited              CHECKOUT WINS      stored kept
//   v2 / unstamped              LANE COPY WINS     withheld
//
// The two bottom rows are what this file closes. A rule that exists in two
// places is a rule that will be changed in one of them.
// ---------------------------------------------------------------------------

/**
 * A guard with the stamp line removed entirely.
 *
 * Not "a comment appended": no version line at all, which is what a
 * hand-written or vendored guard looks like, and what 3 of the 4 guard files on
 * this host actually are. This is the shape the ruling is about.
 */
function unstampGuard(guardText) {
  return guardText.replace(/^[ \t]*(?:\*[ \t]*)?#?[ \t]*worktree-isolation-guard-version:[ \t]*\d+[ \t]*\n/m, "");
}

/**
 * The stale shim, which forces --install onto the refusing path.
 *
 * The shim is a real object here, not a mock: the refusal branch is only
 * reached when the hook carries our marker and is not the revision this script
 * would write, and the honest way to produce that is to install, then remove a
 * line this script always emits.
 */
function makeShimStale(main) {
  const hookPath = path.join(main, ".git", "hooks", "pre-commit");
  const stale = readFileSync(hookPath, "utf8").replace(
    "# Runs on every commit in every linked worktree of this repository.\n",
    "",
  );
  writeFileSync(hookPath, stale, { mode: 0o755 });
  return stale;
}

test("an unstamped lane guard does not displace a stamped fleet guard on a succeeding --install", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");

    const storedBefore = readFileSync(stored, "utf8");
    // Read the version rather than assuming 2. This commit raises the guard's
    // own stamp to 3, and a test that hard-coded the old number would fail for
    // a reason that has nothing to do with what it is checking.
    const fleetVersion = versionIn(storedBefore);
    assert.ok(fleetVersion > 0, "fixture is wrong: the fleet guard carries no version stamp");

    // This checkout's guard now declares nothing: the hand-written or vendored
    // shape, and the shape of the 3 unstamped lane guards on this host.
    const unstamped = unstampGuard(storedBefore);
    assert.equal(versionIn(unstamped), 0, "fixture is wrong: the lane guard is still stamped");
    writeFileSync(guardInCheckout, unstamped);

    const run = installHook(main, ["--install"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);

    // The assertion this test exists for. Measured on 6f99a78f0 as
    // "stored 4c5ec6c1 -> b9a83f1b exit=0, FLEET GUARD ROLLED BACK".
    assert.equal(
      readFileSync(stored, "utf8"),
      storedBefore,
      "an unstamped lane guard displaced a stamped fleet-wide guard on an ordinary --install",
    );

    // And it must say so, loudly, naming what is in force and how to override.
    // Silence is the defect; a refusal nobody can act on is the same defect.
    assert.match(run.stdout, /NOT replaced/, "the withholding was not reported");
    assert.match(run.stdout, /no version stamp/, "the report does not say why it withheld");
    assert.match(
      run.stdout,
      new RegExp(`version ${fleetVersion}`),
      "the report does not say what version is in force",
    );
    assert.match(run.stdout, /--force/, "the report does not name the command that overrides this");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an unstamped lane guard does not displace a stamped fleet guard on the REFUSING path either", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");

    const storedBefore = readFileSync(stored, "utf8");
    const staleShim = makeShimStale(main);
    writeFileSync(guardInCheckout, unstampGuard(storedBefore));

    const refused = installHook(main, ["--install"]);
    assert.equal(refused.status, 1, "control: the stale shim should still be refused");
    assert.equal(readFileSync(path.join(main, ".git", "hooks", "pre-commit"), "utf8"), staleShim);
    assert.equal(
      readFileSync(stored, "utf8"),
      storedBefore,
      "the refusing path let an unstamped copy replace the stamped fleet guard",
    );
    assert.match(refused.stderr, /stored guard has NOT been changed/);
    assert.match(refused.stderr, /no version stamp/, "the refusal does not say it withheld for this reason");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the two write paths agree, state for state", () => {
  // The property the card is actually about: ONE answer per state, not one
  // per code path. Each state is driven twice, once down the succeeding path
  // and once down the refusing path, and the stored guard must end up the same
  // bytes both times.
  const { root, main } = makeFleet();
  try {
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");
    assert.equal(installHook(main, ["--install"]).status, 0);
    const fleet = readFileSync(stored, "utf8");
    const fleetVersion = versionIn(fleet);

    // A guard one version behind, and one ahead, expressed honestly.
    const states = {
      older: stampGuardVersion(fleet, fleetVersion - 1),
      newer: stampGuardVersion(`${fleet}\n// a later revision\n`, fleetVersion + 1),
      unstamped: unstampGuard(fleet),
      differs: `${fleet}\n// somebody hand-edited this copy\n`,
    };

    for (const [name, guardText] of Object.entries(states)) {
      for (const refusing of [false, true]) {
        // Reset the fleet state DIRECTLY, not by running the installer.
        //
        // Two earlier versions of this reset used a plain --install after
        // deleting the hook, and both were wrong in the same way: a --install
        // cannot restore the fleet guard, it can only move it forward. Once the
        // `newer` succeeding pass has published v3, the next reset installs v3
        // again (it is newer than v2, correctly) and the assertion fires on the
        // test's own bookkeeping rather than on installer behaviour. Writing the
        // known-good state is what "reset" has to mean for a fixture whose whole
        // subject is a rule about which copy wins.
        rmSync(path.join(main, ".git", "hooks", "pre-commit"), { force: true });
        writeFileSync(guardInCheckout, fleet);
        writeFileSync(stored, fleet, { mode: 0o755 });
        const before = readFileSync(stored, "utf8");
        assert.equal(before, fleet, `fixture is wrong for ${name}: the fleet guard moved`);
        if (refusing) {
          // The hook has to EXIST before it can be made stale, and the only
          // honest way to get a real one is to install it -- so install it with
          // the checkout's guard in step, then age the shim.
          assert.equal(
            installHook(main, ["--install"]).status,
            0,
            `fixture is wrong for ${name}: could not install a shim to make stale`,
          );
          assert.equal(
            readFileSync(stored, "utf8"),
            fleet,
            `fixture is wrong for ${name}: installing a matching shim moved the guard`,
          );
          makeShimStale(main);
        }

        writeFileSync(guardInCheckout, guardText);
        const run = installHook(main, ["--install"]);
        assert.ok(run.status === 0 || run.status === 1, `unexpected status for ${name}`);
        const after = readFileSync(stored, "utf8");
        const label = `${name} / ${refusing ? "refusing" : "succeeding"}`;

        if (name === "newer") {
          assert.equal(after, guardText, `${label}: a genuinely newer guard must take over`);
        } else {
          assert.equal(after, before, `${label}: the stored guard must be left alone`);
        }
      }
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("--force installs an unstamped guard, and says what it displaced", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");
    const stamped = readFileSync(stored, "utf8");
    const fleetVersion = versionIn(stamped);

    const unstamped = unstampGuard(stamped);
    writeFileSync(guardInCheckout, unstamped);

    // This is the behaviour change the ruling makes, and the cost of it: a
    // hand-written guard can still take over, but only deliberately, and the
    // run says so instead of replacing a fleet guard on an ordinary --install.
    const forced = installHook(main, ["--install", "--force"]);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(readFileSync(stored, "utf8"), unstamped, "--force did not install the unstamped guard");
    assert.match(forced.stdout, /refreshed/, "--force did not report the refresh");
    assert.match(forced.stdout, /--force/, "a forced guard replacement was not identified as one");
    assert.match(
      forced.stdout,
      new RegExp(`version ${fleetVersion}`),
      "the forced run does not say what it displaced",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a REFUSED --force cannot quietly downgrade the fleet guard", () => {
  // --force is the override, and the override has to be visible. This is the
  // pair the ruling is really about: the same state, the same answer, and the
  // forced run is the only one that writes -- but it writes saying so.
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");
    const fleet = readFileSync(stored, "utf8");

    const older = stampGuardVersion(fleet, versionIn(fleet) - 1);
    writeFileSync(guardInCheckout, older);

    const ordinary = installHook(main, ["--install"]);
    assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    assert.equal(readFileSync(stored, "utf8"), fleet, "an ordinary --install downgraded the fleet guard");
    assert.match(ordinary.stdout, /NOT replaced/);
    assert.doesNotMatch(ordinary.stdout, /--force: this checkout's guard/, "an ordinary run claimed to be forced");

    const forced = installHook(main, ["--install", "--force"]);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(readFileSync(stored, "utf8"), older, "--force did not take the deliberate downgrade");
    assert.match(
      forced.stdout,
      /--force: this checkout's guard is an OLDER revision/,
      "a forced downgrade was not reported as one",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// The KEE-958 REVERT test, kept (KEE-966 item 3).
//
// It is the only test in the project that catches a stamp-based revert
// regression, and it was carried on the `kee-958-refusal-guard-downgrade` line
// (0727e4dde) where it orders guards by git ANCESTRY rather than by a version
// stamp. It passed against 6f99a78f0 unported, which is a fact about the two
// mechanisms and not about this suite: a revert lane and a stale lane are
// indistinguishable under a stamp, because both are simply "not newer".
//
// So it is reproduced here against the stamp mechanism, with the ancestry
// fixture assertions kept -- they are what proves the shape is a REVERT and not
// just a lane that happens to be behind. If the shape stops being a revert, the
// fixture fails before the assertion under test is reached, which is the point.
function isAncestorExit(ancestor, descendant, cwd) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, encoding: "utf8" }).status;
}

test("a refusing --install from a REVERTED guard lane does not roll the stored guard back", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const checkoutGuard = path.join(main, "scripts", "check-worktree-isolation.mjs");
    const current = readFileSync(checkoutGuard, "utf8");
    // An "older revision" in stamp terms: a LOWER version, honestly declared.
    // Expressing it as an appended comment would make it `differs`, and the
    // test would then be measuring the hand-edit rule instead of the revert one.
    const older = stampGuardVersion(`${current}\n// an older revision of the guard\n`, versionIn(current) - 1);

    // c1: the OLD guard, committed.
    writeFileSync(checkoutGuard, older);
    git(["add", "-A"], main);
    git(["commit", "-q", "-m", "guard: older revision"], main);

    // c2: the NEW guard, committed. This is where the fleet is parked.
    writeFileSync(checkoutGuard, current);
    git(["add", "-A"], main);
    git(["commit", "-q", "-m", "guard: current revision"], main);
    assert.equal(installHook(main, ["--install"]).status, 0);
    const storedBefore = readFileSync(stored, "utf8");
    assert.equal(storedBefore, current, "fixture is wrong: the stored guard is not the current one");

    // c3: revert the guard to the OLD bytes. Same content as c1, but its newest
    // carrier is now a DESCENDANT of c2's -- which is the whole point.
    writeFileSync(checkoutGuard, older);
    git(["add", "-A"], main);
    git(["commit", "-q", "-m", "Revert the guard to the older revision"], main);

    // Prove the fixture really is the shape it claims, so a green run cannot be
    // a fixture that never built the revert.
    const carriers = git(["log", "--all", "--format=%H", "--", "scripts/check-worktree-isolation.mjs"], main)
      .split("\n")
      .filter(Boolean);
    const revert = git(["rev-parse", "HEAD"], main).trim();
    assert.equal(carriers[0], revert, "fixture is wrong: the revert is not the newest carrier of the old content");
    const newCarrier = carriers.find((r) => r !== revert);
    assert.ok(newCarrier, "fixture is wrong: the current content has no carrier");
    assert.equal(
      isAncestorExit(newCarrier, revert, main),
      0,
      "fixture is wrong: the revert is not a descendant of the new-content commit",
    );

    // The stale shim, so --install takes the refusing branch.
    const staleShim = makeShimStale(main);

    const refused = installHook(main, ["--install"]);
    assert.equal(refused.status, 1, "control: the shim should still be refused");
    assert.equal(readFileSync(path.join(main, ".git", "hooks", "pre-commit"), "utf8"), staleShim);

    // The assertion this test exists for: a revert lane must not outrank the
    // stored guard just because the revert commit is the newer one.
    assert.equal(
      readFileSync(stored, "utf8"),
      storedBefore,
      "a refusing --install from a REVERTED guard lane DOWNGRADED the stored guard",
    );

    // And the message must not claim a refresh it did not perform.
    assert.doesNotMatch(
      refused.stderr,
      /stored guard has been refreshed/,
      "the refusal claims a refresh that did not happen",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// The `shim` succeeding path: an outdated shim that IS recognisably ours is
// replaced, and the run exits 0.
//
// KEE-966 names this as unexercised on every branch to date, and it is the
// branch where the fix in this commit is easiest to get wrong. The
// guardRefreshOutcome() call sits AFTER the shim write, so a shim replacement
// and a guard write happen in the same run on different code paths -- and the
// guard half of that run is exactly the one that was unguarded. This test
// covers the combination rather than either half.
//
// A correction to the shape this test was first written in, made because the
// code said so: there is no unforced path to "outdated shim replaced". Any shim
// carrying our marker whose body is not the revision we would write goes to the
// REFUSING branch, and only --force reaches the replacement. That is the
// deliberate KEE-954 design ("refuse, name both states, say the one command
// that resolves it") and the existing suite already pins it. The card's note
// that this path is unexercised is therefore about the forced form, which is
// what is exercised here.
//
// The reason it is worth exercising at all: --force is also the escape hatch
// for the guard rule added in this commit, so one --force run now reaches BOTH
// overrides. The guard half must not be silently skipped because the shim half
// succeeded, and the shim half must not be reported as a refusal because the
// guard half withheld.
test("--force replaces an outdated shim of ours, exit 0, and still applies the guard rule", () => {
  const { root, main } = makeFleet();
  try {
    assert.equal(installHook(main, ["--install"]).status, 0, "fixture is wrong: install did not run");
    const hookPath = path.join(main, ".git", "hooks", "pre-commit");
    const stored = path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
    const guardInCheckout = path.join(main, "scripts", "check-worktree-isolation.mjs");
    const fleet = readFileSync(stored, "utf8");
    const currentShim = readFileSync(hookPath, "utf8");

    // A recognisably ours, genuinely outdated shim: an older revision of the
    // block, produced the way the existing suite produces one, by replacing the
    // stored-guard branch with the toplevel-only branch an earlier revision
    // emitted.
    const elsewhere = path.join(root, "stored-elsewhere.mjs").split(path.sep).join("/");
    const outdated = currentShim.replace(
      storedGuardBranch(),
      `  TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""\n` +
        `  if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/scripts/check-worktree-isolation.mjs" ]; then\n` +
        `    GUARD="$TOPLEVEL/scripts/check-worktree-isolation.mjs"\n` +
        `  elif [ -f "${elsewhere}" ]; then\n` +
        `    GUARD="${elsewhere}"\n` +
        `  fi\n`,
    );
    assert.notEqual(outdated, currentShim, "fixture is wrong: could not make an older shim");
    writeFileSync(hookPath, outdated, { mode: 0o755 });

    // Control: --force replaces the shim, and the guard is untouched because
    // this checkout's guard still matches what is in force.
    const replaced = installHook(main, ["--install", "--force"]);
    assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
    assert.match(replaced.stdout, /outdated shim replaced/, "the outdated shim was not replaced");
    assert.equal(
      readFileSync(hookPath, "utf8").trimEnd(),
      currentShim.trimEnd(),
      "--force did not install the current shim",
    );
    assert.equal(readFileSync(stored, "utf8"), fleet, "a clean shim replacement moved the guard");

    // The half that was unguarded: the same --force run, with this checkout's
    // guard unstamped. --force legitimately takes the unstamped copy, and it
    // must SAY that it did -- this is the one path where the guard is replaced
    // on a run that also replaced the shim.
    writeFileSync(hookPath, outdated, { mode: 0o755 });
    const unstamped = unstampGuard(fleet);
    writeFileSync(guardInCheckout, unstamped);

    const both = installHook(main, ["--install", "--force"]);
    assert.equal(both.status, 0, both.stdout + both.stderr);
    assert.match(both.stdout, /outdated shim replaced/, "the shim half stopped working");
    assert.equal(readFileSync(stored, "utf8"), unstamped, "--force did not install the unstamped guard either");
    assert.match(
      both.stdout,
      /--force: this checkout's guard carries no version stamp/,
      "a forced guard replacement was not reported in the same run that forced the shim",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
