#!/usr/bin/env node
/**
 * install-worktree-isolation-hook.mjs
 *
 * Installs check-worktree-isolation.mjs as a pre-commit hook.
 *
 * Why this exists (KEE-929): the guard is useless unless a commit actually runs
 * it. A package.json script and a CI lane are both opt-in, so a contributor who
 * never reads the README can still `git commit --amend` inside a worktree that
 * another person owns, and the collision the guard exists to prevent happens
 * anyway.
 *
 * Git cannot commit a hook from a repository, so this installs one into
 * .git/hooks. It writes a small shim rather than copying the guard, so an
 * update to the guard takes effect on the next commit with no re-install.
 *
 * The shim does NOT simply point at this worktree's copy of the guard. The
 * guard only exists on branches that carry it, and on this host 118 of 119
 * worktree HEADs do not have it -- including paperclip-kee-923, the worktree the
 * whole card is about. A shim that resolved the guard from the committing
 * checkout would therefore fail open on exactly the worktrees that need the
 * guard most, which is the same "check that always passes" outcome as the
 * version-1 bug. So the installer also stores a copy in the common git dir, and
 * the shim prefers the checkout's copy and falls back to the stored one.
 *
 * Usage:
 *   node scripts/install-worktree-isolation-hook.mjs            # install
 *   node scripts/install-worktree-isolation-hook.mjs --check    # report only
 *   node scripts/install-worktree-isolation-hook.mjs --uninstall
 *   node scripts/install-worktree-isolation-hook.mjs --install --force
 *                                                               # replace a shim that
 *                                                               # is ours-shaped but not
 *                                                               # this revision
 *
 * The hook is deliberately not unbypassable: `git commit --no-verify` still
 * skips it. A hook that appears unbypassable teaches --no-verify as a habit,
 * which is worse than an honest opt-out.
 *
 * The one thing the shim does insist on: if a seat identity is set and no guard
 * can be found, the commit is REFUSED. A hook that can enforce nothing is
 * indistinguishable from no hook, and reporting success while enforcing nothing
 * is the failure this whole change exists to end. A human with no seat identity
 * is not governed by the seat rule and is warned rather than blocked.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, accessSync as fsAccessSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
}).trim();

const hookPath = path.join(commonDir, "hooks", "pre-commit");

// The copy the shim falls back to. It lives beside the hook, in the common git
// dir, so every linked worktree of this repository reaches the same file and it
// survives the removal of whichever worktree happened to run the installer.
const storedGuardPath = path.join(commonDir, "hooks", "worktree-isolation-guard.mjs");

// Path to the guard in this checkout, absolute and forward-slashed so the shim
// works on every platform and does not depend on the hook's own cwd.
const guardPath = path.join(repoRoot, "scripts", "check-worktree-isolation.mjs").split(path.sep).join("/");

// The same file, repo-relative, because it is the path git knows it by: the
// ordering of two revisions of it is what tells an update from a downgrade.
const GUARD_RELATIVE_PATH = "scripts/check-worktree-isolation.mjs";

// The lane this shim was installed from. Recorded so the NO GUARD FOUND
// message can name a checkout an operator can actually cd into: 56 of the 58
// worktree HEADs on this host have no scripts/install-worktree-isolation-hook.mjs
// at all, so "run scripts/install-worktree-isolation-hook.mjs" is advice the
// blocked seat cannot follow. See the shim's refusal message.
const installedFrom = repoRoot;

const MARKER = "# installed by scripts/install-worktree-isolation-hook.mjs";

/**
 * Write a file atomically, or not at all.
 *
 * writeFileSync opens the target with O_TRUNC and then writes. If it is
 * interrupted -- a full disk, a file-size limit, a kill -- the target is left
 * truncated, and for the hook that means a shim ending mid-string. git runs it,
 * the shell fails to parse it, prints "unexpected EOF", and then ALLOWS the
 * commit: an interrupted reinstall does not just skip the guard, it installs a
 * broken one that fails open.
 *
 * Reproduced with `ulimit -f 1`, which lets the truncate land and then fails
 * the write: a 2751-byte live hook became 1024 bytes ending in
 * `GUARD="${KEE_WORKTREE_ISOLATION_GUA`.
 *
 * So the content goes to a temporary file in the same directory, is chmodded
 * there, and only then renamed over the target. rename(2) within a directory is
 * atomic, so a reader sees either the old file or the new one, never a partial.
 */
function writeFileAtomic(target, content, mode) {
  const staging = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, content, { mode });
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

