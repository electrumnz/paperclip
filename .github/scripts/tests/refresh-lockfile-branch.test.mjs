import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planRefresh,
  isRefreshBot,
  REFRESH_BRANCH,
  MANUAL_EXEMPTION_BRANCH,
  BOT_AUTHOR,
} from '../refresh-lockfile-branch.mjs';

const OWNER = 'electrumnz';

const pr = (over = {}) => ({
  url: 'https://github.com/electrumnz/paperclip/pull/1',
  headRefName: REFRESH_BRANCH,
  author: { login: BOT_AUTHOR },
  headRepositoryOwner: { login: OWNER },
  ...over,
});

test('the bot branch is not the manual exemption branch', () => {
  assert.notEqual(
    REFRESH_BRANCH,
    MANUAL_EXEMPTION_BRANCH,
    'a human using the manual exemption must not collide with the bot working branch',
  );
});

test('reuses the bot own open pull request', () => {
  const plan = planRefresh([pr()], OWNER);
  assert.equal(plan.prUrl, 'https://github.com/electrumnz/paperclip/pull/1');
  assert.deepEqual(plan.conflicts, []);
});

test('refuses to act when a human PR holds the bot branch', () => {
  // The reported failure mode: a human opens chore/refresh-lockfile-bot, the
  // bot fires. It must not adopt the PR and must not return a URL to merge.
  const plan = planRefresh([pr({ author: { login: 'somehuman' } })], OWNER);
  assert.equal(plan.prUrl, '', 'a human PR must never be adopted as the refresh PR');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].author, 'somehuman');
});

test('the bot PR and a human PR on the branch together are still a conflict', () => {
  const plan = planRefresh(
    [
      pr(),
      pr({ url: 'https://github.com/electrumnz/paperclip/pull/2', author: { login: 'somehuman' } }),
    ],
    OWNER,
  );
  assert.equal(plan.conflicts.length, 1, 'one non-bot PR blocks the run outright');
});

test('a pull request from a fork cannot collide with a push to this repository', () => {
  const plan = planRefresh(
    [pr({ headRepositoryOwner: { login: 'someone-else' }, author: { login: 'somehuman' } })],
    OWNER,
  );
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.prUrl, '', 'a fork PR is not reusable and not a conflict');
});

test('a PR on some other branch is ignored entirely', () => {
  const plan = planRefresh([pr({ headRefName: 'chore/refresh-lockfile' })], OWNER);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.prUrl, '');
});

test('a human on the manual exemption branch is not the bot', () => {
  assert.equal(isRefreshBot('somehuman', MANUAL_EXEMPTION_BRANCH), false);
  assert.equal(isRefreshBot(BOT_AUTHOR, REFRESH_BRANCH), true);
});

test('a missing or malformed pull request list does not authorise a push', () => {
  for (const bad of [undefined, null, 'nonsense', {}]) {
    const plan = planRefresh(bad, OWNER);
    assert.equal(plan.prUrl, '', `no reuse for ${JSON.stringify(bad) ?? 'undefined'}`);
  }
});

// The workflow must consult ownership before the force-push, not after.
const workflow = readFileSync(
  new URL('../../workflows/refresh-lockfile.yml', import.meta.url),
  'utf8',
);

test('the workflow resolves the branch from the script, not a literal', () => {
  assert.match(workflow, /node \.github\/scripts\/refresh-lockfile-branch\.mjs --print-branch/);
  assert.doesNotMatch(
    workflow,
    /^ *BRANCH="chore\/refresh-lockfile"$/m,
    'the branch name must not be hard-coded in the workflow again',
  );
});

test('the ownership check runs before the push', () => {
  const claim = workflow.indexOf('refresh-lockfile-branch.mjs)"');
  const push = workflow.indexOf('git push --force');
  assert.ok(claim > 0 && push > 0);
  assert.ok(
    claim < push,
    'a collision must be detected before the bot can push over someone',
  );
});

test('the push is leased, so a commit that appeared after the claim cannot be lost', () => {
  // `--force-with-lease=<ref>:<sha>` makes the push fail when the remote ref has
  // moved since the claim step recorded `expected`. A human who pushed a commit
  // with no pull request open is invisible to `gh pr list`, and the lease is
  // what stops their commit from being overwritten.
  assert.match(workflow, /git push --force-with-lease=/);
  assert.doesNotMatch(
    workflow,
    /git push --force origin/,
    'a bare --force can still destroy a commit that no pull request records',
  );
  assert.match(workflow, /git ls-remote origin "refs\/heads\/\$BRANCH"/);
});

test('the claim step disables errexit for the whole step, not just one call', () => {
  // The step declares no `shell:`, so Actions runs `bash -e`. Under errexit a
  // bare assignment whose command substitution fails kills the step before the
  // status can be read. That bit twice: first the ownership script, then
  // `gh pr list`, which sat above the narrow `set +e`. A single `set +e` at the
  // top of the run block covers every fallible call that follows.
  const runBlock = workflow
    .split('      - name: Claim the refresh branch or refuse\n')[1]
    ?.split('      - name:')[0];
  assert.ok(runBlock, 'the claim step must exist');
  assert.match(runBlock, /^\s*set \+e\s*$/m, 'the claim step must disable errexit');

  const firstSet = runBlock.search(/^\s*set \+e\s*$/m);
  // Every command substitution in the step must come after it.
  const subs = [...runBlock.matchAll(/\$\(([^)]*)\)/g)];
  assert.ok(subs.length >= 4, `expected several command substitutions, saw ${subs.length}`);
  for (const m of subs) {
    assert.ok(
      m.index > firstSet,
      `command substitution after errexit was re-enabled: ${m[1].trim().slice(0, 60)}`,
    );
  }
  // And errexit must not be switched back on part-way through.
  assert.doesNotMatch(runBlock, /^\s*set -e\s*$/m, 'errexit must stay off for the whole step');
});

test('a conflict leaves the branch output empty so the push step is skipped', () => {
  // On the refusal path the step writes branch= explicitly, so the `if:` guard
  // on the push step evaluates false and no push, adoption, or delete happens.
  assert.match(workflow, /echo "branch=" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if: steps\.branch-claim\.outputs\.branch != ''/);
});

test('the workflow no longer reuses a PR by branch name and owner alone', () => {
  assert.doesNotMatch(
    workflow,
    /select\(\.headRepositoryOwner\.login/,
    'reuse must check PR authorship, not only the head repository owner',
  );
  assert.match(workflow, /json url,headRefName,author,headRepositoryOwner/);
});
