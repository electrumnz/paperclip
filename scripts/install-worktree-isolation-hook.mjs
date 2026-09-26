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
 * The shim does NOT simply point at this worktree's copy of the guard. The
 * guard only exists on branches that carry it, and on this host 118 of 119
 * worktree HEADs do not have it -- including paperclip-kee-923, the worktree the
 * whole card is about. A shim that resolved the guard from the committing
 * checkout would therefore fail open on exactly the worktrees that need the
 * guard most, which is the same "check that always passes" outcome as the
 * version-1 bug. So the installer also stores a copy in the common git dir, and
 * the shim prefers the checkout's copy and falls back to the stored one.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
}).trim();

const hookPath = path.join(commonDir, "hooks", "pre-commit");

// The copy the shim falls back to. It lives beside the hook, in the common git
// dir, so every linked worktree of this repository reaches the same file and it
// survives the removal of whichever worktree happened to run the installer.
const storedGuardPath = path.join(commonDir, "hooks", "worktree-isolation-guard.mjs");

// Path to the guard in this checkout, absolute and forward-slashed so the shim
// works on every platform and does not depend on the hook's own cwd.
const guardPath = path.join(repoRoot, "scripts", "check-worktree-isolation.mjs").split(path.sep).join("/");

const MARKER = "# installed by scripts/install-worktree-isolation-hook.mjs";
const shim = `#!/bin/sh
# One seat owns one worktree. See scripts/check-worktree-isolation.mjs.
# Runs on every commit in every linked worktree of this repository.
#
${MARKER}
#
# Resolution order, in order of freshness:
#   1. KEE_WORKTREE_ISOLATION_GUARD, for an explicit override
#   2. the copy in the checkout being committed to
#   3. the copy stored beside this hook in the common git dir
#
# Step 2 is not the only step on purpose. The guard exists on branches that
# carry it, and most worktree HEADs do not, so a shim that stopped at step 2
# would find no guard and allow the commit -- failing open precisely on the
# shared pre-isolation worktrees this exists to protect. Step 3 is why that
# does not happen.
GUARD="\${KEE_WORKTREE_ISOLATION_GUARD:-}"
if [ -z "$GUARD" ]; then
  TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || TOPLEVEL=""
  if [ -n "$TOPLEVEL" ] && [ -f "$TOPLEVEL/scripts/check-worktree-isolation.mjs" ]; then
    GUARD="$TOPLEVEL/scripts/check-worktree-isolation.mjs"
  elif [ -f "${storedGuardPath}" ]; then
    GUARD="${storedGuardPath}"
  fi
fi

if [ -z "$GUARD" ]; then
  # No guard to run. This is not allowed to be silent: a hook that exits 0
  # having decided nothing is exactly the defect this card is about. It warns
  # loudly on every commit and still exits 0, because the alternative is
  # refusing every commit in a checkout that has never had the guard, which
  # would look like the tool is broken and would be worked around with
  # --no-verify within a day.
  echo "check-worktree-isolation: NO GUARD FOUND, seat isolation is NOT being enforced." >&2
  echo "  cwd:         $(pwd)" >&2
  echo "  expected at: ${storedGuardPath}" >&2
  echo "  Run: node scripts/install-worktree-isolation-hook.mjs" >&2
  exit 0
fi

node "$GUARD" "\$@"
exit \$?
`;

const mode = process.argv[2] || "--install";
const current = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;
const installed = current !== null && current.includes(MARKER);

if (mode === "--check") {
  const guardPresent = installed && existsSync(storedGuardPath);
  process.stdout.write(
    guardPresent
      ? `worktree isolation hook: installed at ${hookPath} (guard ${storedGuardPath})\n`
      : installed
        ? `worktree isolation hook: hook installed at ${hookPath} but NO STORED GUARD at ${storedGuardPath}; commits fall back to the checkout only\n`
        : `worktree isolation hook: NOT installed (${hookPath})\n`,
  );
  process.exit(guardPresent ? 0 : 1);
}

if (mode === "--uninstall") {
  if (!installed) {
    process.stdout.write("worktree isolation hook: nothing to remove\n");
    process.exit(0);
  }
  rmSync(hookPath);
  rmSync(storedGuardPath, { force: true });
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

if (!existsSync(guardPath)) {
  process.stderr.write(
    `install-worktree-isolation-hook: no guard at ${guardPath}.\n` +
      `Nothing to store. Run this from a checkout that has scripts/check-worktree-isolation.mjs.\n`,
  );
  process.exit(1);
}

if (installed) {
  // Re-install rather than skip: the stored guard may be older than the
  // checkout's copy, and this is the only thing that keeps it fresh for
  // worktrees whose own HEAD does not carry the guard.
  copyFileSync(guardPath, storedGuardPath);
  process.stdout.write(
    `worktree isolation hook: already installed at ${hookPath}; guard refreshed at ${storedGuardPath}\n`,
  );
  process.exit(0);
}

mkdirSync(path.dirname(hookPath), { recursive: true });
writeFileSync(hookPath, shim, { mode: 0o755 });
copyFileSync(guardPath, storedGuardPath);
process.stdout.write(
  `worktree isolation hook: installed at ${hookPath}\n` +
    `worktree isolation guard: stored at ${storedGuardPath}\n`,
);
