#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';
import { REFRESH_BRANCH, MANUAL_EXEMPTION_BRANCH } from './refresh-lockfile-branch.mjs';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  // The bot is exempt only on its own branch, or on the legacy plain name while
  // an older refresh PR is still open. The bot on any other branch is not
  // exempt: that keeps a mis-set branch from silently passing the gate. A human
  // is never the bot, on any branch.
  const isRefreshBotAuthor =
    prAuthor === 'github-actions[bot]' &&
    (prBranch === REFRESH_BRANCH || prBranch === MANUAL_EXEMPTION_BRANCH);

  return {
    passed: isRefreshBotAuthor,
    failures: isRefreshBotAuthor ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      `The lockfile is regenerated automatically by the refresh bot on a schedule, on \`${MANUAL_EXEMPTION_BRANCH}\`'s own branch.`,
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
