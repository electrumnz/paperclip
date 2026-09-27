#!/usr/bin/env node
/**
 * refresh-lockfile-branch.mjs
 * Ownership rules for the lockfile refresh bot's working branch.
 *
 * The bot pushes with force to one fixed branch name, so the branch name alone
 * is not proof that a pull request belongs to the bot. A pull request that some
 * other account opened on that branch must be refused: never force-pushed
 * over, never adopted as "the" refresh PR, never auto-merged.
 *
 * The manual lockfile exemption keeps its own plain name for humans. The bot
 * uses a separate, bot-scoped name so the two cannot collide.
 *
 * Export: planRefresh(prs, repoOwner) → { prUrl, conflicts }
 * Export: REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH, BOT_AUTHOR, isRefreshBot
 */
import { fileURLToPath } from 'node:url';

export const REFRESH_BRANCH = 'chore/refresh-lockfile-bot';
export const MANUAL_EXEMPTION_BRANCH = 'chore/refresh-lockfile';
export const BOT_AUTHOR = 'github-actions[bot]';

/** True only for the bot on the bot's own branch. A human on the bot's branch is not the bot. */
export function isRefreshBot(prAuthor, prBranch) {
  return prAuthor === BOT_AUTHOR && prBranch === REFRESH_BRANCH;
}

/**
 * @param {Array<{url?: string, headRefName?: string, author?: {login?: string},
 *                headRepositoryOwner?: {login?: string}}>} prs
 *        Parsed `gh pr list --state open --head <branch> --json ...` output.
 * @param {string} repoOwner The repository the bot pushes to.
 * @returns {{prUrl: string, conflicts: Array<{url?: string, author: string}>}}
 *          `prUrl` is the bot's own open PR to reuse, or '' when there is none.
 *          A non-empty `conflicts` means the caller must stop without pushing.
 */
export function planRefresh(prs, repoOwner) {
  const list = Array.isArray(prs) ? prs : [];
  // Pull requests from another fork cannot collide with a push to this
  // repository's branch, so they are outside this decision.
  const ours = list.filter(
    pr => pr?.headRefName === REFRESH_BRANCH && pr?.headRepositoryOwner?.login === repoOwner
  );
  const mine = ours.filter(pr => pr?.author?.login === BOT_AUTHOR);
  const conflicts = ours
    .filter(pr => pr?.author?.login !== BOT_AUTHOR)
    .map(pr => ({ url: pr?.url, author: pr?.author?.login ?? 'unknown' }));

  return { prUrl: mine[0]?.url ?? '', conflicts };
}

export function leaseValue(remoteSha) {
  // An empty expected SHA means "the ref must not exist remotely yet", which is
  // the correct lease for the bot's first push of a new branch.
  return remoteSha ?? '';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  if (argv[0] === '--print-branch') {
    process.stdout.write(`${REFRESH_BRANCH}\n`);
    return 0;
  }

  const repoOwner = process.env.REPO_OWNER ?? '';
  const raw = await readStdin();
  let prs;
  try {
    prs = JSON.parse(raw.trim() === '' ? '[]' : raw);
  } catch {
    process.stderr.write('::error title=Lockfile refresh::Could not parse the pull request list.\n');
    return 2;
  }
  if (!Array.isArray(prs)) {
    process.stderr.write('::error title=Lockfile refresh::Pull request list was not an array.\n');
    return 2;
  }

  const plan = planRefresh(prs, repoOwner);
  process.stdout.write(`${JSON.stringify(plan)}\n`);

  for (const conflict of plan.conflicts) {
    process.stderr.write(
      `::error title=Lockfile refresh::Refusing to touch ${REFRESH_BRANCH}: pull request ` +
        `${conflict.url} on that branch belongs to ${conflict.author}, not ${BOT_AUTHOR}. ` +
        'The bot will not force-push over it, adopt it, or delete it. ' +
        'Rename the pull request branch or close it, then re-run the workflow.\n'
    );
  }
  return plan.conflicts.length > 0 ? 3 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    });
}
