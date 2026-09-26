#!/usr/bin/env node
/**
 * install-worktree-isolation-hook.mjs
 *
 * Installs check-worktree-isolation.mjs as a pre-commit hook.
 *
 * Why this exists (KEE-929): the guard is useless unless a commit actually runs
 * it. A package.json script and a CI lane are both opt-in, so a contributor who
 * never reads the README can still `git commit --amend` inside a worktree that
 * another person owns, and the collision the guard exists to prevent happens
 * anyway.
 *
 * Git cannot commit a hook from a repository, so this installs one into
 * .git/hooks. It writes a small shim rather than copying the guard, so an
 * update to the guard takes effect on the next commit with no re-install.
 *
 * Usage:
 *   node scripts/install-worktree-isolation-hook.mjs            # install
 *   node scripts/install-worktree-isolation-hook.mjs --check    # report only
 *   node scripts/install-worktree-isolation-hook.mjs --uninstall
 *
 * The hook is deliberately not unbypassable: `git commit --no-verify` still
 * skips it. A hook that appears unbypassable teaches --no-verify as a habit,
 * which is worse than an honest opt-out.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const hookPath = path.join(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim(),
  "hooks",
  "pre-commit",
);

// Path to the guard, absolute and forward-slashed so the shim works on every
// platform and does not depend on the hook's own cwd.
const guardPath = path.join(repoRoot, "scripts", "check-worktree-isolation.mjs").split(path.sep).join("/");

const MARKER = "# installed by scripts/install-worktree-isolation-hook.mjs";
const shim = `#!/bin/sh
# ${MARKER}
# One seat owns one worktree. See scripts/check-worktree-isolation.mjs.
# Runs on every commit in every linked worktree of this repository.
node "${guardPath}" "$@"
exit $?
`;

const mode = process.argv[2] || "--install";
const current = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;
const installed = current !== null && current.includes(MARKER);

if (mode === "--check") {
  process.stdout.write(
    installed
      ? `worktree isolation hook: installed at ${hookPath}\n`
      : `worktree isolation hook: NOT installed (${hookPath})\n`,
  );
  process.exit(installed ? 0 : 1);
}

if (mode === "--uninstall") {
  if (!installed) {
    process.stdout.write("worktree isolation hook: nothing to remove\n");
    process.exit(0);
  }
  rmSync(hookPath);
  process.stdout.write(`worktree isolation hook: removed ${hookPath}\n`);
  process.exit(0);
}

if (mode !== "--install") {
  process.stderr.write("Usage: install-worktree-isolation-hook.mjs [--install|--check|--uninstall]\n");
  process.exit(2);
}

// Do not clobber a hook somebody else wrote. A pre-commit hook that already
// exists and is not ours may be doing something important, and overwriting it
// would be a worse failure than a missing guard.
if (current !== null && !installed) {
  process.stderr.write(
    `install-worktree-isolation-hook: ${hookPath} already exists and was not installed by this script.\n` +
      `Refusing to overwrite it. Merge the two hooks by hand, or move it aside first.\n`,
  );
  process.exit(1);
}

if (installed) {
  process.stdout.write(`worktree isolation hook: already installed at ${hookPath}\n`);
  process.exit(0);
}

mkdirSync(path.dirname(hookPath), { recursive: true });
writeFileSync(hookPath, shim, { mode: 0o755 });
process.stdout.write(`worktree isolation hook: installed at ${hookPath}\n`);
