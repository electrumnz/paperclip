import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(agentId, workdir, rootOverride) {
  const env = { ...process.env };
  if (agentId === null) delete env.PAPERCLIP_AGENT_ID;
  else env.PAPERCLIP_AGENT_ID = agentId;
  // The guard decides "is this an issue worktree" from the absolute path, so
  // the fixtures have to sit under a root it recognises. Point it at the
  // fixture tree instead of minting real seat-named worktrees.
  env.KEE_WORKTREE_ROOT = rootOverride ?? fixtureRoot;
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

test("a missing worktree root is skipped, not thrown", () => {
  // Regression: the first version called realpathSync on KEE_WORKTREE_ROOT at
  // module load, so a root that does not exist raised ENOENT before any of the
  // skip checks ran. As a pre-commit hook that blocks a commit on a machine
  // that has no such layout at all. Found by Greptile on #14094.
  const dir = path.join(fixtureRoot, "paperclip-kee-929-4a323d0d");
  mkdirSync(dir, { recursive: true });
  const { code, stdout, stderr } = run(SEAT_A, dir, path.join(fixtureRoot, "no-such-root"));
  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /ENOENT/);
  assert.match(stdout, /does not exist/);
});

test("a missing worktree root is skipped even for a real violation path", () => {
  // The point of the fix: a seat that IS out of lane must not be blocked by a
  // root that cannot be resolved, because "cannot tell" is not "guilty".
  const dir = makeWorktree("paperclip-kee-929-4a323d0d");
  const { code, stdout } = run(SEAT_B, dir, path.join(fixtureRoot, "no-such-root"));
  assert.equal(code, 0);
  assert.match(stdout, /does not exist/);
});

test("a lane whose issue number runs into the kind prefix is still a lane", () => {
  // Regression, found in independent review: the kind prefix was hard-coded to
  // ^(app|paperclip)-, so "paperclip-kee341-pr13498" matched neither prefix nor
  // /^kee-\d+/ and was skipped as "not an issue worktree". It is a real lane on
  // this host, and it is exactly the shape this check exists to catch.
  const dir = makeWorktree("paperclip-kee341-pr13498");
  const { code } = run(SEAT_A, dir);
  assert.equal(code, 1);
});

test("an unfamiliar kind prefix is still a lane", () => {
  // Same regression. "keece-kee-923" is not a prefix the minting tool emits, but
  // a lane is a lane. Refusing to guess must not extend to guessing "safe".
  const dir = makeWorktree("keece-kee-923");
  const { code } = run(SEAT_A, dir);
  assert.equal(code, 1);
});

test("a git failure is not a silent pass", () => {
  // Regression, found in independent review. The guard caught every git error
  // with a bare `catch { process.exit(0) }`, so "fatal: detected dubious
  // ownership" became exit 0: the guard reported success while knowing nothing.
  // A pre-commit hook that passes when it cannot tell is not a guard.
  const stub = path.join(fixtureRoot, "git-stub");
  mkdirSync(stub, { recursive: true });
  const gitStub = path.join(stub, "git");
  writeFileSync(gitStub, '#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n', {
    mode: 0o755,
  });
  const dir = makeWorktree("paperclip-kee-923");
  const env = { ...process.env };
  env.PATH = `${stub}:${env.PATH}`;
  env.PAPERCLIP_AGENT_ID = SEAT_A;
  env.KEE_WORKTREE_ROOT = fixtureRoot;
  const result = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: "utf8" });
  // Exit 2 is the documented "could not decide" code, distinct from 1 (refused)
  // and 0 (clean). Anything that reports success here is a false negative.
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not determine the worktree root/);
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
