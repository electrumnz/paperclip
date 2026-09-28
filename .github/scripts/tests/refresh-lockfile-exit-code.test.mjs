import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../refresh-lockfile-branch.mjs', import.meta.url));
const OWNER = 'electrumnz';

// The exit code is the contract the workflow depends on: `claim_rc` is what
// stops the force-push. Testing only the JSON output would miss a change that
// keeps the JSON right and breaks the status, which is exactly the mutation
// that leaves CI green while the bot pushes over a human's pull request.
function run(stdin, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, REPO_OWNER: OWNER },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

const prs = entries => JSON.stringify(entries);
const onBranch = (author, ref = 'chore/refresh-lockfile-bot') => ({
  url: 'https://github.com/electrumnz/paperclip/pull/1',
  headRefName: ref,
  author: { login: author },
  headRepositoryOwner: { login: OWNER },
});

test('exit code 0 when the branch is free for the bot', async () => {
  const r = await run(prs([]));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).prUrl, '');
});

test('exit code 0 when the bot own pull request is open on the branch', async () => {
  const r = await run(prs([onBranch('github-actions[bot]')]));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).prUrl, 'https://github.com/electrumnz/paperclip/pull/1');
});

test('exit code 3 when a human pull request holds the branch', async () => {
  // This is the whole defect. The workflow reads this status via `claim_rc`
  // and, on 3, claims no branch so the push step is skipped.
  const r = await run(prs([onBranch('somehuman')]));
  assert.equal(r.code, 3, 'a human PR on the bot branch must exit 3 so the push is skipped');
  assert.equal(JSON.parse(r.out).prUrl, '', 'a human PR must never be adopted as the refresh PR');
  assert.match(r.err, /belongs to somehuman/);
});

test('exit code 2 when the pull request list cannot be read', async () => {
  for (const bad of ['not json', '{"a":1}', '"a string"', '42', 'null']) {
    const r = await run(bad);
    assert.equal(r.code, 2, `unreadable input must exit 2, got ${r.code} for ${bad}`);
  }
});

test('exit code 0 for an empty list, which is the normal first-run case', async () => {
  const r = await run('');
  assert.equal(r.code, 0);
});

test('--print-branch exits 0 and names the bot-scoped branch', async () => {
  const r = await run('', ['--print-branch']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), 'chore/refresh-lockfile-bot');
});

test('the exit code and the JSON never disagree about a conflict', async () => {
  // Guards the two channels against drifting: a conflict must always mean a
  // non-zero code, and a non-zero code must always mean conflicts are present.
  const cases = [
    prs([]),
    prs([onBranch('github-actions[bot]')]),
    prs([onBranch('somehuman')]),
    prs([onBranch('somehuman'), onBranch('github-actions[bot]')]),
    prs([onBranch('somehuman', 'chore/refresh-lockfile')]),
  ];
  for (const input of cases) {
    const r = await run(input);
    const plan = JSON.parse(r.out);
    const hasConflict = plan.conflicts.length > 0;
    assert.equal(
      r.code !== 0,
      hasConflict,
      `code ${r.code} and conflicts ${JSON.stringify(plan.conflicts)} disagree for ${input}`,
    );
  }
});
