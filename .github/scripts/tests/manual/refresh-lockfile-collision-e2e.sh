#!/usr/bin/env bash
# End-to-end proof for KEE-1025.
#
# Runs the two real shell blocks from .github/workflows/refresh-lockfile.yml
# against a real local git remote, with `gh` and `jq` stubbed. Proves that a
# human PR on the bot branch stops the run before the force-push, and that the
# normal path still pushes and reuses the bot's own PR.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/refresh-lockfile-branch.mjs"
WORK="$(mktemp -d)"
trap 'echo "$WORK" > /tmp/kee1025-wd' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1: expected [$3] got [$2]"
    fail=$((fail + 1))
  fi
}

# Extract the `run:` body of a step from the workflow, so we exercise the text
# that actually ships rather than a copy of it. GitHub expressions are not
# valid bash, so they are resolved to the values a real run would provide.
block() {
  local start end
  start="$(grep -n -- "- name: $1\$" "$REPO_ROOT/.github/workflows/refresh-lockfile.yml" | head -1 | cut -d: -f1)"
  [ -n "$start" ] || return 1
  end="$(awk -v s="$start" 'NR > s && /- name: / { print NR; exit }' "$REPO_ROOT/.github/workflows/refresh-lockfile.yml")"
  [ -n "$end" ] || end="$(wc -l < "$REPO_ROOT/.github/workflows/refresh-lockfile.yml")"

  local run_line
  run_line="$(awk -v s="$start" -v e="$end" 'NR > s && NR < e && /^[[:space:]]*run: \|/ { print NR; exit }' \
    "$REPO_ROOT/.github/workflows/refresh-lockfile.yml")"
  [ -n "$run_line" ] || return 1

  # De-indent the block scalar body, then resolve GitHub expressions.
  sed -n "$((run_line + 1)),$((end - 1))p" "$REPO_ROOT/.github/workflows/refresh-lockfile.yml" \
    | sed -e 's/^          //' \
    | sed -e "s#\${{ steps.branch-claim.outputs.branch }}#\$BRANCH#g" \
          -e "s#\${{ steps.branch-claim.outputs.pr_url }}#\$PR_URL#g" \
          -e "s#\${{ steps.branch-claim.outputs.expected }}#\$EXPECTED#g" \
          -e "s#\${{ steps.upsert-pr.outputs.pr_url }}#\$PR_URL#g"
}

block 'Claim the refresh branch or refuse' > "$WORK/claim.sh"
block 'Create or update pull request' > "$WORK/push.sh"

if ! grep -q 'refresh-lockfile-branch.mjs' "$WORK/claim.sh"; then
  echo "  FAIL could not extract the claim step from the workflow"
  exit 1
fi
if ! grep -q 'git push --force' "$WORK/push.sh"; then
  echo "  FAIL could not extract the push step from the workflow"
  exit 1
fi

# In a real run the working directory is the repository checkout, so the step
# resolves the script by a relative path. Give the throwaway repo that same
# shape by copying the shipping script into it, so this exercises the real text.
make_remote() {
  local dir="$1"
  git init --bare -q "$dir/remote.git"
  git init -q "$dir/work"
  git -C "$dir/work" config user.name tester
  git -C "$dir/work" config user.email tester@example.com
  mkdir -p "$dir/work/.github/scripts"
  cp "$SCRIPT" "$dir/work/.github/scripts/refresh-lockfile-branch.mjs"
  echo base > "$dir/work/pnpm-lock.yaml"
  git -C "$dir/work" add -A
  git -C "$dir/work" commit -qm base
  git -C "$dir/work" remote add origin "$dir/remote.git"
  git -C "$dir/work" push -q origin HEAD:refs/heads/master
}

make_gh() {
  local dir="$1" prs="$2"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/gh" <<EOF
#!/usr/bin/env bash
case "\$1 \$2" in
  "pr list")
    if [ "\${GH_TEST_CREATE:-0}" = "1" ]; then echo '[{"url":"https://example/created","headRefName":"chore/refresh-lockfile-bot","author":{"login":"github-actions[bot]"},"headRepositoryOwner":{"login":"OWNER"}}]'
    else cat <<'JSON'
$prs
JSON
    fi ;;
  "pr create") echo "https://github.com/OWNER/paperclip/pull/999" ;;
  *) echo "unexpected gh invocation: \$*" >&2; exit 1 ;;
esac
EOF
  chmod +x "$dir/bin/gh"
  PATH="$dir/bin:$PATH"
  export PATH
}