// The shim's first line and its last two lines. Both are identical in every
// revision of this script, so they are what identifies a hook as ours: the
// header says who wrote it, the terminator says where our block ends and
// anything after it belongs to somebody else.
//
// The terminator deliberately has no trailing newline. Everything here is
// compared against trimmed content, because the file on disk is written from
// `shim` and a raw byte comparison would never match its own output.
const HEADER = "#!/bin/sh\n# One seat owns one worktree.";
const TERMINATOR = 'node "$GUARD" "$@"\nexit $?';
const shim = `#!/bin/sh
# One seat owns one worktree. See scripts/check-worktree-isolation.mjs.
# Runs on every commit in every linked worktree of this repository.
#
${MARKER}
#
# Resolution order, in order of freshness:
#   1. KEE_WORKTREE_ISOLATION_GUARD, for an explicit override
#   2. the stored copy, which the installer keeps in step with the checkout it
#      was installed from
#   3. the copy in the checkout being committed to
#
# The stored copy is preferred over the checkout's on purpose. The other order
# lets a worktree whose guard is an older revision decide the commit on its
# own, so a fixed or tightened guard is not in force in that worktree, which is
# the original failure of this card one level up. The installer refreshes the
# stored copy on every run, so it is the one that is current.
#
# A checkout with no guard at all still works: 118 of 119 worktree HEADs here
# do not carry the guard, and step 2 is what covers them.
GUARD="\${KEE_WORKTREE_ISOLATION_GUARD:-}"
if [ -z "$GUARD" ]; then
  if [ -f "${storedGuardPath}" ]; then
    GUARD="${storedGuardPath}"
  else
    TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""
    if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/scripts/check-worktree-isolation.mjs" ]; then
      GUARD="$TOPLEVEL/scripts/check-worktree-isolation.mjs"
    fi
  fi
fi

if [ -z "$GUARD" ]; then
  # No guard to run. This is not allowed to be silent: a hook that exits 0
  # having decided nothing is exactly the defect this card is about.
  #
  # Whether it exits 0 or not used to be a judgement call, and it was the wrong
  # one. I chose exit 0 -- refusing every commit in a checkout that has never
  # had the guard would look like a broken tool and be worked around with
  # --no-verify within a day -- and put the decision to the KEE-943 review to be
  # made by someone other than me. Two independent sources have now landed on the
  # other side: the security review flagged the same thing as a P2, and the
  # rationale is the stronger argument. A hook that cannot enforce anything is
  # indistinguishable from no hook, and "it would be annoying" is a smaller
  # concern than a guard that reports success while enforcing nothing -- which
  # is the failure this whole card exists to end. The honest repair for an
  # absent guard is to install it, and the message says exactly that.
  #
  # So: fail CLOSED when there is a seat identity, because that is the case the
  # control exists for, and a seat with no guard is a seat that is unprotected.
  # A human with no seat identity is not a seat and is not governed by the seat
  # rule, so it keeps the loud warning and is not blocked. This is also the
  # only branch where the shim itself has to decide, because the guard -- which
  # is what would normally do the deciding -- is the thing that is missing.
  if [ -n "\${PAPERCLIP_AGENT_ID:-}" ]; then
    echo "check-worktree-isolation: NO GUARD FOUND, refusing the commit." >&2
    echo "  A seat identity is set (\${PAPERCLIP_AGENT_ID%%-*}), so this commit must be checked," >&2
    echo "  and there is no guard to check it with. Refusing rather than allowing it unchecked." >&2
    echo "  expected at: ${storedGuardPath}" >&2
    echo "" >&2
    echo "  This checkout has no installer, so the fix cannot be run from here. An operator has to" >&2
    echo "  install the guard into this repository's shared hooks directory, from a checkout that" >&2
    echo "  carries it:" >&2
    echo "" >&2
    echo "    cd ${installedFrom}" >&2
    echo "    node scripts/install-worktree-isolation-hook.mjs" >&2
    echo "" >&2
    echo "  That writes the shared guard once and every worktree of this repository is covered," >&2
    echo "  including this one. If ${installedFrom} is gone, install from whichever lane currently" >&2
    echo "  has scripts/install-worktree-isolation-hook.mjs." >&2
    exit 2
  fi
  echo "check-worktree-isolation: NO GUARD FOUND, seat isolation is NOT being enforced." >&2
  echo "  cwd:         $(pwd)" >&2
  echo "  expected at: ${storedGuardPath}" >&2
  echo "  No seat identity is set, so this is not a seat commit and is allowed. Every seat" >&2
  echo "  commit in this repository will be refused until the guard is installed." >&2
  echo "  From a checkout that carries the installer:" >&2
  echo "    cd ${installedFrom} && node scripts/install-worktree-isolation-hook.mjs" >&2
  exit 0
fi

node "$GUARD" "\$@"
exit \$?
`;

const mode = process.argv[2] || "--install";
const force = process.argv.includes("--force");
const current = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;
const installed = current !== null && current.includes(MARKER);

