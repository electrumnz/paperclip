import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const e2ePath = `${here}manual/refresh-lockfile-collision-e2e.sh`;
const prTrusted = readFileSync(new URL('../../workflows/pr-trusted.yml', import.meta.url), 'utf8');
const refreshWorkflow = readFileSync(
  new URL('../../workflows/refresh-lockfile.yml', import.meta.url),
  'utf8',
);
const forkLane = readFileSync(
  new URL('../../workflows/lockfile-refresh-guard-check.yml', import.meta.url),
  'utf8',
);
const prYaml = readFileSync(new URL('../../workflows/pr.yml', import.meta.url), 'utf8');

test('the collision e2e is referenced by CI, so it cannot go dark again', () => {
  // The claim step is shell. Every unit test in this directory asserts the
  // workflow's static text, and those tests stay green when the `claim_rc`
  // handling is mutated away. The e2e is the only thing that actually executes
  // the step, so if nothing in CI runs it, the fail-closed guard is untested.
  assert.match(
    prTrusted,
    /bash \.github\/scripts\/tests\/manual\/refresh-lockfile-collision-e2e\.sh/,
    'pr-trusted.yml must run the lockfile refresh collision e2e for upstream',
  );
  // Guard against the obvious re-break: the path renamed in one place only.
  assert.doesNotMatch(
    prTrusted,
    /node --test '[^']*collision-e2e[^']*'/,
    'the e2e is a shell script and must be run with bash, not node --test',
  );
});

test('a fork-local CI lane actually runs the e2e in this fork', () => {
  // The fork's pr.yml pins `paperclipai/paperclip/.github/workflows/
  // pr-trusted.yml@<sha>`, and GitHub resolves `uses: owner/repo/path@ref`
  // inside the *named* repository. A step added to the fork's own copy of
  // pr-trusted.yml therefore never runs here. That is the same dead-coverage
  // trap KEE-999 hit, so the e2e needs a lane the fork actually executes.
  assert.match(
    prYaml,
    /uses: paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml@[0-9a-f]{7,40}/,
    'the fork pins pr-trusted.yml to an upstream commit, so a fork-local lane is required',
  );
  assert.match(
    forkLane,
    /bash \.github\/scripts\/tests\/manual\/refresh-lockfile-collision-e2e\.sh/,
    'the fork-local lane must run the collision e2e',
  );
  assert.match(
    forkLane,
    /node --test \.github\/scripts\/tests\/refresh-lockfile-exit-code\.test\.mjs/,
    'the fork-local lane must run the exit-code contract test',
  );
  // A lane narrowed back into a fake green is the failure this guards against.
  assert.match(forkLane, /Test guard CI wiring/);
  assert.match(forkLane, /Report collision suite not landed/);
  assert.doesNotMatch(
    forkLane,
    /node --test '[^']*collision-e2e[^']*'/,
    'the e2e is a shell script and must be run with bash, not node --test',
  );
});

test('a CI-run test asserts the rc handling the workflow depends on', () => {
  // `set +e` exists so the exit status can be read. Assert the static shape so
  // a refactor cannot quietly drop the guard, while the e2e proves it behaves.
  const claim = refreshWorkflow
    .split('      - name: Claim the refresh branch or refuse\n')[1]
    ?.split('      - name:')[0];
  assert.ok(claim, 'the claim step must exist in refresh-lockfile.yml');
  for (const v of ['claim_rc', 'list_rc']) {
    assert.ok(claim.includes(v), `the claim step must check ${v}`);
  }
  assert.match(claim, /if \[ "\$claim_rc" -ne 0 \]; then/, 'the conflict guard must be an explicit rc test');
  assert.match(claim, /if \[ "\$list_rc" -ne 0 \]; then/, 'the gh-failure guard must be an explicit rc test');
  // Both failure paths must claim no branch, so the push step is skipped.
  assert.ok(
    (claim.match(/echo "branch=" >> "\$GITHUB_OUTPUT"/g) ?? []).length >= 2,
    'each refusal path must write an empty branch so the push step is skipped',
  );
});

test('the e2e covers the rc paths, not only the happy path', () => {
  const e2e = readFileSync(e2ePath, 'utf8');
  // A human PR on the bot branch, a human PR with no open PR, an unreadable
  // list, and a gh that exits non-zero. These are the paths the rc guards own.
  for (const needle of [
    'a human PR holds the bot branch',
    'lands after the claim',
    'unreadable pull request list',
    'gh pr list failing outright',
  ]) {
    assert.ok(e2e.includes(needle), `the e2e must cover: ${needle}`);
  }
  // If the e2e is ever emptied it must not silently pass.
  assert.match(e2e, /passed=\$pass failed=\$fail/);
  assert.match(e2e, /\[ "\$fail" -eq 0 \]/);
});

test('the e2e is a shell script that CI invokes with bash', () => {
  const names = readdirSync(`${here}manual`);
  assert.ok(names.includes('refresh-lockfile-collision-e2e.sh'));
});