# A real run reaches the push step with `pnpm install --resolution-only` having
# already rewritten the lockfile in the working tree, and nothing staged: the
# step's own guard is `git diff --quiet -- pnpm-lock.yaml`, which compares the
# worktree against the index. Staging here would make that guard see no delta
# and the step would exit before the push.
stage_lockfile_delta() {
  local dir="$1"
  echo "lockfileVersion: 9.0" > "$dir/work/pnpm-lock.yaml"
  git -C "$dir/work" status --porcelain -- pnpm-lock.yaml
}

OWNER=OWNER

echo "Case 1: a human PR holds the bot branch"
D="$WORK/case1"; mkdir -p "$D"; make_remote "$D"
B="chore/refresh-lockfile-bot"
git -C "$D/work" checkout -q -b "$B"
echo human > "$D/work/human-file.txt"
git -C "$D/work" add -A; git -C "$D/work" commit -qm "human work"
git -C "$D/work" push -q origin "$B"
HUMAN_SHA="$(git -C "$D/work" rev-parse HEAD)"
make_gh "$D" "[{\"url\":\"https://github.com/OWNER/paperclip/pull/42\",\"headRefName\":\"$B\",\"author\":{\"login\":\"somehuman\"},\"headRepositoryOwner\":{\"login\":\"$OWNER\"}}]"

out="$(cd "$D/work" && GITHUB_OUTPUT="$D/out" REPO_OWNER="$OWNER" GH_TEST_CREATE=0 \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null >"$D/log" 2>"$D/err")"
rc=$?
branch_out="$(grep '^branch=' "$D/out" 2>/dev/null | cut -d= -f2- || true)"

# Assert the step's own outcome, not just the branch value. A step that dies
# under `bash -e` also yields an empty branch, so the branch alone cannot tell
# "reported success and claimed nothing" apart from "never ran to end".
check "claim step exits 0, so the scheduled master job stays green" "$rc" "0"
check "claim step wrote GITHUB_OUTPUT at all" "$([ -f "$D/out" ] && echo yes || echo no)" "yes"
check "claim step claims no branch" "$branch_out" ""
check "claim step warns about the human PR" "$(grep -c 'belongs to somehuman' "$D/err" | tr -d ' ')" "1"
# The workflow's own notice goes to stdout; the script's ::error goes to stderr.
check "claim step reports it as a notice, not an error" \
  "$(grep -c '^::notice' "$D/log" | tr -d ' ')" "1"

# The push step is gated on a non-empty branch, exactly as in the workflow.
if [ -n "$branch_out" ]; then
  (cd "$D/work" && GITHUB_OUTPUT="$D/out2" bash -euo pipefail "$WORK/push.sh") >/dev/null 2>&1
  echo "  FAIL push step ran despite a conflict"
  fail=$((fail + 1))
else
  echo "  ok   push step is skipped, so nothing is force-pushed"
  pass=$((pass + 1))
fi
REMOTE_SHA="$(git -C "$D/remote.git" rev-parse "refs/heads/$B" 2>/dev/null || echo missing)"
check "the human commit still exists on the remote" "$REMOTE_SHA" "$HUMAN_SHA"

echo "Case 2: the bot's own PR is open on the bot branch"
D="$WORK/case2"; mkdir -p "$D"; make_remote "$D"
git -C "$D/work" checkout -q -b "$B"; echo bot > "$D/work/bot.txt"
git -C "$D/work" add -A; git -C "$D/work" commit -qm bot
git -C "$D/work" push -q origin "$B"
make_gh "$D" "[{\"url\":\"https://github.com/OWNER/paperclip/pull/7\",\"headRefName\":\"$B\",\"author\":{\"login\":\"github-actions[bot]\"},\"headRepositoryOwner\":{\"login\":\"$OWNER\"}}]"

out="$(cd "$D/work" && GITHUB_OUTPUT="$D/out" REPO_OWNER="$OWNER" GH_TEST_CREATE=0 \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null 2>"$D/err")"
check "branch is claimed" "$(grep '^branch=' "$D/out" | cut -d= -f2-)" "$B"
check "the bot own PR is reused" "$(grep '^pr_url=' "$D/out" | cut -d= -f2-)" "https://github.com/OWNER/paperclip/pull/7"

echo "Case 3: no PR open, the bot pushes and creates one"
D="$WORK/case3"; mkdir -p "$D"; make_remote "$D"
make_gh "$D" "[]"
(cd "$D/work" && GITHUB_OUTPUT="$D/out" REPO_OWNER="$OWNER" GH_TEST_CREATE=0 \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null 2>"$D/err") >/dev/null
check "branch is claimed with no PR" "$(grep '^branch=' "$D/out" | cut -d= -f2-)" "$B"
check "no PR to reuse yet" "$(grep '^pr_url=' "$D/out" | cut -d= -f2-)" ""
check "the lease is empty because the branch does not exist yet" \
  "$(grep '^expected=' "$D/out" | cut -d= -f2-)" ""

