#!/usr/bin/env bash
# Verify the fork CI posture for electrumnz/paperclip, and prove the
# commitperclip PR Review workflow will not reintroduce a permanently-red check.
#
# Read-only. Every gh call below is a read: `gh api` (GET), `gh secret list`,
# `gh pr list`. It never writes a secret, never enables or disables a workflow,
# and never sends a write to upstream. The `gh workflow disable ...` line it
# prints is advice for a human to run, not something it runs.
#
# Exit status is 0 only when every assertion is positively verified:
#   0  verified OK
#   1  an assertion FAILED, or a lookup was denied/unavailable/unrecognised
# An unknown state is never reported as OK. A guard that cannot fail is worse
# than no guard, so "could not check" and "checked and fine" are different
# results and only the second one exits 0.
#
# Usage: verify-fork-ci-posture.sh [repo]   (default: electrumnz/paperclip)
# KEE-1036 / KEE-926.

set -uo pipefail

REPO="${1:-electrumnz/paperclip}"
UPSTREAM_REPO="paperclipai/paperclip"
# Use the bare filename: the workflows endpoint 404s on the .github/workflows/
# -prefixed form for this fork, and gh's `workflow view` needs the filename.
WF_FILE="commitperclip-review.yml"
WF_PATH=".github/workflows/$WF_FILE"
SECRET_NAME="COMMITPERCLIP_KEY"

rc=0

fail() { echo "$@"; rc=1; }

# States GitHub can report for a workflow. Anything else is unrecognised and is
# treated as unverified rather than quietly accepted.
KNOWN_STATES="active disabled_manually disabled_inactivity disabled_fork"

# LOOKUP_STATUS: ok | missing | unavailable | unrecognised
# LOOKUP_STATE:  the reported state, or "" when there is nothing trustworthy.
# A 404 is separated from a denied/unavailable lookup because "this fork has no
# such workflow" and "I was not allowed to look" are different findings.
lookup_state() {
  local repo="$1" combined
  if combined=$(gh api "repos/$repo/actions/workflows/$WF_FILE" --jq '.state' 2>&1); then
    LOOKUP_STATE="$combined"
    local candidate
    for candidate in $KNOWN_STATES; do
      if [[ "$combined" == "$candidate" ]]; then
        LOOKUP_STATUS="ok"
        return 0
      fi
    done
    LOOKUP_STATUS="unrecognised"
    return 0
  fi
  LOOKUP_STATE=""
  if grep -qiE 'HTTP 404|Not Found' <<<"$combined"; then
    LOOKUP_STATUS="missing"
  else
    LOOKUP_STATUS="unavailable"
  fi
  return 0
}

# Prints one secret name per line, and never a value.
# `--json name` is tried first so only names are ever requested. A gh build
# that does not support it falls back to the plain listing, whose lines are
# "NAME<TAB>UPDATED". Both are cut at the tab so matching stays exact-name
# whichever shape comes back: `grep -qx` against a tabbed line can never
# match, which would read a bound secret as missing.
secret_names() {
  local raw
  if raw=$(gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null); then
    printf '%s\n' "$raw" | cut -f1
    return 0
  fi
  if raw=$(gh secret list --repo "$REPO" 2>/dev/null); then
    printf '%s\n' "$raw" | cut -f1
    return 0
  fi
  return 1
}

echo "repo            : $REPO"
echo

# 1. The review workflow must not be active without the credential it needs.
#    Active without COMMITPERCLIP_KEY is the exact regression from KEE-1036:
#    every pull_request_target fails at "Generate commitperclip token".
lookup_state "$REPO"
WF_STATE="$LOOKUP_STATE"
WF_LOOKUP="$LOOKUP_STATUS"
lookup_state "$UPSTREAM_REPO"
UPSTREAM_STATE="$LOOKUP_STATE"
UPSTREAM_LOOKUP="$LOOKUP_STATUS"
echo "workflow state  : ${WF_STATE:-<none>} (lookup: $WF_LOOKUP)"
echo "upstream state  : ${UPSTREAM_STATE:-<none>} (lookup: $UPSTREAM_LOOKUP)"
echo

