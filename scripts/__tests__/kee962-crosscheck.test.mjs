/**
 * KEE-962 cross-check: does a succeeding --install roll the fleet guard back?
 *
 * Rebuilt by run c97e71d7 on 2026-09-27, then re-seated by run 831d2090 after the
 * KEE-966 review (KEE-971) and the KEE-966 ruling landed.
 *
 * HISTORY, because the defect in the first version of this file is the reason the
 * rules below exist. The first version lived in a Paperclip scratch directory,
 * which the runtime deletes at run end: the RESULTS were on the card and the test
 * SOURCE was in neither, so a reviewer was handed a claim with no way to run it.
 * The reviewer then found that the rebuilt copy could not run on the branch it
 * was committed to (its base, d3e0f0a23, has neither script this file loads),
 * and that it was wired into no CI job. Both were true, both were mine, and both
 * are fixed here.
 *
 * HOW TO RUN -- two ways, both supported:
 *
 *   1. Inside a checkout that carries the scripts (the normal case, now true):
 *
 *        node --test scripts/__tests__/kee962-crosscheck.test.mjs
 *
 *   2. Against a revision that is not checked out. The paths resolve the
 *      installer and the guard as siblings of this file, so stage them:
 *
 *        work=$(mktemp -d); mkdir -p $work/scripts/__tests__
 *        git show <rev>:scripts/install-worktree-isolation-hook.mjs > $work/scripts/install-worktree-isolation-hook.mjs
 *        git show <rev>:scripts/check-worktree-isolation.mjs        > $work/scripts/check-worktree-isolation.mjs
 *        cp scripts/__tests__/kee962-crosscheck.test.mjs $work/scripts/__tests__/
 *        ( cd $work && node --test scripts/__tests__/kee962-crosscheck.test.mjs )
 *
 * THE CLAIM UNDER TEST, stated so it can fail:
 *
 *   On a succeeding --install, a guard that cannot show it is newer than the
 *   copy already in force must not replace that copy, and the operator must be
 *   told out loud that it was left alone.
 *
 *   Silence on a write is the hazard. A green tick from the installer is not a
 *   verification, and neither is a green tick from this file -- see the fixture
 *   rules at the bottom of this header.
 *
 * LINEAGE. Two of the revisions this file is run against are NOT on one line.
 * 1f14cdd6e is an ancestor of 0727e4dde; 6f99a78f0 is neither an ancestor nor a
 * descendant of 0727e4dde. They diverged. An earlier version of this file called
 * 0727e4dde "the ancestry line", which reads as linear and is not -- a reader
 * trusting it would mis-locate the fork. The names below are "the pre-stamp
 * line" and "the stamp line", which is what they actually are.
 *
 * FIXTURE RULES, learned the hard way. Every fixture asserts its precondition
 * before measuring, so a fixture that stops being the shape it claims fails
 * loudly instead of quietly measuring nothing. Nine such defects were found
 * across the probes behind this card, three of which produced clean-looking
 * wrong answers:
 *
 *   1. `sed > same-file` truncates its input first; the guard came out empty and
 *      the "downgrade" was really a missing file.
 *   2. A marker injected at line 1 lands between the shebang and the `/**`, closing
 *      the comment early -- an installer error readable as a verdict.
 *   3. The installed pre-commit hook rejected the fixture's own commits, so no
 *      lane commit landed and five tests failed for one unrelated reason.
 *   4. The shim embeds `installedFrom`, the installing checkout's absolute repo
 *      root, so EVERY other lane computes a shim naming itself and the installer
 *      refuses with exit 1. That refusal is a different hazard from this card's.
 *   5. A trailing-newline edit produced a byte-identical guard, so `git commit`
 *      said "nothing to commit" and the test failed on an error that reads like
 *      a product defect.
 *   6. `\z` is not a supported regex anchor here, so the edit silently did
 *      nothing. Same clean-wrong-answer shape as 5.
 *   7. `git(args, cwd)` was called as `git(main, [...])` in three places, so every
 *      `git checkout` threw "not a git repository" and the tests failed for the
 *      wrong reason.
 *   8. The suite hardcoded stamp version 2, so it broke on the next bump --
 *      failing on its own fixture, not on the product. Nothing about the hazard
 *      depends on the number. The versions are now READ, never asserted.
 *   9. The `differs` fixture reached its state by calling the installer twice,
 *      and that second fleet install was itself the operation under test -- so
 *      under the ruling it failed on its own setup precondition and read as a
 *      broken product. Every fixture below now writes the stored guard DIRECTLY
 *      rather than asking the installer to perform the state under test.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, "..", "install-worktree-isolation-hook.mjs");
const guardSource = path.join(here, "..", "check-worktree-isolation.mjs");

/**
 * Both scripts must be loadable, or every test in this file dies on ENOENT in
 * makeFleet() and the run reports failures that look like product defects. The
 * first version of this file claimed it "also runs unmodified inside a checkout"
 * on a branch whose base contained neither script. Asserted rather than assumed.
 */
