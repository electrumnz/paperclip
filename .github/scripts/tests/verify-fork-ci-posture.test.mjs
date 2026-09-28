import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const guardPath = new URL("../verify-fork-ci-posture.sh", import.meta.url).pathname;
const script = readFileSync(guardPath, "utf8");

const FORK_REPO = "electrumnz/paperclip";
const SECRET_NAME = "COMMITPERCLIP_KEY";

/**
 * Fixture payloads describe what gh *prints*, as a list of lines. They are
 * never pre-stringified: a stringified multi-line value would reach bash as one
 * literal line of backslash escapes, which is exactly how a test ends up
 * passing against a stub that is not faithful.
 *
 *   { lines }   what gh writes to stdout
 *   { jqLines } what gh writes when --jq is present, instead of `lines`
 *   { fail }    what gh writes to stderr, and it exits non-zero
 */
const q = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const printf = (lines) => `printf '%s\\n' ${lines.map(q).join(" ")}`;

// A workflow lookup outcome, as GitHub or gh would report it.
const workflowState = (value) => {
  if (value === "notfound") return { fail: "gh: HTTP 404: Not Found (https://api.github.com/...)\n" };
  if (value === "denied") return { fail: "gh: HTTP 403: Resource not accessible by integration\n" };
  if (value === "unavailable") return { fail: "gh: Could not connect to github.com\n" };
  return { lines: [value] };
};

// The secrets listing, in the two shapes gh emits. With `--json name` alone gh
// returns a JSON array; with `--jq '.[].name'` it returns one name per line.
// The plain listing is "NAME<TAB>UPDATED", the shape the review reproduced
// defect (1) against; there the stub rejects --json the way an older gh does,
// so the guard's fallback branch is genuinely taken rather than accidentally
// passed by a stub that answered every flag the same way.
const secretsListing = (names, { structured = true, fail = false } = {}) => {
  if (fail) return { fail: "gh: HTTP 403: Resource not accessible by integration\n" };
  if (!structured) {
    return {
      // An older gh has no --json, so the guard's first attempt fails and it
      // must fall back to the plain listing.
      pre: `case " $* " in *" --json "*) echo "gh: unknown flag: --json" >&2; exit 1 ;; esac`,
      lines: names.map((name) => `${name}\t2026-09-01T00:00:00Z`),
    };
  }
  return { jqLines: names, lines: [JSON.stringify(names.map((name) => ({ name })))] };
};

const pullRequestList = (prs) => ({ lines: [JSON.stringify(prs)] });

// Renders a payload into the body of a bash stub. `--jq` selects `jqLines`
// and exits, the way gh does, before the plain lines are printed.
const render = ({ pre, jqLines, lines, fail } = {}) => {
  if (fail) return `printf '%s' ${q(fail)} >&2\nexit 1`;
  const body = [];
  if (pre) body.push(pre);
  if (jqLines) {
    const names = jqLines.length ? printf(jqLines) : "true";
    body.push(`case " $* " in\n  *" --jq "*) ${names}; exit 0 ;;\nesac`);
  }
  if (lines && lines.length) body.push(printf(lines));
  return `${body.join("\n")}\nexit 0`;
};

/**
 * Runs the guard against a throwaway `gh` on PATH. Every call is recorded and
 * answered from fixtures: no network call, no token, and no real repository is
 * touched, so the suite behaves identically offline and in CI.
 */
function runGuard({
  forkWorkflow = "active",
  upstreamWorkflow = "active",
  secrets = [],
  secretList = {},
  prs = [],
  prListFails = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fork-ci-posture-"));
  const log = path.join(dir, "gh.log");

  const stub = `#!/bin/bash
printf 'gh %s\\n' "$*" >> "$GH_LOG"

if [ "$1" = "api" ]; then
  case "$2" in
    repos/${FORK_REPO}/actions/workflows/*) FORK_WORKFLOW_BODY ;;
    repos/*/actions/workflows/*) UPSTREAM_WORKFLOW_BODY ;;
    *) echo "gh: HTTP 404: Not Found" >&2; exit 1 ;;
  esac
fi

if [ "$1" = "secret" ]; then
  SECRETS_BODY
fi

if [ "$1" = "pr" ]; then
  PRS_BODY
fi

echo "gh: unexpected invocation: $*" >&2
exit 97
`;

  const rendered = stub
    .replace("FORK_WORKFLOW_BODY", render(workflowState(forkWorkflow)))
    .replace("UPSTREAM_WORKFLOW_BODY", render(workflowState(upstreamWorkflow)))
    .replace("SECRETS_BODY", render(secretsListing(secrets, secretList)))
    .replace("PRS_BODY", render(prListFails ? { fail: "gh: could not list pull requests\n" } : pullRequestList(prs)));

  try {
    writeFileSync(path.join(dir, "gh"), rendered, { mode: 0o755 });
    const result = spawnSync("bash", [guardPath, FORK_REPO], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log },
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const reviewCheck = (conclusion) => ({ name: "review", conclusion, status: conclusion ? "completed" : "in_progress" });
const pr = (number, checks = []) => ({ number, mergeStateStatus: "UNSTABLE", statusCheckRollup: checks });
const calls = (r) => r.calls.split("\n").filter(Boolean);

test("active workflow with the secret bound is verified OK", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: [SECRET_NAME] });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /OK {3}review workflow active AND COMMITPERCLIP_KEY bound/);
  assert.match(r.stdout, /RESULT: pass/);
});

