import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, BOT_AUTHOR } from '../refresh-lockfile-branch.mjs';

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
 * Evaluate a GitHub Actions expression restricted to the forms this guard
 * actually uses: `&&`, `||`, parentheses, `!=`, `==`, and dotted context paths.
 * GitHub coerces a bare value to a boolean: an unset or empty string is false.
 */
function evaluate(expr, context) {
  const lookup = path =>
    path
      .split('.')
      .reduce((acc, key) => (acc == null ? undefined : acc[key]), context);
  const truthy = v => v !== undefined && v !== null && v !== '' && v !== false;

  // Shunting-yard-free approach: this grammar is small, so split on the
  // lowest-precedence operator outside parentheses, respecting `&&` over `||`.
  const stripOuter = s => {
    let t = s.trim();
    while (t.startsWith('(') && t.endsWith(')')) {
      let depth = 0;
      let encloses = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '(') depth++;
        else if (t[i] === ')') {
          depth--;
          if (depth === 0 && i < t.length - 1) { encloses = false; break; }
        }
      }
      if (!encloses) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  };

  const splitTop = (s, op) => {
    const parts = [];
    let depth = 0, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth === 0 && s.startsWith(op, i)) {
        parts.push(cur);
        cur = '';
        i += op.length - 1;
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    return parts.length > 1 ? parts : null;
  };

  const atom = s => {
    const t = s.trim();
    const cmp = t.match(/^(.*?)\s*(==|!=)\s*(.*)$/);
    if (cmp) {
      const val = cmp[1].trim().startsWith("'")
        ? cmp[1].trim().slice(1, -1)
        : lookup(cmp[1].trim());
      const rhs = cmp[3].trim().startsWith("'")
        ? cmp[3].trim().slice(1, -1)
        : lookup(cmp[3].trim());
      return cmp[2] === '==' ? val === rhs : val !== rhs;
    }
    const lit = t.match(/^'(.*)'$/);
    if (lit) return lit[1];
    return truthy(lookup(t));
  };

  const s = stripOuter(expr);
  const orParts = splitTop(s, '||');
  if (orParts) return orParts.some(p => evaluate(p, context));
  const andParts = splitTop(s, '&&');
  if (andParts) return andParts.every(p => evaluate(p, context));
  return atom(s);
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
  const changed = [];
  for (const { author, branch } of CASES) {
    const was = evaluate(OLD, ctx(author, branch));
    const now = stepRuns(author, branch);
    if (was !== now) changed.push(`${author} on ${branch}`);
  }
  assert.deepEqual(
    changed,
    [`${BOT_AUTHOR} on ${REFRESH_BRANCH}`],
    'the guard must change behaviour for the refresh bot on its new branch, and nothing else',
  );
});