for (const [label, file] of [["installer", installer], ["guard", guardSource]]) {
  assert.ok(
    existsSync(file),
    `this suite cannot run here: the ${label} (${file}) is absent. Stage both scripts as\n` +
      `  siblings of __tests__/ before running -- see the "HOW TO RUN" header.`,
  );
}

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

function commit(cwd, message) {
  // --no-verify because the fleet's own pre-commit hook is installed by these very
  // tests and would reject the fixture's own commits. Commits that are UNDER TEST
  // go through the real hook; see the cross-seat test in the project's own suite.
  //
  // The message is passed with -m as ONE argument: execFileSync does not go through
  // a shell, so a message containing spaces has to be a single argument or git reads
  // the second word as a pathspec. The first attempt at this file passed them
  // unquoted and every such commit died with "Command failed", which reads like a
  // product failure and is not one.
  return git(["commit", "-q", "--no-verify", "-m", message], cwd);
}

function makeFleet() {
  const root = mkdtempSync(path.join(tmpdir(), "kee962-"));
  const main = path.join(root, "main");
  mkdirSync(path.join(main, "scripts", "__tests__"), { recursive: true });
  git(["init", "-q", "-b", "main", main], root);
  git(["config", "user.name", "Fixture"], main);
  git(["config", "user.email", "fixture@example.invalid"], main);
  const scripts = path.join(main, "scripts");
  copyFileSync(guardSource, path.join(scripts, "check-worktree-isolation.mjs"));
  copyFileSync(installer, path.join(scripts, "install-worktree-isolation-hook.mjs"));
  writeFileSync(path.join(main, "seed.txt"), "seed\n");
  git(["add", "-A"], main);
  commit(main, "seed");
  return { root, main };
}

