#!/usr/bin/env bash
# Verify the fork CI posture for electrumnz/paperclip, and prove the
# commitperclip PR Review workflow will not reintroduce a permanently-red check.
#
# Read-only. Does not create, read, or require any credential.
# Exits non-zero if the fork is in a state that will produce misleading signal.
#
# Usage: verify-fork-ci-posture.sh [repo]   (default: electrumnz/paperclip)
# KEE-1036 / KEE-926.

set -euo pipefail

REPO="${1:-electrumnz/paperclip}"
# Use the bare filename: the workflows endpoint 404s on the .github/workflows/
# -prefixed form for this fork, and gh's `workflow view` needs the filename.
WF_FILE="commitperclip-review.yml"
WF_PATH=".github/workflows/$WF_FILE"
# Some calls 404 (fork/upstream visibility differences); never let that abort
# the run, hence the explicit fallback instead of relying on set -e.
WF_STATE=$(gh api "repos/$REPO/actions/workflows/$WF_FILE" --jq '.state' 2>/dev/null || echo unknown)
UPSTREAM_STATE=$(gh api "repos/paperclipai/paperclip/actions/workflows/$WF_FILE" --jq '.state' 2>/dev/null || echo unknown)

echo "repo            : $REPO"
echo "workflow state  : $WF_STATE"
echo "upstream state  : $UPSTREAM_STATE"
echo

rc=0

# 1. The review workflow must not be active without the credential it needs.
#    It is active on the fork only if COMMITPERCLIP_KEY is actually bound.
if [[ "$WF_STATE" == "active" ]]; then
  if gh secret list --repo "$REPO" 2>/dev/null | grep -qx 'COMMITPERCLIP_KEY'; then
    echo "OK   review workflow active AND COMMITPERCLIP_KEY bound"
  else
    echo "FAIL review workflow is ACTIVE but COMMITPERCLIP_KEY is not bound."
    echo "     Every pull_request_target will fail at 'Generate commitperclip token'."
    echo "     Disable it:  gh workflow disable $WF_PATH --repo $REPO"
    rc=1
  fi
else
  echo "OK   review workflow not active (state=$WF_STATE); no credential needed"
fi

# 2. Upstream must stay untouched by fork-side decisions.
if [[ "$UPSTREAM_STATE" != "unknown" && "$UPSTREAM_STATE" != "active" ]]; then
  echo "WARN upstream workflow state is '$UPSTREAM_STATE', expected 'active'."
  echo "     A fork-side action must not have changed upstream."
fi

# 3. No open PR on the fork may still carry a red review check.
#    GitHub reports conclusions in UPPERCASE ("FAILURE"), so compare on that,
#    not on a lowercase guess.
reds=$(gh pr list --repo "$REPO" --state open --limit 100 --json number,statusCheckRollup \
  | jq -r '.[] | select([.statusCheckRollup[]?|select(((.conclusion//"")|ascii_upcase)=="FAILURE" and (.name//"")=="review")]|length>0) | .number' \
  | paste -sd, -)
if [[ -n "$reds" ]]; then
  echo "STALE open PRs still reporting a red review check: $reds"
  echo "     These are pre-disable PRs. Their mergeStateStatus is noise, not signal."
else
  echo "OK   no open PR reports a red review check"
fi

# 4. Report the live distribution so a human can eyeball whether signal is real.
echo
echo "open PR mergeStateStatus distribution:"
gh pr list --repo "$REPO" --state open --limit 100 --json number,mergeStateStatus \
  | jq -r 'group_by(.mergeStateStatus)[] | "  \(.[0].mergeStateStatus): \(length)  (#\([.[].number]|join(", #")))"'

echo
[[ $rc -eq 0 ]] && echo "RESULT: pass" || echo "RESULT: FAIL"
exit $rc
