import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// KEE-999. The guard suites landed by PR #15 are run by no CI lane on this
// fork, because .github/workflows/pr.yml pins the reusable workflow to an
// upstream commit whose copy has no guard step. This test is the regression
// guard for that wiring: if the fork-local lane is deleted, renamed, or
// narrowed, it fails.
//
// The assertion is deliberately scoped to the three guard suites. It is NOT
// "every suite under scripts/__tests__/ must be run by some workflow": nine
// such files are already orphaned on the fork, and turning this into a global
// invariant would make it red for work this issue does not own.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const GUARD_SUITES = [
  "scripts/__tests__/check-worktree-isolation.test.mjs",
  "scripts/__tests__/install-worktree-isolation-hook.test.mjs",
  "scripts/__tests__/kee962-crosscheck.test.mjs",
];

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

const guardWorkflow = existsSync(path.join(repoRoot, ".github/workflows/worktree-guard-check.yml"))
  ? readWorkflow("worktree-guard-check.yml")
  : "";

test("the fork-local guard lane exists", () => {
  assert.notEqual(guardWorkflow, "",
    ".github/workflows/worktree-guard-check.yml must exist; it is the only lane that runs the guard suites (KEE-999)");

  // It must be a pull_request lane. A push-only lane would never have run on
  // PR #15 or #19, which is the gap this file closes.
  assert.match(guardWorkflow, /^on:\n  pull_request:$/m);
  // permissions: {} at workflow level, contents: read at job level. Anything
  // wider is unearned here: this lane runs three node:test files.
  assert.match(guardWorkflow, /^permissions: \{\}$/m);
  assert.match(guardWorkflow, /^    permissions:\n      contents: read$/m);
  assert.match(guardWorkflow, /^    runs-on: ubuntu-latest$/m);
});

test("every guard suite has a step in the guard lane", () => {
  for (const suite of GUARD_SUITES) {
    assert.ok(guardWorkflow.includes(suite),
      `the guard lane must run ${suite}, or the suite has no CI coverage again`);
  }
});

test("the guard lane triggers on the files the suites exercise", () => {
  // A paths filter that omits a suite or the guard source would skip the lane
  // exactly when that file changes, which is the moment it matters.
  for (const changed of [
    ...GUARD_SUITES,
    "scripts/check-worktree-isolation.mjs",
    "scripts/install-worktree-isolation-hook.mjs",
    ".github/workflows/worktree-guard-check.yml",
  ]) {
    assert.ok(
      guardWorkflow.includes(`      - ${changed}\n`),
      `the guard lane must trigger on ${changed}`);
  }
});

test("a missing guard reports as not-run rather than as a pass", () => {
  // The whole point of KEE-999: a green check that ran nothing is a lie. The
  // suite steps must be gated on presence, and a step summary must say the
  // suite did not run.
  assert.match(guardWorkflow, /id: guard\n/);
  assert.match(guardWorkflow, /echo "present=\$present" >> "\$GITHUB_OUTPUT"/);
  assert.match(guardWorkflow, /GITHUB_STEP_SUMMARY/);
  assert.match(guardWorkflow, /did not run/);
  // Each suite step is conditional on presence.
  const suiteSteps = guardWorkflow.split("\n")
    .filter((line) => GUARD_SUITES.some((suite) => line.includes(suite) && line.startsWith("        run:")));
  assert.equal(suiteSteps.length, GUARD_SUITES.length,
    "each guard suite must have exactly one conditional run step");
  for (const step of suiteSteps) {
    const index = guardWorkflow.indexOf(step);
    const preceding = guardWorkflow.slice(0, index).split("\n");
    const condition = preceding.at(-2);
    assert.equal(typeof condition, "string");
    assert.match(condition, /if: steps\.guard\.outputs\.present != 'none'/,
      "a guard suite step must not run when the guard is absent");
  }
});

test("the guard lane runs no pnpm bootstrap", () => {
  // The guard, the installer and their suites import node builtins only. An
  // install here would cost minutes to run three node:test files, and would
  // make this lane fail for reasons unrelated to the guard.
  assert.doesNotMatch(guardWorkflow, /pnpm install|--frozen-lockfile|run_install: true/);
});

test("the upstream pin is left alone for upstream parity", () => {
  // This lane is additive on purpose. The pin is not repointed at a fork ref
  // because GitHub resolves `uses: owner/repo/path@ref` inside the named
  // repository, and because fork/master's own pr-trusted.yml is stale
  // relative to upstream master.
  const caller = readWorkflow("pr.yml");
  const pin = caller.match(/uses: (\S+)/)?.[1];
  assert.ok(pin, "pr.yml must still call a reusable workflow");
  assert.match(pin, /^paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml@[0-9a-f]{40}$/,
    "the upstream pin must stay an immutable upstream SHA; this lane does not replace it");
});
