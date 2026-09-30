import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, BOT_AUTHOR } from '../refresh-lockfile-branch.mjs';
import { checkLockfile } from '../check-pr-lockfile.mjs';
import { runInNewContext } from 'node:vm';

const DEPENDABOT = 'dependabot[bot]';
const HUMAN = 'somehuman';

const workflow = readFileSync(
  new URL('../../workflows/pr-trusted.yml', import.meta.url),
  'utf8',
);

// The shipping guard, read out of the YAML rather than copied, so this test
// cannot pass while the file says something else.
const step = workflow
  .split('      - name: Block manual lockfile edits\n')[1]
  ?.split('      - name:')[0];
assert.ok(step, 'the Block manual lockfile edits step must exist');

const expression = step
  .split('        if: >-\n')[1]
  ?.split('\n        run:')[0]
  ?.split('\n')
  .map(line => line.trim())
  .join(' ')
  .trim();
assert.ok(expression, 'the guard must have an if: expression');

/**
 * Evaluate a GitHub Actions expression restricted to the forms this guard uses:
 * `&&`, `||`, parentheses, `==`, `!=`, and string literals.
 *
 * The expression is run through `node:vm`, the same way this repository's other
 * workflow-expression tests do it. A hand-rolled precedence parser got this
 * wrong twice, so the precedence rules now come from the engine instead of from
 * me. GitHub string comparison treats an unset value as an empty string, which
 * is what the loose `==` here gives us for the two comparisons that matter.
 */
function evaluate(expr, context) {
  return runInNewContext(expr, context);
}

const ctx = (author, branch) => ({
  github: {
    head_ref: branch,
    event: { pull_request: { user: { login: author } } },
  },
});

// The step body runs (and the lockfile is hard-failed) when this is true.
const stepRuns = (author, branch) => evaluate(expression, ctx(author, branch));

const CASES = [
  {
    who: `${DEPENDABOT} on its own dependency branch`,
    author: DEPENDABOT,
    branch: 'dependabot/npm_and_pnpm/vitest-4.0.0',
    runs: false,
    why: 'dependabot updates the lockfile to match the bumped manifest and was always exempt',
  },
  {
    who: `${DEPENDABOT} on the manual exemption name`,
    author: DEPENDABOT,
    branch: MANUAL_EXEMPTION_BRANCH,
    runs: false,
    why: 'exempt by both the author clause and the branch clause',
  },
  {
    who: `${BOT_AUTHOR} on the bot branch`,
    author: BOT_AUTHOR,
    branch: REFRESH_BRANCH,
    runs: false,
    why: 'the bot owns its own branch and is the only actor this PR adds an exemption for',
  },
  {
    who: `${BOT_AUTHOR} on the legacy plain branch`,
    author: BOT_AUTHOR,
    branch: MANUAL_EXEMPTION_BRANCH,
    runs: false,
    why: 'an already-open refresh PR keeps working while it drains',
  },
  {
    who: `a human on the manual exemption name`,
    author: HUMAN,
    branch: MANUAL_EXEMPTION_BRANCH,
    runs: false,
    why: 'this is the sanctioned manual exemption and must keep working',
  },
  {
    who: `a human on the bot branch`,
    author: HUMAN,
    branch: REFRESH_BRANCH,
    runs: true,
    why: 'this is the whole defect: a human must not inherit the bot exemption',
  },
  {
    who: `a human on an ordinary branch`,
    author: HUMAN,
    branch: 'fix/some-bug',
    runs: true,
    why: 'CI owns the lockfile, so an ordinary human PR is checked',
  },
];

for (const { who, author, branch, runs, why } of CASES) {
  test(`policy guard: ${who} -> step ${runs ? 'RUNS' : 'is skipped'}`, () => {
    assert.equal(
      stepRuns(author, branch),
      runs,
      `${why} (expression under test: ${expression})`,
    );
  });
}

test('the guard never checks dependabot, whatever the branch', () => {
  // The regression this test exists for: `==` inside a disjunction makes
  // dependabot satisfy the condition, so its lockfile PRs get hard-failed.
  for (const branch of [REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, 'dependabot/npm_and_pnpm/x', 'fix/y']) {
    assert.equal(
      stepRuns(DEPENDABOT, branch),
      false,
      `dependabot must stay exempt on ${branch}; 19 of the last 20 upstream dependabot PRs touch pnpm-lock.yaml`,
    );
  }
});

test('the only author this PR newly exempts is the refresh bot', () => {
  // The guard as it stood before this pull request. The bot on the legacy plain
  // name was already exempt there, so it is not a behaviour change.
  const OLD =
    "(github.head_ref != 'chore/refresh-lockfile') && " +
    "(github.event.pull_request.user.login != 'dependabot[bot]')";

  // Enumerate exhaustively rather than sampling CASES, so a wider change than
  // intended cannot hide behind a list that happens not to include it.
  const authors = [BOT_AUTHOR, DEPENDABOT, HUMAN, 'someother[bot]'];
  const branches = [
    REFRESH_BRANCH,
    MANUAL_EXEMPTION_BRANCH,
    'fix/some-bug',
    'dependabot/npm_and_pnpm/vitest-4.0.0',
  ];
  const changed = [];
  for (const author of authors) {
    for (const branch of branches) {
      if (evaluate(OLD, ctx(author, branch)) !== stepRuns(author, branch)) {
        changed.push(`${author} on ${branch}`);
      }
    }
  }
  assert.deepEqual(
    changed,
    [`${BOT_AUTHOR} on ${REFRESH_BRANCH}`],
    'across every author/branch pair, only the refresh bot on its new branch changes behaviour',
  );
});

test('the YAML guard and check-pr-lockfile.mjs agree on who is exempt from the bot', () => {
  // Scope: the refresh bot. The bot's exemption is the one this pull request
  // moves, so the two gates must agree about it exactly.
  //
  // The two gates are deliberately NOT identical overall, and were not before
  // this change either: the workflow guard exempts dependabot and the plain
  // manual-exemption name for any author, while check-pr-lockfile.mjs exempts
  // only the bot. That gap is pre-existing and out of scope here. Asserting
  // blanket equality would either fail on untouched behaviour or, worse, push
  // me into quietly widening the script's gate.
  const authors = [BOT_AUTHOR, HUMAN, 'someother[bot]'];
  const branches = [REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, 'fix/some-bug'];
  const lockfileFiles = [{ filename: 'pnpm-lock.yaml', status: 'modified' }];
  const disagree = [];
  for (const author of authors) {
    for (const branch of branches) {
      // Only pairs where the script is not blanket-exempting on the branch name.
      if (branch === MANUAL_EXEMPTION_BRANCH && author !== BOT_AUTHOR) continue;
      const yamlChecks = stepRuns(author, branch);
      const scriptExempts = checkLockfile(lockfileFiles, author, branch).passed;
      if (yamlChecks === scriptExempts) disagree.push(`${author} on ${branch}`);
    }
  }
  assert.deepEqual(
    disagree,
    [],
    'the workflow guard and the script gate must agree about the bot exemption',
  );
});