// Defect (1) from the review: `gh secret list` prints "NAME<TAB>UPDATED", so
// `grep -qx NAME` never matched a bound secret and a correctly-configured
// active workflow was reported as the regression.
test("a bound secret is recognised through the tab-separated gh listing", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: [SECRET_NAME, "OTHER_KEY"], secretList: { structured: false } });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /FAIL review workflow is ACTIVE/);
});

test("a tab-separated listing does not match on a name prefix or substring", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: ["COMMITPERCLIP_KEY_BACKUP"], secretList: { structured: false } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL review workflow is ACTIVE but COMMITPERCLIP_KEY is not bound/);
});

test("active workflow with the secret missing fails", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: ["OTHER_KEY"] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL review workflow is ACTIVE/);
  assert.match(r.stdout, /RESULT: FAIL/);
});

// The secret-list case carries three distinct outcomes, and conflating any two
// of them sends the reader to the wrong action:
//   listed + name present  -> OK
//   listed + name absent   -> the secret really is unbound, advise a disable
//   unreadable             -> an access failure, NOT evidence of absence, and
//                             must print no disable advice at all
test("a failed secret listing is unverified, and never advises a disable", () => {
  const r = runGuard({ forkWorkflow: "active", secretList: { fail: true } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /RESULT: FAIL/);
  // The diagnosis: a read failure, not a claim about the secret.
  assert.match(r.stdout, /UNVERIFIED the review workflow is ACTIVE but the secret list/);
  assert.match(r.stdout, /access or read failure/);
  assert.match(r.stdout, /NOT evidence\s+that COMMITPERCLIP_KEY is unbound/);
  // And the remedy it must not offer. A caller who cannot read secrets is the
  // one person least able to act on a disable instruction, and the instruction
  // would be unfounded anyway.
  assert.doesNotMatch(r.stdout, /is not bound/);
  assert.doesNotMatch(r.stdout, /workflow disable/);
  for (const call of calls(r)) assert.doesNotMatch(call, /workflow disable/);
});

// Distinguishes the two ways a listing can come back empty. gh exiting 0 with
// no output is a real, readable "this repo has no secrets" and does justify a
// FAIL; gh failing is an access error and must not.
test("an empty but readable listing is evidence of absence, a failed one is not", () => {
  const empty = runGuard({ forkWorkflow: "active", secrets: [] });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /FAIL review workflow is ACTIVE but COMMITPERCLIP_KEY is not bound/);
  assert.match(empty.stdout, /The secret list was read and does not contain COMMITPERCLIP_KEY/);
  assert.match(empty.stdout, /workflow disable/);

  const unreadable = runGuard({ forkWorkflow: "active", secretList: { fail: true } });
  assert.equal(unreadable.status, 1);
  assert.doesNotMatch(unreadable.stdout, /is not bound/);
  assert.doesNotMatch(unreadable.stdout, /workflow disable/);
});

// A secret list that fails only on the structured form still falls back to the
// plain listing, and a failure on both is what "unreadable" means.
test("the unreadable verdict needs both attempts to fail", () => {
  const structuredOnly = runGuard({ forkWorkflow: "active", secrets: [SECRET_NAME], secretList: { structured: false } });
  assert.equal(structuredOnly.status, 0, structuredOnly.stdout);
  assert.doesNotMatch(structuredOnly.stdout, /UNVERIFIED/);
});

test("disabled workflow needs no credential and passes", () => {
  const r = runGuard({ forkWorkflow: "disabled_manually", secrets: [] });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /OK {3}review workflow not active \(state=disabled_manually\)/);
});

test("every disabled_* state GitHub reports is recognised as disabled", () => {
  for (const state of ["disabled_inactivity", "disabled_fork"]) {
    const r = runGuard({ forkWorkflow: state });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, new RegExp(`not active \\(state=${state}\\)`));
  }
});