// Where git will actually look for hooks. If core.hooksPath is set, the
// common .git/hooks directory is not consulted at all, so writing a hook there
// looks like success and enforces nothing. That is a false "installed", and it
// was found in review: with core.hooksPath pointing elsewhere, a cross-seat
// commit landed while the installer reported the hook installed.
let hooksPath = null;
try {
  hooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim() || null;
} catch {
  hooksPath = null;
}
if (hooksPath) {
  const expected = path.join(commonDir, "hooks");
  // A RELATIVE core.hooksPath is resolved by git against the directory of the
  // repository the commit is happening in, not against the installing checkout.
  // A linked worktree's .git is a file rather than a directory, so a relative
  // path that is correct from the primary checkout resolves somewhere else --
  // usually nowhere -- from a linked worktree. Accepting it here reported
  // success while the guard ran in no worktree at all.
  //
  // So the value is resolved the way git will resolve it, in the worst case
  // there is, and refused if it is not the common hooks dir from there too.
  if (!path.isAbsolute(hooksPath)) {
    process.stderr.write(
      `install-worktree-isolation-hook: core.hooksPath is set to the relative path\n` +
        `${hooksPath}. Git resolves a relative core.hooksPath against each committing\n` +
        `repository, and in a linked worktree .git is a file, not a directory, so the\n` +
        `path does not resolve to the same place. Git would not run a hook written to\n` +
        `the common .git/hooks, so installing there would report success and enforce\n` +
        `nothing in the very worktrees the guard exists for.\n` +
        `Unset core.hooksPath, or set it to the absolute path ${expected}, and run this again.\n`,
    );
    process.exit(1);
  }
  const resolved = path.resolve(hooksPath);
  if (path.resolve(resolved) !== expected) {
    process.stderr.write(
      `install-worktree-isolation-hook: core.hooksPath is set to ${hooksPath}, which is not\n` +
        `the repository's hooks directory (${expected}). Git will not run a hook written to\n` +
        `the common .git/hooks, so installing there would report success and enforce nothing.\n` +
        `Point core.hooksPath at ${expected}, or unset it, and run this again.\n`,
    );
    process.exit(1);
  }
}