# The branch does not exist yet, so an empty lease must let the push create it.
stage_lockfile_delta "$D"
(cd "$D/work" && GITHUB_OUTPUT="$D/out2" REPO_OWNER="$OWNER" \
  BRANCH="$B" PR_URL="" EXPECTED="" \
  bash -euo pipefail "$WORK/push.sh" < /dev/null >"$D/push.log" 2>&1)
check "the push created the branch" \
  "$(git -C "$D/remote.git" rev-parse "refs/heads/$B" 2>/dev/null || echo missing)" \
  "$(git -C "$D/work" rev-parse HEAD)"

echo "Case 4: a PR from another fork is ignored, not treated as a conflict"
make_gh "$WORK/case3" "[{\"url\":\"https://github.com/someone/paperclip/pull/5\",\"headRefName\":\"$B\",\"author\":{\"login\":\"somehuman\"},\"headRepositoryOwner\":{\"login\":\"someone-else\"}}]"
out="$(cd "$WORK/case3/work" && GITHUB_OUTPUT="$WORK/case3/fork-out" REPO_OWNER="$OWNER" \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null 2>"$WORK/case3/err")"
check "a fork PR does not block the run" "$(grep '^branch=' "$WORK/case3/fork-out" | cut -d= -f2-)" "$B"
check "a fork PR is not adopted" "$(grep '^pr_url=' "$WORK/case3/fork-out" | cut -d= -f2-)" ""

# A human commit that lands after the claim step is invisible to `gh pr list`,
# so the claim already authorised the branch. The lease is the only thing left
# between the bot and that commit. The reviewer reproduced the loss with a bare
# --force; this case proves the lease refuses the push instead.
echo "Case 5: a human commit that lands after the claim is protected by the lease"
D="$WORK/case5"; mkdir -p "$D"; make_remote "$D"
make_gh "$D" "[]"

(cd "$D/work" && GITHUB_OUTPUT="$D/out" REPO_OWNER="$OWNER" \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null 2>"$D/err") >/dev/null
LEASE="$(grep '^expected=' "$D/out" | cut -d= -f2-)"
check "the branch does not exist at claim time" "$LEASE" ""

# A human pushes to the same branch with no pull request open.
git -C "$D/work" checkout -q -b "$B"
echo human > "$D/work/human-file.txt"
git -C "$D/work" add -A; git -C "$D/work" commit -qm "human work, no PR"
git -C "$D/work" push -q origin "$B"
HUMAN_SHA="$(git -C "$D/work" rev-parse HEAD)"

# The bot's push still holds the stale lease, so it must be refused.
stage_lockfile_delta "$D"
(cd "$D/work" && GITHUB_OUTPUT="$D/out2" REPO_OWNER="$OWNER" \
  BRANCH="$B" PR_URL="" EXPECTED="$LEASE" \
  bash -euo pipefail "$WORK/push.sh" < /dev/null >"$D/push.log" 2>&1)
push_rc=$?
if [ "$push_rc" -ne 0 ]; then
  echo "  ok   the push was refused (rc=$push_rc): $(grep -ioE "stale info|force-with-lease|rejected|non-fast-forward" "$D/push.log" | head -1)"
  pass=$((pass + 1))
else
  echo "  FAIL the push was not refused; the human commit was overwritten"
  fail=$((fail + 1))
fi
check "the human commit still exists on the remote" \
  "$(git -C "$D/remote.git" rev-parse "refs/heads/$B" 2>/dev/null || echo missing)" "$HUMAN_SHA"

echo "Case 6: an unreadable pull request list fails closed, as a warning"
D="$WORK/case6"; mkdir -p "$D"; make_remote "$D"
# `gh` returns something that is not JSON, so the script exits 2, not 3.
mkdir -p "$D/bin"
cat > "$D/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "pr list") echo "this is not json" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$D/bin/gh"
export PATH="$D/bin:$PATH"

(cd "$D/work" && GITHUB_OUTPUT="$D/out" REPO_OWNER="$OWNER" \
  bash -euo pipefail "$WORK/claim.sh" < /dev/null >"$D/log" 2>"$D/err") >/dev/null
rc=$?
check "an unreadable list also exits 0" "$rc" "0"
check "an unreadable list claims no branch" \
  "$(grep '^branch=' "$D/out" 2>/dev/null | cut -d= -f2- || true)" ""
check "an unreadable list is reported as a warning, not a false conflict" \
  "$(grep -c '^::warning' "$D/log" | tr -d ' ')" "1"
check "an unreadable list does not claim a non-bot pull request exists" \
  "$(grep -c 'has a non-bot pull request' "$D/log" | tr -d ' ')" "0"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