// Defect (2) from the review: a failed lookup returned "unknown" and exited 0
// claiming the workflow was disabled.
test("a denied workflow lookup is unverified and exits non-zero", () => {
  const r = runGuard({ forkWorkflow: "denied" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED/);
  assert.doesNotMatch(r.stdout, /OK {3}review workflow not active/);
  assert.match(r.stdout, /NOT the same as the workflow being disabled/);
});

test("an unavailable workflow lookup is unverified and exits non-zero", () => {
  const r = runGuard({ forkWorkflow: "unavailable" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED/);
  assert.doesNotMatch(r.stdout, /RESULT: pass/);
});

test("a 404 workflow lookup is reported as missing, not as disabled", () => {
  const r = runGuard({ forkWorkflow: "notfound" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED the review workflow is not present/);
  assert.doesNotMatch(r.stdout, /OK {3}review workflow not active/);
});

test("an unrecognised workflow state is unverified, never read as disabled", () => {
  const r = runGuard({ forkWorkflow: "teleported" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED/);
  assert.doesNotMatch(r.stdout, /OK {3}review workflow not active/);
});

test("a fork-side disable of the upstream workflow fails the guard", () => {
  const r = runGuard({ forkWorkflow: "disabled_manually", upstreamWorkflow: "disabled_manually" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL upstream review workflow state is 'disabled_manually'/);
});

test("an unreadable upstream workflow leaves immutability unverified", () => {
  const r = runGuard({ forkWorkflow: "disabled_manually", upstreamWorkflow: "denied" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED the upstream review workflow state/);
});

// The third defect found in the first version: it compared the conclusion to a
// lowercase "failure" while GitHub returns "FAILURE", so it reported no red
// review checks while several PRs were visibly red.
test("red review checks are detected using GitHub's uppercase conclusions", () => {
  const r = runGuard({
    forkWorkflow: "disabled_manually",
    prs: [
      pr(8, [reviewCheck("FAILURE")]),
      pr(9, [reviewCheck("failure")]),
      pr(10, [reviewCheck("SUCCESS")]),
      pr(11, [{ name: "ci", conclusion: "FAILURE" }]),
      pr(12, [reviewCheck(null)]),
    ],
  });
  assert.equal(r.status, 0, r.stdout);
  // Only the two PRs whose `review` check actually failed, in either case.
  assert.match(r.stdout, /STALE open PRs still reporting a red review check: 8,9/);
});

// The distribution in step 4 is read from the same `gh pr list` call as the
// red-check survey. gh omits a field that was not requested, so dropping
// mergeStateStatus from that call does not fail: it turns every entry into
// "null", which looks like output but carries no signal. This pins the request.
test("the distribution is not silently all null", () => {
  const r = runGuard({
    forkWorkflow: "disabled_manually",
    prs: [pr(81, [reviewCheck("SUCCESS")]), pr(80, [reviewCheck("SUCCESS")])],
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /UNSTABLE: 2 {2}\(#81, #80\)/);
  assert.doesNotMatch(r.stdout, /null:/);
});

test("every distribution bucket is reported with its own status", () => {
  const mixed = [
    { ...pr(1), mergeStateStatus: "CLEAN" },
    { ...pr(2), mergeStateStatus: "DIRTY" },
    { ...pr(3), mergeStateStatus: "UNKNOWN" },
  ];
  const r = runGuard({ forkWorkflow: "disabled_manually", prs: mixed });
  assert.equal(r.status, 0, r.stdout);
  for (const [status, number] of [["CLEAN", 1], ["DIRTY", 2], ["UNKNOWN", 3]]) {
    assert.match(r.stdout, new RegExp(`${status}: 1 {2}\\(#${number}\\)`));
  }
});

test("an unlistable PR set is unverified rather than an all-clear", () => {
  const r = runGuard({ forkWorkflow: "disabled_manually", prListFails: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNVERIFIED open PRs could not be listed/);
});

// The guard is read-only by construction. Checked behaviourally, against what it
// actually invoked: a regex over the file would be wrong here, because the FAIL
// branch legitimately *prints* `gh workflow disable ...` as advice for a human.
// Printed advice is not a write.
test("the guard issues only read-only gh calls", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: [SECRET_NAME] });
  assert.ok(calls(r).length >= 3, `expected workflow, secret and PR reads, got ${calls(r).length}`);
  for (const call of calls(r)) {
    assert.doesNotMatch(call, /\bworkflow\s+(enable|disable)\b/, `executed a workflow write: ${call}`);
    assert.doesNotMatch(call, /\bsecret\s+(set|delete|remove)\b/, `executed a secret write: ${call}`);
    assert.doesNotMatch(call, /--method[= ]+(POST|PUT|PATCH|DELETE)/i, `executed a non-GET api call: ${call}`);
  }
});

test("the disable advice is printed, never executed", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: [] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /gh workflow disable \.github\/workflows\/commitperclip-review\.yml/);
  for (const call of calls(r)) assert.doesNotMatch(call, /workflow disable/);
});

// No secret value can be printed, because none is ever requested: the guard
// asks for names only, so the gh log must contain no `value` field either.
test("the guard never requests a secret value", () => {
  const r = runGuard({ forkWorkflow: "active", secrets: [SECRET_NAME] });
  for (const call of calls(r)) {
    if (call.includes("secret list")) {
      assert.match(call, /--json name/);
      assert.doesNotMatch(call, /--json [^ ]*value/);
    }
  }
});

test("the guard is syntactically valid bash and does not hide failures behind set -e", () => {
  const syntax = spawnSync("bash", ["-n", guardPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  // `set -e` would abort before the UNVERIFIED branches could print anything.
  assert.match(script, /^set -uo pipefail$/m);
  assert.doesNotMatch(script, /^set -euo pipefail$/m);
});

test("the guard only ever reads the two repositories it names", () => {
  const r = runGuard({ forkWorkflow: "disabled_manually" });
  for (const call of calls(r)) {
    assert.match(call, /electrumnz\/paperclip|paperclipai\/paperclip/);
  }
});
