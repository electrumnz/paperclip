import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guard tests for scripts/check-worktree-isolation.mjs (KEE-929).
 *
 * The incident this exists to prevent: a DevOps Automator session committed
 * 3d8d0b1e5 into /home/love4vengeance/Work/keece-issue-worktrees/paperclip-kee-923,
 * and four minutes later another seat ran `git commit --amend` in the same
 * worktree. The amend absorbed the first commit and inherited its authorship.
 *
 * These tests exercise the decision function, not a live git repo, so they do
 * not need a worktree and cannot touch a real seat's checkout.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "check-worktree-isolation.mjs");

const SEAT_A = "4a323d0d-28ff-4974-ba69-9e0c9a3fc44d";
const SEAT_B = "0f4136b3-8cc6-4dc1-a956-106ba76877e4";
const SEAT_A_SHORT = "4a323d0d";
const SEAT_B_SHORT = "0f4136b3";

function run(agentId, workdir) {
  const env = { ...process.env };
  if (agentId === null) delete env.PAPERCLIP_AGENT_ID;
  else env.PAPERCLIP_AGENT_ID = agentId;
  // The guard decides "is this an issue worktree" from the absolute path, so
  // the fixtures have to sit under a root it recognises. Point it at the
  // fixture tree instead of minting real seat-named worktrees.
  env.KEE_WORKTREE_ROOT = fixtureRoot;
  const result = spawnSync(process.execPath, [script], { cwd: workdir, env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const rootLink = mkdtempSync(path.join(tmpdir(), "keece-isolation-"));
const fixtureRoot = path.join(rootLink, "keece-issue-worktrees");
mkdirSync(fixtureRoot, { recursive: true });

// The guard resolves the repository root with `git rev-parse --show-toplevel`,
// so each fixture has to be a real (empty) repository, not a plain directory.
// A repo with no commits still answers --show-toplevel, so no commit is needed.
function makeWorktree(dirName) {
  const dir = path.join(fixtureRoot, dirName);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });
  return dir;
}

test.after(() => {
  rmSync(rootLink, { recursive: true, force: true });
});

test("a seat may work in its own lane", () => {
  const { code, stdout } = run(SEAT_A, makeWorktree(`paperclip-kee-929-${SEAT_A_SHORT}`));
  assert.equal(code, 0, stdout);
  assert.match(stdout, /owns paperclip-kee-929-4a323d0d/);
});

test("a seat is refused in another seat's lane and told how to get its own", () => {
  const { code, stderr } = run(SEAT_A, makeWorktree(`paperclip-kee-929-${SEAT_B_SHORT}`));
  assert.equal(code, 1);
  assert.match(stderr, /belongs to seat 0f4136b3, but this run is seat 4a323d0d/);
  assert.match(stderr, /keece-workspace/);
});

test("a pre-isolation shared path is refused, not guessed at", () => {
  const { code, stderr } = run(SEAT_A, makeWorktree("paperclip-kee-923"));
  assert.equal(code, 1);
  assert.match(stderr, /pre-isolation shared worktree/);
});

test("the KEE-923 amend collision is named in the refusal", () => {
  const { stderr } = run(SEAT_B, makeWorktree("paperclip-kee-923"));
  assert.match(stderr, /KEE-923 amend collision/);
  assert.match(stderr, /git format-patch/);
});

test("an app worktree is covered by the same rule", () => {
  const { code, stderr } = run(SEAT_A, makeWorktree(`app-kee-929-${SEAT_B_SHORT}`));
  assert.equal(code, 1);
  assert.match(stderr, /belongs to seat 0f4136b3/);
});

test("a legacy suffix path is treated as shared, not as another seat's lane", () => {
  const { code, stderr } = run(SEAT_A, makeWorktree("paperclip-kee-216-verify"));
  assert.equal(code, 1);
  assert.match(stderr, /pre-isolation shared worktree/);
});

test("a non-hex suffix does not impersonate a seat lane", () => {
  const { code, stderr } = run(SEAT_A, makeWorktree("paperclip-kee-900-v2"));
  assert.equal(code, 1);
  assert.match(stderr, /pre-isolation shared worktree/);
});

test("a run with no seat identity is not judged", () => {
  const { code, stdout } = run(null, makeWorktree("paperclip-kee-923"));
  assert.equal(code, 0);
  assert.match(stdout, /no seat identity/);
});

test("a repository outside the worktree root is skipped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keece-not-a-worktree-"));
  try {
    execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });
    const { code, stdout } = run(SEAT_A, dir);
    assert.equal(code, 0);
    assert.match(stdout, /skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory that is not a git checkout is skipped", () => {
  const dir = path.join(fixtureRoot, "not-git-at-all");
  mkdirSync(dir, { recursive: true });
  const { code } = run(SEAT_A, dir);
  assert.equal(code, 0);
});

test("the script exists and is executable as node", () => {
  assert.ok(script.endsWith("check-worktree-isolation.mjs"));
  const out = execFileSync(process.execPath, ["--check", script], { encoding: "utf8" });
  assert.equal(out, "");
});

// Regression, KEE-929. The first version compared `git rev-parse
// --show-toplevel` against a literal WORKTREE_ROOT without realpath'ing either
// side. git returns the toplevel already resolved; the literal was not, so
// path.relative produced "../../../../Work/keece-issue-worktrees/..." and the
// guard took the "outside the root, skip" branch on every single path. It
// passed all eleven unit tests here, because mkdtempSync under /tmp shares no
// symlinked ancestor with the fixture root, and it silently allowed every
// commit when installed as a real hook. The only thing that caught it was
// running it against a real worktree under a symlinked ancestor.
test("a symlinked ancestor on the worktree root does not disable the guard", () => {
  const realRoot = mkdtempSync(path.join(tmpdir(), "keece-isolation-real-"));
  // A symlink that resolves to the real root, mimicking a symlinked home or
  // Work directory.
  const linkRoot = path.join(realRoot, "link");
  const realWorktrees = path.join(realRoot, "keece-issue-worktrees");
  mkdirSync(realWorktrees, { recursive: true });
  symlinkSync(realWorktrees, linkRoot);

  try {
    const dir = path.join(realWorktrees, "paperclip-kee-923");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", dir], { encoding: "utf8" });

    // Point the guard at the *symlinked* spelling of the root while git reports
    // the resolved one. This is the case that silently disabled it.
    const env = { ...process.env, PAPERCLIP_AGENT_ID: SEAT_A, KEE_WORKTREE_ROOT: linkRoot };
    const result = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 1, `guard allowed a shared path: ${result.stdout}`);
    assert.match(result.stderr, /pre-isolation shared worktree/);
  } finally {
    rmSync(realRoot, { recursive: true, force: true });
  }
});
