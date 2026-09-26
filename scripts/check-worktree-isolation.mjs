#!/usr/bin/env node
/**
 * check-worktree-isolation.mjs
 *
 * worktree-isolation-guard-version: 2
 *
 * The version line above is read by scripts/install-worktree-isolation-hook.mjs
 * to decide whether this guard is newer than the one already stored in a
 * repository's shared hooks directory. It has to be a line comment and it has
 * to parse as one, so it lives inside this block rather than on line 2: a bare
 * `#` line between the shebang and the block is a syntax error under node's
 * module rules, which would make the guard unrunnable -- the opposite of
 * stamping it for orderability.
 *
 * Raise it by one when this file's behaviour changes. It is a monotonic
 * integer, not a date and not a hash, because the only question asked of it is
 * "which of these two is newer", and a number answers that without a rule for
 * comparing the rest.
 *
 * Fails when the current working tree is an issue worktree that does not
 * belong to the seat running the check.
 *
 * Why (KEE-929): two seats shared /home/love4vengeance/Work/keece-issue-worktrees/
 * paperclip-kee-923. A DevOps Automator session committed 3d8d0b1e5 at 17:13:55.
 * Four minutes later another seat ran `git commit --amend` in the same worktree
 * to correct a commit message. The amend absorbed the other seat's commit and
 * inherited its authorship, so the branch head became a single commit attributed
 * to the DevOps Automator that contained all of the second seat's code, and the
 * doc commit lost its own message and Co-Authored-By trailers.
 *
 * The amend was not wrong on git's terms. It was wrong because the worktree
 * held two seats' unstaged history at once, which is a state no single seat
 * should ever be in.
 *
 * Seat-isolated worktrees are minted by ~/.local/bin/keece-workspace, which
 * names the path `<kind>-<issue>-<seat>` where seat is the first group of the
 * agent's UUID. This check is the additive half: it catches a seat that cds
 * into a path it did not mint, including a pre-isolation path that predates
 * this rule.
 *
 * A clean primary checkout is not a violation. Working outside the issue
 * worktree root entirely is not a violation either: a reviewer running
 * `node --test` in a reference checkout is doing nothing dangerous.
 *
 * Exit codes: 0 clean, 1 violation, 2 the check could not decide.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Overridable only so the guard's own tests can exercise it without creating
// real seat-named worktrees. It is not a bypass in any meaningful sense: a seat
// that wanted to defeat this check could simply not run it, and CI checks the
// repo out outside this root, where the check skips regardless.
//
// realpathSync on both sides is required, not cosmetic. git reports
// --show-toplevel already resolved, so comparing it against an unresolved
// literal root yields a bogus "../../../.." path.relative result and the guard
// silently exits 0 on every path. That bug shipped in the first version of
// this script and was caught only by testing the hook against a real worktree.
//
// A root that does not exist is a misconfiguration, not a violation. It must
// not throw: this script runs as a pre-commit hook, so an uncaught error here
// turns "I could not find the worktree root" into "your commit is blocked",
// on a machine that has no such layout at all. Fail open with a message, the
// same way every other non-hazard case in this file exits 0.
const configuredRoot = process.env.KEE_WORKTREE_ROOT || "/home/love4vengeance/Work/keece-issue-worktrees";
let WORKTREE_ROOT = null;
try {
  WORKTREE_ROOT = realpathSync(configuredRoot);
} catch {
  WORKTREE_ROOT = null;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  process.stderr.write(`check-worktree-isolation: ${message}\n`);
  process.exit(1);
}

// Seat identity comes from Paperclip's agent UUID. AI_AGENT is deliberately
// NOT used as a fallback: it is the harness name ("hermes-agent"), identical in
// every seat's process, so treating it as a seat would make every seat collide
// on the same lane. A run without PAPERCLIP_AGENT_ID is a human or a non-seat
// process and has no lane to be out of.
const agentId = process.env.PAPERCLIP_AGENT_ID || null;
if (!agentId) {
  // A human or a non-seat process. There is no seat to be out of lane for.
  process.stdout.write("check-worktree-isolation: skipped, no seat identity in env\n");
  process.exit(0);
}

let topLevel;
try {
  topLevel = git("rev-parse", "--show-toplevel");
} catch (err) {
  // "not a git repository" means there is no worktree to judge, so skipping is
  // right. Any other failure is git refusing to answer for a reason we did not
  // predict: dubious ownership, a corrupt repo, a permissions problem. Exiting
  // 0 there is the worst outcome available, because it converts "I could not
  // tell" into "allowed" without a word, and that is how a guard stops being a
  // guard. Fail closed instead, and say why.
  const stderr = (err && err.stderr) || "";
  if (/not a git repository/i.test(stderr)) {
    process.stdout.write("check-worktree-isolation: skipped, not a git repository\n");
    process.exit(0);
  }
  process.stderr.write(
    `check-worktree-isolation: could not determine the worktree root, refusing the commit.\n` +
      `git said: ${stderr.trim() || (err && err.message) || "unknown error"}\n` +
      `This is a git failure, not a clean run. Fix the repository, or commit with\n` +
      `--no-verify if you are certain this worktree is yours.\n`,
  );
  process.exit(2);
}

const repoRoot = path.resolve(topLevel);
if (WORKTREE_ROOT === null) {
  // The configured root does not exist, so no worktree under it can be in play.
  // Nothing to judge, and in particular nothing to block.
  process.stdout.write(
    `check-worktree-isolation: skipped, worktree root ${configuredRoot} does not exist\n`,
  );
  process.exit(0);
}
const relative = path.relative(WORKTREE_ROOT, repoRoot);

if (relative.startsWith("..") || path.isAbsolute(relative)) {
  // Not under the shared issue-worktree root. A reference checkout, a scratch
  // clone, or a test fixture. Not this check's business.
  process.stdout.write("check-worktree-isolation: skipped, not an issue worktree\n");
  process.exit(0);
}

// Everything below here is an issue worktree. Derive the seat the way
// keece-workspace does: the first group of the agent UUID.
const seat = agentId.trim().toLowerCase().split("-")[0].slice(0, 8);
const dirName = path.basename(repoRoot);

// The directory is <kind>-kee-<issue>[-<suffix>], where <kind> is whatever the
// minting tool used ("paperclip" or "app" today, but seats create lanes by
// hand often enough that new prefixes do appear: "keece-kee-923" is a real
// directory on this host). Match the issue token anywhere in the leading run
// rather than stripping a fixed kind prefix, so an unfamiliar prefix is still
// recognised as an issue lane instead of silently skipping.
//
// A hard-coded `^(app|paperclip)-` prefix caused two real false negatives
// found in review: "paperclip-kee341-pr13498" and "keece-kee-923" both exited
// 0 as "not an issue worktree", when both are exactly the shape this check
// exists to catch.
const issueMatch = dirName.match(/kee-?\d+/i);
if (!issueMatch || issueMatch.index === undefined) {
  // No issue token anywhere in the name. This is a reference checkout or an
  // unrelated directory, so do not guess and do not fail a reviewer over it.
  process.stdout.write(`check-worktree-isolation: skipped, ${dirName} is not an issue worktree\n`);
  process.exit(0);
}
const tail = dirName.slice(issueMatch.index + issueMatch[0].length).replace(/^-+/, "");

if (/^[0-9a-f]{8}$/.test(tail)) {
  if (tail === seat) {
    process.stdout.write(`check-worktree-isolation: ok, seat ${seat} owns ${dirName}\n`);
    process.exit(0);
  }
  fail(
    `${dirName} belongs to seat ${tail}, but this run is seat ${seat}.\n` +
      `Run ~/.local/bin/keece-workspace <app|paperclip> <KEE-nnn> to mint your own worktree.\n` +
      `Committing here would put your work in another seat's branch.`,
  );
}

// No seat segment: a pre-isolation path. Refuse rather than guess, because the
// whole incident is that these paths were shared and nobody noticed.
fail(
  `${dirName} is a pre-isolation shared worktree with no seat in its path.\n` +
    `These paths were shared across seats and caused the KEE-923 amend collision.\n` +
    `Run ~/.local/bin/keece-workspace <app|paperclip> <KEE-nnn> to get a seat-isolated path.\n` +
    `Do not commit into a shared path. If this worktree holds work you own, move it\n` +
    `to your own lane with git format-patch and git am, not with a reset.`,
);
