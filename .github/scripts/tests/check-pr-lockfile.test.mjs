import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';
import { REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, BOT_AUTHOR } from '../refresh-lockfile-branch.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on the bot branch', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), BOT_AUTHOR, REFRESH_BRANCH);
  assert.equal(result.passed, true);
});

test('passes for the bot on the legacy plain branch while an old PR is open', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), BOT_AUTHOR, MANUAL_EXEMPTION_BRANCH);
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

// The hazard in KEE-1025: a human on the bot's own branch must not inherit the
// bot's exemption, otherwise the lockfile gate rubber-stamps a human PR.
test('fails when a human PR sits on the bot branch', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'somehuman', REFRESH_BRANCH);
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});