function runInstaller(dir, args = []) {
  return spawnSync(process.execPath, [path.join(dir, "scripts", "install-worktree-isolation-hook.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

const installHook = runInstaller;

/**
 * The version line the installer orders by, read the way the installer reads it.
 * Duplicated on purpose: borrowing the installer's own parser would let a change
 * to that parser change both sides of an assertion at once, and the tests would
 * lose the ability to fail.
 */
const STAMP = /^[ \t]*(?:\*[ \t]*)?#?[ \t]*worktree-isolation-guard-version:[ \t]*(\d+)[ \t]*$/m;

function stampOf(text) {
  const m = STAMP.exec(text);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function guardIn(dir) {
  return readFileSync(path.join(dir, "scripts", "check-worktree-isolation.mjs"), "utf8");
}

/** The fleet-wide stored guard: the copy the shim actually runs. */
function storedGuardPath(main) {
  return path.join(main, ".git", "hooks", "worktree-isolation-guard.mjs");
}
const storedGuard = (main) => readFileSync(storedGuardPath(main), "utf8");

/**
 * Append a comment to a guard, producing bytes that differ from the original and
 * from any other edit.
 *
 * The obvious `text.replace(/\n\z/, "\n" + comment + "\n")` does NOT work in this
 * engine -- `\z` is not a supported anchor, so the pattern never matches and the
 * "edited" guard comes out byte-identical. The fixture then staged nothing, `git
 * commit` reported "nothing to commit", and the test failed on an error that reads
 * like a product defect and is a bug in the test. trimEnd() plus an append is the
 * form that provably produces the edit, and the result is asserted to differ.
 */
function withTrailingComment(text, comment) {
  const edited = `${text.trimEnd()}\n/* ${comment} */\n`;
  assert.notEqual(edited, text, `fixture is wrong: the guard edit for "${comment}" changed nothing`);
  return edited;
}

/** Rewrite the stamp on a guard's text. Asserts the stamp was there to move. */
function atVersion(text, version) {
  const stamped = text.replace(STAMP, (line) => line.replace(/(\d+)\s*$/, `${version} `));
  assert.notEqual(stamped, text, `fixture is wrong: no version stamp to move to ${version}`);
  return stamped;
}

/** Remove the stamp entirely: what a hand-written or vendored guard looks like. */
function withoutStamp(text) {
  const stripped = text.replace(STAMP, " * predates versioning");
  assert.notEqual(stripped, text, "fixture is wrong: could not remove the stamp");
  return stripped;
}

/**
 * Put a guard into force WITHOUT asking the installer to do it.
 *
 * This is fixture defect 9, fixed. An earlier version reached its states by
 * calling `--install` repeatedly, and one of those calls was itself the operation
 * under test -- so under the ruling the fixture failed on its own setup
 * precondition ("the hand edit is not in force") rather than on the behaviour
 * assertion, which reads as a broken product. Writing the file directly means the
 * state under test is SET UP, not PERFORMED by the code being tested.
 *
 * The stored guard is what the shim runs, so its content is what the installer
 * compares against. Writing it here is the honest way to express "this is the
 * copy in force" without performing the act under test.
 */
function putInForce(main, text) {
  const p = storedGuardPath(main);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return text;
}

/**
 * The guard the checkout holds, at whatever version it naturally carries, with a
 * fleet guard already in force at a version the fixture chooses.
 *
 * Every version is READ, never asserted: the first version of this file hardcoded
 * 2 and broke the moment the stamp moved to 3, failing on its own fixture rather
 * than on the product (defect 8 above). What the hazard actually needs is a
 * relation, and a relation is expressed as "this one is behind that one", which
 * is true whatever the absolute numbers are.
 */
function seedInForce(main) {
  const r = installHook(main, ["--install"]);
  assert.equal(r.status, 0, "the first install must succeed: " + r.stderr);
  const base = stampOf(guardIn(main));
  const inForceVersion = base + 4;
  putInForce(main, atVersion(guardIn(main), inForceVersion));
  return { inForceVersion, base };
}

/**
 * Assert the fixture is the shape the test below claims it is.
 *
 * Standing in a lane behind the fleet, on a revision that carries a version
 * stamp, `relation` is the relation between this checkout's guard and the copy in
 * force. Returned rather than asserted, so a test can assert it itself.
 */
function assertRelation(main, expected) {
  const actual = relationOf(main);
  assert.equal(actual, expected,
    `fixture is wrong: the relation between this checkout's guard and the copy in force is ` +
    `"${actual}", not "${expected}"`);
  return actual;
}

function relationOf(main) {
  const stored = stampOf(storedGuard(main));
  const checkout = stampOf(guardIn(main));
  if (checkout === 0) return "unstamped";
  if (stored === 0) return "no-checkout-copy";
  if (checkout === stored) {
    return storedGuard(main) === guardIn(main) ? "same" : "differs";
  }
  return checkout > stored ? "newer" : "older";
}

/**
 * Whether the revision under test carries a version stamp at all.
 *
 * The pre-stamp revisions (1f14cdd6e, 0727e4dde) order two guards by git
 * ancestry instead, so they have no stamp to move and none of the fixtures below
 * can express a relation. The first version of this file hit exactly that and
 * reported it as seven product failures, every one of them
 * "fixture is wrong: no version stamp to move" -- which reads as a result and is
 * not one. The suite's own job is to say which failures are the product's.
 */
function hasStamp(main) {
  return stampOf(guardIn(main)) > 0;
}

/**
 * Skip a test that needs a version stamp when the revision under test has none.
 *
 * Skipped, not failed. A pre-stamp revision cannot express these relations at
 * all, and reporting that as a product failure is the false negative this file
 * exists to avoid -- the first version of it did exactly that, seven times over.
 */
function skipWithoutStamp(t, main) {
  if (hasStamp(main)) return false;
  t.skip("pre-stamp revision: this guard carries no version, so the relation under test cannot be expressed");
  return true;
}

/** Everything the installer told the operator, on either stream. */
function said(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

test("a lane behind the fleet cannot roll the stored guard back on a succeeding --install", (t) => {
  // The KEE-962 hazard, on the ordinary path. No --force, no refusing shim: the
  // checkout holds an OLDER guard, the fleet's newer one is in force, and the
  // install must both leave the stored copy alone and say so.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
    const held = atVersion(guardIn(main), inForceVersion - 1);
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), held);
    assertRelation(main, "older");

    const before = storedGuard(main);
    const result = installHook(main, ["--install"]);

    assert.equal(result.status, 0, "the install itself should succeed: " + result.stderr);
    assert.equal(storedGuard(main), before,
      "HAZARD: the succeeding --install replaced the fleet-wide stored guard with an older copy");
    assert.match(said(result), /NOT replaced/,
      "the operator must be told the stored guard was left alone; silent success IS the hazard");
    assert.match(said(result), /not being moved backwards/,
      "the message must say WHY it was left alone, not merely that it was");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same version, different content: the installer refuses to guess (KEE-962 open gap)", (t) => {
  // The shape found while writing this card's fixtures, on no card but this one.
  // storedGuardRelation() returns "differs" for two guards at the SAME version
  // with different bytes: somebody hand-edited one and the installer cannot tell
  // which was intended. On 6f99a78f0 the SUCCEEDING path let that fall straight
  // through to refreshStoredGuard() and printed only "guard: refreshed at ...".
  //
  // This asserts the ruling: it is now WITHHELD, and named. If that changes, this
  // is the line to re-point -- not a test to delete.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
    // The checkout's guard is at the same version, different bytes.
    writeFileSync(
      path.join(main, "scripts", "check-worktree-isolation.mjs"),
      withTrailingComment(atVersion(guardIn(main), inForceVersion), "hand edit"),
    );
    assertRelation(main, "differs");

    const before = storedGuard(main);
    const result = installHook(main, ["--install"]);

    assert.equal(result.status, 0, "the install itself should succeed: " + result.stderr);
    assert.equal(storedGuard(main), before,
      "HAZARD: a same-version, different-content guard replaced the copy in force");
    assert.match(said(result), /NOT replaced/);
    assert.match(said(result), /Refusing to guess/,
      "the operator must be told this is undecidable, not merely that something was withheld");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unstamped lane guard does not displace a stamped guard in force, and says so", (t) => {
  // The KEE-966 ruling, measured as behaviour rather than asserted as a fix. On
  // 6f99a78f0 this was a takeover, loudly, on the strength of --install:
  //
  //   6f99a78f0 UNSTAMPED lane vs stamped v2 fleet : stored 4c5ec6c1 -> b9a83f1b exit=0
  //
  // The ruling is the opposite: an unstamped guard makes no claim, and no claim
  // is not authority to move the fleet. --force remains the deliberate override.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), withoutStamp(guardIn(main)));
    assertRelation(main, "unstamped");

    const before = storedGuard(main);
    const result = installHook(main, ["--install"]);

    assert.equal(result.status, 0, "the install itself should succeed: " + result.stderr);
    assert.equal(storedGuard(main), before,
      "HAZARD: an UNSTAMPED guard replaced a stamped one in force, carrying no ordering at all");
    assert.match(said(result), /NOT replaced/);
    assert.match(said(result), /no version stamp/,
      "the operator must be told the guard is unmeasured, not that something was merely withheld");
    assert.match(said(result), /--force/,
      "a withheld guard must name the one command that resolves it, or withholding is a dead end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuinely NEWER guard still takes the fleet over", (t) => {
  // The guard the whole rule is for. A rule that only ever withholds would pass
  // every test above while being useless, so the positive case is asserted too.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
    const newer = atVersion(guardIn(main), inForceVersion + 1);
    writeFileSync(path.join(main, "scripts", "check-worktree-isolation.mjs"), newer);
    assertRelation(main, "newer");

    const before = storedGuard(main);
    const result = installHook(main, ["--install"]);

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(storedGuard(main), before,
      "a genuinely newer guard must still be allowed to take the fleet over");
    assert.equal(stampOf(storedGuard(main)), inForceVersion + 1,
      "the guard now in force must be the checkout's newer one");
    assert.doesNotMatch(said(result), /NOT replaced/,
      "a permitted write must not be reported as a withholding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--force is the deliberate override, and it says what it replaced", (t) => {
  // --force is how an operator reaches a withheld state. If it wrote quietly the
  // hazard would survive as a deliberate act, and the whole card is against
  // silence. Asserted on both the ordinary withheld relation and the unstamped
  // one, because the rule scopes them differently in the code.
  for (const [name, shape] of [
    ["older", (text, v) => atVersion(text, v - 1)],
    ["unstamped", (text) => withoutStamp(text)],
  ]) {
    const { root, main } = makeFleet();
    try {
      if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
      const guardFile = path.join(main, "scripts", "check-worktree-isolation.mjs");
      writeFileSync(guardFile, shape(guardIn(main), inForceVersion));
      assertRelation(main, name);

      const before = storedGuard(main);
      const result = installHook(main, ["--install", "--force"]);

      assert.equal(result.status, 0, result.stderr);
      assert.notEqual(storedGuard(main), before, `--force must be able to install a ${name} guard`);
      assert.match(said(result), /--force/,
        "--force must say it was a force; a quiet override is the hazard wearing a different hat");
      assert.match(said(result), new RegExp(`version ${inForceVersion}`),
        "--force must name the version that was in force, so the operator can read both");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("every write of the stored guard goes through one decision, on every path", (t) => {
  // A rule that exists in two places is a rule that will be changed in one of
  // them. KEE-966's whole point was that the succeeding path and the refusing
  // path disagreed about `differs`; the fix was one function. This asserts the
  // consequence rather than the implementation: for the relations that are
  // decidable and safe, the stored guard is untouched and the operator is told,
  // and for the one that is safe, it moves.
  //
  // Stated as a table so a partial regression -- one path reverting to an
  // inlined rule -- shows up as a named row rather than as a count.
  const writable = { older: false, differs: false, unstamped: false, newer: true };
  for (const [relation, shouldWrite] of Object.entries(writable)) {
    const { root, main } = makeFleet();
    try {
      if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
      const guardFile = path.join(main, "scripts", "check-worktree-isolation.mjs");
      const shapes = {
        older: atVersion(guardIn(main), inForceVersion - 1),
        differs: withTrailingComment(atVersion(guardIn(main), inForceVersion), "hand edit"),
        unstamped: withoutStamp(guardIn(main)),
        newer: atVersion(guardIn(main), inForceVersion + 1),
      };
      writeFileSync(guardFile, shapes[relation]);
      assertRelation(main, relation);

      const before = storedGuard(main);
      const result = installHook(main, ["--install"]);

      assert.equal(result.status, 0, `${relation}: the install should succeed: ` + result.stderr);
      const wrote = storedGuard(main) !== before;
      assert.equal(wrote, shouldWrite,
        `${relation}: expected the stored guard ${shouldWrite ? "to be replaced" : "to be left alone"}, ` +
        `and it was ${wrote ? "replaced" : "left alone"}`);
      if (!shouldWrite) {
        assert.match(said(result), /NOT replaced/,
          `${relation}: a withheld guard that is not announced is the hazard`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the version stamp itself is the ordering mechanism, and is covered", (t) => {
  // KEE-973 Finding B, confirmed here independently before acting on it: the
  // project's own installer suite cannot tell version 2 from version 3. Flipping
  // the guard's stamp line and nothing else gives, on bc1ade2,
  //
  //   stamp 3 (as shipped)  ->  31 pass  0 fail
  //   stamp 2 (flipped)     ->  31 pass  0 fail
  //
  // and this file passed 7/7 with the stamp set to 99999. So the whole ruling --
  // which is a statement about what the stamp claims -- rested on a number that
  // nothing could see change.
  //
  // What is asserted here is not a literal. It is that the stamp is what decides
  // the order: move it and the decision must move with it, in the direction the
  // moved stamp says. A test that pinned the number would be the same defect in
  // the other direction, which is why the numbers below are read, never written.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion, base } = seedInForce(main);
    const guardFile = path.join(main, "scripts", "check-worktree-isolation.mjs");

    // Ordering follows the stamp, not the bytes and not the numbers' size. Take a
    // guard that is otherwise IDENTICAL to the one in force -- same content, so
    // the only thing that can decide anything is the stamp -- and give it a
    // higher stamp. It must win, and the stored copy must then carry that stamp.
    writeFileSync(guardFile, atVersion(guardIn(main), inForceVersion + 1));
    assertRelation(main, "newer");
    const result = installHook(main, ["--install"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(stampOf(storedGuard(main)), inForceVersion + 1,
      "the guard now in force must carry the stamp that won the decision");
    assert.equal(stampOf(guardIn(main)), inForceVersion + 1,
      "fixture is wrong: the winning stamp did not land");

    // And lower, from the same content, must lose to what is in force. If the
    // stamp did not decide this, nothing in this file would catch the stamp
    // being ignored -- which is exactly what Finding B describes.
    const afterWrite = stampOf(storedGuard(main));
    writeFileSync(guardFile, atVersion(guardIn(main), afterWrite - 1));
    assertRelation(main, "older");
    const before = storedGuard(main);
    const second = installHook(main, ["--install"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(storedGuard(main), before,
      "a lower stamp must not displace a higher one, however the content compares");

    // Sanity on the fixture's own reading of the stamp, so a change to the
    // regex cannot silently make the two assertions above vacuous.
    assert.ok(base > 0, "fixture is wrong: the shipped guard carries no version at all");
    assert.equal(stampOf(guardIn(main)), afterWrite - 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the stored guard is fleet-wide: in the common dir, not in a lane", (t) => {
  // A guard on the shape. If the stored guard were per-lane, none of the tests
  // above would mean anything, so assert the location here rather than leaving
  // it to be discovered later.
  const { root, main } = makeFleet();
  try {
    if (skipWithoutStamp(t, main)) return;
    const { inForceVersion } = seedInForce(main);
    const lane = path.join(root, "lane-loc");
    git(["worktree", "add", "-q", lane, "-b", "keece/lane-loc", "HEAD"], main);
    // In a worktree, .git is a FILE holding a pointer to the common dir, not a
    // directory, so resolve the real hooks dir before asserting the lane has none.
    const laneDotGit = path.join(lane, ".git");
    const laneHooks = statSync(laneDotGit).isDirectory()
      ? path.join(laneDotGit, "hooks")
      : path.join(path.dirname(readFileSync(laneDotGit, "utf8").trim().replace(/^gitdir: /, "")), "hooks");
    assert.ok(!existsSync(path.join(laneHooks, "worktree-isolation-guard.mjs")),
      "a lane must not hold its own copy of the stored guard, or nothing here is fleet-wide");
    assert.equal(stampOf(storedGuard(main)), inForceVersion,
      "the copy in force is the one the fixture put there");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
