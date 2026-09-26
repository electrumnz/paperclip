#!/usr/bin/env node
/**
 * check-worktree-isolation.mjs
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
import path from "node:path";
import process from "node:process";

// Overridable only so the guard's own tests can exercise it without creating
// real seat-named worktrees. It is not a bypass in any meaningful sense: a seat
// that wanted to defeat this check could simply not run it, and CI checks the
// repo out outside this root, where the check skips regardless.
const WORKTREE_ROOT = process.env.KEE_WORKTREE_ROOT || "/home/love4vengeance/Work/keece-issue-worktrees";

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
} catch {
  // Not inside a git worktree at all.
  process.exit(0);
}

const repoRoot = path.resolve(topLevel);
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

// The directory is <kind>-kee-<issue>[-<suffix>]. The issue token itself
// contains a hyphen, so strip by prefix rather than by a fixed index: a
// "slice(2)" here would read the "929" of "paperclip-kee-929-4a323d0d" as the
// suffix and reject the seat's own lane.
const withoutKind = dirName.replace(/^(app|paperclip)-/, "");
const withoutIssue = withoutKind.replace(/^kee-\d+/, "");
if (withoutIssue === withoutKind) {
  // Not shaped like an issue worktree. Do not guess; do not fail a reviewer's
  // checkout over it.
  process.stdout.write(`check-worktree-isolation: skipped, ${dirName} is not an issue worktree\n`);
  process.exit(0);
}
const tail = withoutIssue.replace(/^-+/, "");

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