case "$WF_LOOKUP" in
  ok)
    if [[ "$WF_STATE" == "active" ]]; then
      if secret_names | grep -Fxq -- "$SECRET_NAME"; then
        echo "OK   review workflow active AND $SECRET_NAME bound"
      else
        fail "FAIL review workflow is ACTIVE but $SECRET_NAME is not bound."
        echo "     Every pull_request_target will fail at 'Generate commitperclip token'."
        echo "     Disable it:  gh workflow disable $WF_PATH --repo $REPO"
      fi
    else
      echo "OK   review workflow not active (state=$WF_STATE); no credential needed"
    fi
    ;;
  missing)
    fail "UNVERIFIED the review workflow is not present at $WF_PATH on $REPO."
    echo "          This guard assumes the commitperclip review workflow exists here."
    echo "          If it was deleted or renamed, the posture it describes is no longer"
    echo "          the posture this fork is in, and that needs a human decision."
    ;;
  unrecognised)
    fail "UNVERIFIED the review workflow reported state '$WF_STATE', which is not a"
    echo "          state this guard knows ($KNOWN_STATES). Not treated as disabled."
    ;;
  *)
    fail "UNVERIFIED the review workflow state could not be read from $REPO"
    echo "          (lookup $WF_LOOKUP: denied, unauthenticated, or gh/network error)."
    echo "          This is NOT the same as the workflow being disabled. Re-run with a"
    echo "          token that can read repos/$REPO/actions/workflows."
    ;;
esac

# 2. Upstream must stay untouched by fork-side decisions. A fork-side action
#    that changed upstream is an integrity problem, and an unreadable upstream
#    is an unverified claim rather than a clean bill of health.
case "$UPSTREAM_LOOKUP" in
  ok)
    if [[ "$UPSTREAM_STATE" == "active" ]]; then
      echo "OK   upstream review workflow still active"
    else
      fail "FAIL upstream review workflow state is '$UPSTREAM_STATE', expected 'active'."
      echo "     A fork-side action must not have changed $UPSTREAM_REPO."
    fi
    ;;
  missing)
    echo "WARN upstream has no $WF_PATH; upstream and fork have diverged."
    echo "     Not a fork-side write, but this guard's assumption needs review."
    ;;
  unrecognised)
    fail "UNVERIFIED upstream review workflow reported state '$UPSTREAM_STATE'."
    ;;
  *)
    fail "UNVERIFIED the upstream review workflow state could not be read"
    echo "          (lookup $UPSTREAM_LOOKUP). Upstream immutability is unconfirmed."
    ;;
esac

# 3. No open PR on the fork may still carry a red review check.
#    GitHub reports conclusions in UPPERCASE ("FAILURE"), so compare on that,
#    not on a lowercase guess. Informational: these are pre-disable PRs whose
#    rollup can no longer go green, not a defect in a new change.
#    mergeStateStatus must be requested here as well as the rollup: it is read
#    back in step 4, and gh omits any field that was not asked for, so leaving
#    it out silently turns the distribution below into 27 "null" entries.
pr_rollup=$(gh pr list --repo "$REPO" --state open --limit 100 --json number,mergeStateStatus,statusCheckRollup 2>/dev/null)
if [[ -z "$pr_rollup" ]]; then
  fail "UNVERIFIED open PRs could not be listed on $REPO; the red-check survey did not run."
else
  reds=$(jq -r '.[] | select([.statusCheckRollup[]?|select(((.conclusion//"")|ascii_upcase)=="FAILURE" and (.name//"")=="review")]|length>0) | .number' \
    <<<"$pr_rollup" | paste -sd, -)
  if [[ -n "$reds" ]]; then
    echo "STALE open PRs still reporting a red review check: $reds"
    echo "     These are pre-disable PRs. Their mergeStateStatus is noise, not signal."
  else
    echo "OK   no open PR reports a red review check"
  fi

  # 4. Report the live distribution so a human can eyeball whether signal is real.
  echo
  echo "open PR mergeStateStatus distribution:"
  jq -r 'group_by(.mergeStateStatus)[] | "  \(.[0].mergeStateStatus): \(length)  (#\([.[].number]|join(", #")))"' \
    <<<"$pr_rollup"
fi

echo
if [[ $rc -eq 0 ]]; then
  echo "RESULT: pass (every check positively verified)"
else
  echo "RESULT: FAIL (at least one check failed or could not be verified)"
fi
exit $rc