// git runs a hook only if it is executable. A hook that lost its bit is
// reported installed by a marker check alone, and is silently inert.
function hookIsRunnable(file) {
  if (!existsSync(file)) return false;
  try {
    fsAccessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

/**
 * The part of an on-disk hook that is ours, normalised the same way `shim` is
 * compared.
 *
 * One definition, used by --check, --uninstall and --install, because those
 * three have to agree about what "our block" is. They did not before: --check
 * tested marker provenance and the other two sliced at the terminator, which
 * is how --check could say "installed" about a file the installer would refuse
 * to touch. Splitting on the terminator rather than on a line count matters
 * for the same reason it matters in the install path: an older revision may be
 * longer or shorter than the new one.
 */
function shimBlock(onDisk) {
  const trimmed = onDisk.trimEnd();
  const at = trimmed.indexOf(TERMINATOR);
  return at === -1 ? trimmed : trimmed.slice(0, at + TERMINATOR.length).trim();
}

/**
 * Copy this checkout's guard over the stored one, through a staging file.
 *
 * One definition for both the install and the re-install path, because the two
 * were doing the same two lines by hand and the refusal path needs the same
 * guarantee: a copy that is interrupted must not leave a truncated guard that
 * node fails to parse, which is a guard that errors rather than one that runs.
 */
function refreshStoredGuard() {
  const staging = `${storedGuardPath}.tmp-${process.pid}`;
  try {
    copyFileSync(guardPath, staging);
    renameSync(staging, storedGuardPath);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * blob id -> the commits carrying it, newest first, for the guard's path.
 *
 * A list per content rather than one commit, and that is the correction this
 * function exists for. The same content is commonly carried by several commits
 * -- a guard that is added, edited and then reverted -- and which carrier is
 * "the" one depends on the question being asked:
 *
 *   - "is this lane ahead of the stored guard" is answered by the NEWEST
 *     carrier, because that is the commit this lane is standing on;
 *   - "has this lane's content ever been in force before the stored one" is
 *     answered by ANY carrier, and only an any-carrier answer gets a revert
 *     right.
 *
 * Taking the newest carrier for both questions is what shipped in 1f14cdd6e and
 * it is wrong for a revert. History `c1 OLD -> c2 NEW -> c3 REVERT-to-OLD`, the
 * fleet parked on NEW, the operator's lane on c3: the newest carrier of OLD is
 * the REVERT, which is a DESCENDANT of c2, so "is this lane's carrier an
 * ancestor of the stored one" answered false, the code read that as "this lane
 * is ahead", and it published the OLD bytes over the NEW ones. Measured on
 * KEE-960: stored 9a015171 -> 0ed9476f, exit 1, one refusal line, message
 * claiming a refresh. The suite was 25/25 green on it, because a linear fixture
 * cannot produce that ordering.
 *
 * `--all` is required, for the same reason as before: without it git lists only
 * the commits reachable from THIS lane, and the lane that needs the comparison
 * most is the one behind the fleet, which cannot see the newer guard's commit
 * at all. Measured: from a behind lane, `git log -- <guard>` returned 2
 * revisions and `git log --all -- <guard>` returned 3.
 *
 * Content is matched by git's own blob id rather than by re-hashing bytes, so
 * the STORED copy (which lives in the common git dir, not in the checkout) and a
 * checkout copy carrying an uncommitted edit are compared on the same terms.
 *
 * Ordering is taken from the guard's own path-scoped history, not from a version
 * number inside it, because the guard has no version marker and adding one would
 * have to be carried into every revision that predates it.
 *
 * Returns null when the history could not be read at all, which is different
 * from an empty map: null means git refused, an empty map means the guard has
 * never been committed. Callers must not read one as the other.
 */
function guardCarrierIndex() {
  let listed;
  try {
    listed = execFileSync("git", ["log", "--all", "--format=%H", "--", GUARD_RELATIVE_PATH], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  const index = new Map();
  for (const revision of listed) {
    let blob;
    try {
      blob = execFileSync("git", ["rev-parse", `${revision}:${GUARD_RELATIVE_PATH}`], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      continue;
    }
    const carriers = index.get(blob);
    if (carriers) carriers.push(revision);
    else index.set(blob, [revision]);
  }
  return index;
}

/**
 * true / false, or null when git could not answer.
 *
 * Ancestry rather than commit timestamps, deliberately. Timestamps are second
 * resolution, so two guard revisions committed in the same second are
 * indistinguishable -- and the test fixture commits in the same second is not a
 * contrived edge, it is what any fast local sequence produces. Measured: with
 * timestamp ordering, an older and a newer guard committed in the same second
 * compared equal, so the downgrade went ahead. Ancestry has no such tie: a commit
 * is either reachable from another or it is not.
 */
function isAncestor(maybeAncestor, descendant) {
  if (!maybeAncestor || !descendant) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", maybeAncestor, descendant], { cwd: repoRoot });
    return true;
  } catch (error) {
    // Exit 1 is git's "not an ancestor". Anything else is a real failure and
    // must not be read as "not an ancestor".
    return error && error.status === 1 ? false : null;
  }
}

/**
 * git's own id for some bytes, which is what a revision's `rev-parse <rev>:<path>`
 * returns. `git hash-object --stdin` so it works for content that is not on disk
 * at the guard's path -- the STORED copy lives in the common git dir, not in the
 * checkout -- and for the checkout's copy when it carries an uncommitted edit.
 */
function gitBlobId(content) {
  try {
    return execFileSync("git", ["hash-object", "--stdin"], {
      cwd: repoRoot,
      input: content,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Copy this checkout's guard over the stored one, but only when that is not a
 * regression, and say which of the two it did.
 *
 * Returns "unchanged", "refreshed", "older" or "unknown".
 *
 * The refusing --install path calls this. It used to call refreshStoredGuard()
 * unconditionally, on the argument that the guard is not the ambiguous object --
 * only the shim is. That argument holds for the shim and misses for the guard,
 * because the guard is copied FROM this lane's checkout: a lane behind the fleet
 * has an older guard, so the copy pushes the older one to every worktree of the
 * repository. Measured on KEE-958, from a lane whose guard is 0ed9476f against a
 * stored 9a015171: exit 1, one "Refusing to guess" line, and stored(fleet)
 * silently downgraded to 0ed9476f. 9a015171 is the revision that fails CLOSED
 * when git rev-parse fails unexpectedly, so the run removed a fail-closed branch
 * fleet-wide while reporting that it had refreshed the guard.
 *
 * Ordering is taken from the guard's own path-scoped history, not from a version
 * number inside it, because the guard has no version marker and adding one would
 * have to be carried into every revision that predates it.
 *
 * "unknown" means at least one side is not a revision this repository knows --
 * a guard with an uncommitted edit in it, or one from a lane that is gone. That
 * cannot prove a regression, so the refresh proceeds: this is the same decision
 * the pre-existing test for the refusal path pins, where a `git pull` that
 * arrived with a local edit is exactly what the operator is trying to publish.
 * The limit is stated rather than hidden: an uncommitted guard in a lane BEHIND
 * the stored one is still not detected as a downgrade.
 */
function refreshStoredGuardUnlessOlder() {
  if (!existsSync(storedGuardPath)) {
    refreshStoredGuard();
    return "refreshed";
  }
  let stored;
  let mine;
  try {
    stored = readFileSync(storedGuardPath, "utf8");
    mine = readFileSync(guardPath, "utf8");
  } catch {
    refreshStoredGuard();
    return "refreshed";
  }
  if (stored === mine) return "unchanged";
  const index = guardCarrierIndex();
  if (index === null) {
    refreshStoredGuard();
    return "unknown";
  }
  const storedCarriers = index.get(gitBlobId(stored)) ?? [];
  const myCarriers = index.get(gitBlobId(mine)) ?? [];
  if (storedCarriers.length === 0 || myCarriers.length === 0) {
    refreshStoredGuard();
    return "unknown";
  }
  // Two questions, two different answers, and conflating them is what shipped in
  // 1f14cdd6e and had to be corrected after review.
  //
  // (1) Has this lane's content EVER been in force at or before the stored
  //     guard's newest carrier? Any carrier answers this, and the oldest of
  //     this lane's carriers is the one that matters: in
  //     `c1 OLD -> c2 NEW -> c3 REVERT-to-OLD` with the fleet parked on c2,
  //     c1 is an ancestor of c2, so OLD is recognised as superseded and left
  //     alone -- even though the newest carrier of OLD is c3, which is not.
  //     Asking only about the newest carrier is the bug the review found: it
  //     read c3 as "this lane is ahead" and published the old bytes.
  //
  // (2) Failing that, is this lane actually ahead of the stored guard? The
  //     newest carrier answers it, because that is the commit this lane stands
  //     on. A lane ahead of the stored guard fixes the fleet, which is the
  //     KEE-955 benefit and the reason this refresh exists at all.
  //
  // (1) is checked first and it wins. A revert is the one case where the newest
  // carrier says "ahead" and the answer is still "do not publish", and (1) is
  // the only rule that catches it.
  const storedNewest = storedCarriers[0];
  const mineNewest = myCarriers[0];
  const superseded = myCarriers.some((carrier) => isAncestor(carrier, storedNewest) === true);
  if (superseded) return "older";
  const laneIsBehind = isAncestor(mineNewest, storedNewest);
  if (laneIsBehind === true) return "older";
  // Unrelated histories (a guard from a lane that was rebased away, say) cannot
  // be ordered. That is not evidence of a regression, so the refresh proceeds,
  // and the "unknown" return says so rather than reporting a decision it did
  // not make. null from isAncestor is git failing to answer at all, which is
  // reported the same way: the copy goes ahead, and the return value says the
  // ordering was not established.
  refreshStoredGuard();
  return laneIsBehind === false ? "refreshed" : "unknown";
}

/**
 * Copy the hook that is about to be replaced to a timestamped sibling, so
 * replacing it is reversible.
 *
 * --force overwrites a hook this script did not write in a state it cannot
 * verify, and it used to do that with no record of the previous content. The
 * operator is told "anything hand-edited into that file is being discarded",
 * which is accurate and useless: the edit is gone, it was never shown, and
 * there is no way to get it back. Measured: an operator's check inserted
 * inside our block, one --force run, zero copies of it left anywhere.
 *
 * The backup is a plain file next to the hook, in the same directory, named for
 * the revision that PRODUCED IT -- so the revision it came from, and the time it
 * was replaced. This host already carries one from a hand repair --
 * pre-commit.pre-1023ffe31.20260926T064339Z.bak
 * -- so the convention is the one an operator here will already recognise.
 *
 * It is a copy, not a rename: the rename onto the live hook is the atomic step
 * that makes the replacement safe, and a failed copy must not take the working
 * hook with it. A missing hook means there is nothing to preserve, so there is
 * nothing to back up.
 */
function backupHook() {
  if (!existsSync(hookPath)) return null;
  let stamp;
  let rev;
  try {
    stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  } catch {
    stamp = "unknown-time";
  }
  try {
    rev = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    rev = "unknown-rev";
  }
  const target = `${hookPath}.pre-${rev}.${stamp}.bak`;
  try {
    copyFileSync(hookPath, target);
    return target;
  } catch (error) {
    // A backup that cannot be written is not a reason to refuse an install the
    // operator asked for, but it is a reason to say so loudly: the replacement
    // is about to become irreversible, and silence about that is the defect
    // this function exists to remove.
    process.stderr.write(
      `install-worktree-isolation-hook: WARNING: could not back up ${hookPath} to ${target}\n` +
        `  (${error.message})\n` +
        `  The replacement below is still going ahead, and will not be reversible.\n`,
    );
    return null;
  }
}

if (mode === "--check") {
  const problems = [];
  if (!installed) {
    process.stdout.write(`worktree isolation hook: NOT installed (${hookPath})\n`);
    process.exit(1);
  }
  if (!existsSync(storedGuardPath)) {
    problems.push(`no stored guard at ${storedGuardPath}; commits fall back to the checkout's copy`);
  }
  if (!hookIsRunnable(hookPath)) {
    problems.push(`${hookPath} is not executable, so git will skip it`);
  }

  // Is the shim the revision this script would write? --check is the supported
  // health command, and the whole point of it is to say what will actually run.
  //
  // It used to answer "is a file carrying our marker here", which is provenance:
  // it is true of the copy a previous revision wrote, and of a hand-edited one.
  // The re-install refusal guarantees the condition -- it refuses precisely
  // when the body is not this revision's -- so a host can be permanently
  // stranded on a shim this guard has fixed, and --check said "installed" and
  // exited 0 about it. Measured before this fix: --check exit 0 against a shim
  // from before the stored-guard fallback existed, while --install on the same
  // host exited 1. The health command and the installer disagreed about the
  // same file, and only the installer was right.
  //
  // So --check runs the same comparison the installer runs (shimBody below) and
  // reports it. Compared on the block up to the terminator, so a check somebody
  // appended after our block is not reported as a revision problem: that is a
  // foreign addition this script is supposed to keep, and the installer keeps
  // it too.
  const block = shimBlock(current);
  if (block !== shim.trimEnd()) {
    problems.push(
      `${hookPath} is not the revision this script would write, so a fixed shim would not reach\n` +
        `  this host and --install will refuse to guess. Read the file, then either remove it\n` +
        `  (rm ${hookPath}) if it is unmodified and simply old, or install over it deliberately:\n` +
        `  node scripts/install-worktree-isolation-hook.mjs --install --force`,
    );
  }

  // Which guard is actually in force, and is it the one this checkout has? The
  // shim prefers the STORED copy, because the checkout's copy only exists in
  // the lanes that carry it. But the two have different freshness: the
  // checkout's is refreshed by git pull on every merge, the stored one only
  // when an operator re-runs the installer. So the preference is systematically
  // for the staler of the two, silently.
  //
  // Measured before this fix: appending a revision to the checkout's guard
  // without re-running the installer left stored sha1 9a015171 against checkout
  // f742cfbb, and --check exited 0 without mentioning either. Nothing in the
  // command's output distinguished a fleet running the guard in force from one
  // running a different guard than its own checkout says it should.
  //
  // This is a warning, not a refusal to run: the shim's resolution order is
  // deliberate, and an operator may be running a newer guard from a lane than
  // the one they happen to be standing in. So it names both, says which one
  // wins, and names the command that makes them agree. The stored copy is
  // refreshed on the re-install path, including the refusing path, so that
  // command does what it says.
  if (existsSync(storedGuardPath) && existsSync(guardPath)) {
    const stored = readFileSync(storedGuardPath, "utf8");
    const checkoutCopy = readFileSync(guardPath, "utf8");
    if (stored !== checkoutCopy) {
      problems.push(
        `the stored guard ${storedGuardPath} is not the same content as this checkout's\n` +
          `  ${guardPath}, and the shim runs the STORED one on every commit. The stored copy is\n` +
          `  only refreshed when the installer is re-run, so it is the staler of the two by\n` +
          `  default. stored sha1 ${sha1(stored)} vs checkout sha1 ${sha1(checkoutCopy)}.\n` +
          `  Re-run node scripts/install-worktree-isolation-hook.mjs from whichever lane's guard\n` +
          `  you want in force, or point KEE_WORKTREE_ISOLATION_GUARD at a specific file.`,
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`install-worktree-isolation-hook: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`worktree isolation hook: installed at ${hookPath} (guard ${storedGuardPath})\n`);
  process.exit(0);
}

if (mode === "--uninstall") {
  if (!installed) {
    process.stdout.write("worktree isolation hook: nothing to remove\n");
    process.exit(0);
  }
  // Only remove what this script wrote. If somebody appended another check to
  // the same file, deleting it would silently drop their check from every
  // worktree in this repository. Remove this script's block, identified by the
  // header it starts with and the terminator it ends with, and leave the rest.
  const ours = shim.trimEnd();
  const onDisk = current.trimEnd();
  if (onDisk.startsWith(HEADER) && onDisk.includes(TERMINATOR)) {
    const remainder = onDisk.slice(onDisk.indexOf(TERMINATOR) + TERMINATOR.length).trim();
    if (remainder.length === 0) {
      rmSync(hookPath);
    } else {
      process.stderr.write(
        `install-worktree-isolation-hook: ${hookPath} also contains content this script did not\n` +
          `write. Removing only the worktree isolation block and leaving the rest in place.\n`,
      );
      writeFileAtomic(hookPath, `${remainder}\n`, 0o755);
    }
  } else {
    process.stderr.write(
      `install-worktree-isolation-hook: ${hookPath} carries the marker but is not the block this\n` +
        `script writes. Refusing to remove it, so an edited hook is not deleted.\n`,
    );
    process.exit(1);
  }
  rmSync(storedGuardPath, { force: true });
  process.stdout.write(`worktree isolation hook: removed from ${hookPath}\n`);
  process.exit(0);
}

if (mode !== "--install") {
  process.stderr.write("Usage: install-worktree-isolation-hook.mjs [--install|--check|--uninstall]\n");
  process.exit(2);
}

// Do not clobber a hook somebody else wrote. A pre-commit hook that already
// exists and is not ours may be doing something important, and overwriting it
// would be a worse failure than a missing guard.
if (current !== null && !installed) {
  process.stderr.write(
    `install-worktree-isolation-hook: ${hookPath} already exists and was not installed by this script.\n` +
      `Refusing to overwrite it. Merge the two hooks by hand, or move it aside first.\n`,
  );
  process.exit(1);
}

if (!existsSync(guardPath)) {
  process.stderr.write(
    `install-worktree-isolation-hook: no guard at ${guardPath}.\n` +
      `Nothing to store. Run this from a checkout that has scripts/check-worktree-isolation.mjs.\n`,
  );
  process.exit(1);
}

if (installed) {
  // Re-install rather than skip. Both halves are refreshed: the stored guard,
  // and the shim itself. Refreshing only the guard meant that after the shim
  // was fixed, every host that had an older shim installed kept running it --
  // the fixed installer never reached the live hook. That is the same
  // "the code that runs is not the code I fixed" defect as the guard itself.
  //
  // Normalise trailing whitespace: the file on disk was written from `shim`,
  // which ends in a newline, so comparing raw would never match its own output
  // and an up-to-date hook would be rewritten on every run.
  const ours = shim.trimEnd();
  const onDisk = current.trimEnd();
  if (onDisk === ours) {
    process.stdout.write(
      `worktree isolation hook: already installed at ${hookPath} and already current\n`,
    );
  } else if (onDisk.startsWith(HEADER)) {
    // Ours, but an older revision of ours. Replace it wholesale. The boundary
    // is the shim's own last two lines, which are the same in every revision
    // and are the only thing this script emits. Anything after them is somebody
    // else's and is kept. Splitting on that terminator rather than on a line
    // count matters: the old revision may be longer or shorter than the new
    // one, and a count taken from the new shim would slice into a foreign check
    // or keep a tail of the stale shim.
    const at = onDisk.indexOf(TERMINATOR);
    const remainder = (at === -1 ? onDisk : onDisk.slice(at + TERMINATOR.length)).trim();

    // "Ours, but not the revision we would write" is also what an operator's
    // hand-edit looks like. They add a check to the shim and leave the header
    // and terminator in place, so the boundary test above cannot tell the two
    // apart: an edit AFTER the terminator looks like ours-with-a-remainder, and
    // an edit INSIDE our block looks like a plain stale shim. Replacing the
    // body then discards their work silently, in a branch whose stated intent
    // is to leave an edited hook alone -- and reinstall printed "outdated shim
    // replaced" and exited 0 while it did it. Both shapes were reproduced.
    //
    // The two cases pull in opposite directions and neither is safe to
    // automate:
    //
    //   - Replacing is right when the file is an unmodified older revision. It
    //     is what makes a fixed shim actually reach a host, which is the whole
    //     point of re-installing, and the earlier revision of this branch did
    //     exactly that with no complaints.
    //   - Refusing is right when the file is somebody's edited copy. The edit
    //     is unrecoverable, and the previous behaviour destroyed it silently.
    //
    // They are the same observation, so the installer cannot tell them apart,
    // and guessing either way produces a false success: guessing "replace"
    // destroys a local check, guessing "refuse" strands a fleet on a known-bad
    // shim and calls it current.
    //
    // The resolution is a VERSION the shim carries, so a stale file can be
    // recognised as stale without trusting its body. Anything that identifies
    // as an older revision of this script AND whose body still matches what
    // that revision wrote can be replaced automatically, because nothing was
    // edited. Without a version marker that is unknowable, so the safe
    // default stands: refuse, name both states, and say the one command that
    // resolves it. `--force` is the deliberate override for an operator who
    // has looked at the file and wants the new shim.
    const body = shimBlock(onDisk);
    if (body !== ours) {
      if (force) {
        // Back the outgoing hook up FIRST. The replacement is the one
        // irreversible step in this script, and it is the step where the file's
        // previous contents are least likely to be understood by the operator
        // running it. --force is the override for a file this script cannot
        // read the state of, so the state is preserved before it is overwritten.
        const kept = backupHook();
        if (kept) {
          process.stderr.write(
            `install-worktree-isolation-hook: --force: replacing ${hookPath} even though it is not the\n` +
              `revision this script would write. The outgoing hook has been kept at:\n` +
              `  ${kept}\n` +
              `Anything hand-edited into that file is being discarded, and it is in that copy.\n`,
          );
        } else {
          process.stderr.write(
            `install-worktree-isolation-hook: --force: replacing ${hookPath} even though it is not the\n` +
              `revision this script would write. Anything hand-edited into that file is being\n` +
              `discarded.\n`,
          );
        }
      } else {
        // The shim is ambiguous and is being left alone, but the GUARD is not:
        // the stored copy is this script's own file, it is never hand-edited,
        // and every commit in the fleet runs it. So bring it in step before
        // refusing.
        //
        // A deliberate change, because the alternative was to leave it alone and
        // the review is right that the refusal should not compound the problem.
        // Measured before this fix: a host that refuses to install its shim
        // keeps a stale guard AND a stale shim, so the one command --check
        // offers to diagnose it now names both. Refusing to write the guard
        // would mean the operator has to re-run the installer a second time,
        // after resolving the shim, to fix a problem that was never the
        // ambiguous object.
        //
        // It is safe precisely because the two are not the same object: the
        // guard is copied from a known path with no decision to make about it,
        // and the shim is left exactly as it was found.
        //
        // EXCEPT that the known path is this lane's checkout, and a lane can be
        // behind the fleet -- 118 of 119 worktree HEADs on this host are. So
        // "in step" has to mean "in step or newer", and not "whatever this lane
        // happens to carry". Measured (KEE-958): lane guard 0ed9476f against a
        // stored 9a015171, and the unconditional copy downgraded the stored
        // guard fleet-wide on a run that also exited 1 saying it had refreshed
        // it. 9a015171 is the revision that fails closed when git rev-parse
        // fails unexpectedly, so that removed a fail-closed branch from every
        // worktree while reporting an improvement. The exit code did not change,
        // so nothing downstream could tell.
        const guardOutcome = refreshStoredGuardUnlessOlder();
        process.stderr.write(
          `install-worktree-isolation-hook: ${hookPath} carries this script's marker and looks like\n` +
            `one of ours, but it is not the revision this script would write, and it cannot be told\n` +
            `apart from a hand-edited hook. An older revision of ours and somebody's edited copy\n` +
            `look identical to this script, and the difference matters: replacing the body of an\n` +
            `edited hook silently discards their check, and leaving an old one in place means a\n` +
            `fixed shim never reaches this host.\n` +
            `Refusing to guess. Read the file. If it is unmodified and simply old, remove it and run\n` +
            `this again:\n` +
            `  rm ${hookPath}\n` +
            `If you have looked at it and want the new shim regardless:\n` +
            `  node scripts/install-worktree-isolation-hook.mjs --install --force\n`,
        );
        if (guardOutcome === "older") {
          // Said explicitly, because the operator is standing in a lane that
          // does not carry the current guard and the stored one is the newer of
          // the two. Leaving it silent is how this reached a host at all.
          process.stderr.write(
            `The stored guard at ${storedGuardPath} has been left as it is: the guard in this\n` +
              `checkout (${guardPath}) is an older revision than the one already stored, and the\n` +
              `stored copy is the one every commit in this repository runs. Copying this lane's\n` +
              `over it would roll the whole fleet back to a guard that has since been fixed.\n` +
              `To put this lane's guard in force instead, run the installer from the lane that\n` +
              `carries the current one.\n` +
              `Only the shim above is unresolved.\n`,
          );
        } else {
          // "unchanged" is folded in here deliberately: saying it was refreshed
          // when the content is byte-identical would be a claim about an action
          // that was not taken, which is the defect class this script exists to
          // remove.
          process.stderr.write(
            `The stored guard has been refreshed, so commits in this repository are running the\n` +
              `guard from this checkout. Only the shim above is unresolved.\n`,
          );
        }
        process.exit(1);
      }
    }

    // Atomic: a truncated shim fails open, so the live hook is replaced by a
    // rename, never truncated in place. See writeFileAtomic.
    writeFileAtomic(hookPath, remainder.length > 0 ? `${ours}\n${remainder}\n` : `${ours}\n`, 0o755);
    process.stdout.write(`worktree isolation hook: outdated shim replaced at ${hookPath}\n`);
  } else {
    process.stderr.write(
      `install-worktree-isolation-hook: ${hookPath} carries the marker but is not a revision of this\n` +
        `script's shim, so it was left alone. It may be an older hook with a manual edit in it.\n` +
        `Review it, then replace it deliberately.\n`,
    );
    process.exit(1);
  }
  refreshStoredGuard();
  process.stdout.write(`worktree isolation guard: refreshed at ${storedGuardPath}\n`);
  process.exit(0);
}

mkdirSync(path.dirname(hookPath), { recursive: true });

// The stored guard is written FIRST, and through a temporary file so a failed
// copy cannot leave a truncated guard that node would fail to parse. Writing
// the hook first meant an interrupted install could leave a live hook with no
// guard, which then warns on every commit and allows all of them -- a partial
// install that looks like a working one.
refreshStoredGuard();
writeFileAtomic(hookPath, shim, 0o755);
process.stdout.write(
  `worktree isolation hook: installed at ${hookPath}\n` +
    `worktree isolation guard: stored at ${storedGuardPath}\n`,
);
