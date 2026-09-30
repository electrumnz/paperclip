# Fork branch base policy (Keece fork of Paperclip)

This file is a fork-side rule. Upstream `paperclipai/paperclip` does not have it.
It records one decision so that the next agent does not re-derive it.

Scope: `electrumnz/paperclip` (the fork). Every statement below was measured on
2026-09-30 against fork `master` at `c4d5e2cd82a5fa29a7871b601624ab7194991b37`,
with git 2.55.0.

`master` moves. The counts below are a dated measurement against that pinned
commit, not a permanent property of these pull requests. Re-measure before acting on
them. By 2026-09-30T11:20Z `master` had advanced 2 commits to `9e3ef6f6d`, which
raises each "behind" figure by 2 and leaves the conflict verdicts unchanged.

## The rule

1. Open a new pull request against `master`.
2. If `master` has moved on since you branched, move your branch onto the current
   `master` before you open the pull request.
3. Do not keep a long-lived integration branch as a pull request base.

## Why

A stale base hides `master` fixes from the test run. If the base does not contain
a fix that is already in `master`, the code under test cannot exhibit that fix's
behaviour, so CI can report it as still broken.

This is a statement about what the base contributes to the tested tree, not a claim
that CI tests the base and nothing else. What CI actually checks out is described in
"What CI actually checks out" below, and it matters when reading a red check.

## What CI actually checks out

Read this before treating any red check as a live defect.

The fork's `.github/workflows/pr.yml` is a caller only. It defines one job that
delegates:

```yaml
jobs:
  ci:
    uses: paperclipai/paperclip/.github/workflows/pr-trusted.yml@master
```

In that reusable workflow, none of its nine `actions/checkout` steps sets `ref:`.
Checkout therefore takes GitHub's default for a `pull_request` event: the synthetic
merge ref, a merge of the PR head with the current base tip. The tested tree
contains the head.

So both sides reach the tested tree:

- A base that is behind `master` omits `master` fixes from the tested tree. That
  omission is real and is what this policy prevents.
- The head's own changes are always in the tested tree.

The `gate` job then revalidates that merge rather than trusting it. It fails closed
unless `github.sha` equals the PR's live `merge_commit_sha`, that commit has two
parents with `parents[1]` equal to the head, and the tree matches. It also compares
the triggering base against the live base branch and fails if the base has moved
off the triggering snapshot. A moving base therefore triggers revalidation instead
of passing silently.

One fork-specific caveat. That `gate` validation is scoped to upstream repository id
`1170821064`. The fork is `1371541501`. The routing checks call `fail_closed`, which
emits a runner notice and exits 0, so on the fork the gate selects a GitHub-hosted
runner before it reaches the merge-commit validation. On the fork, read the checkout
model above and do not assume upstream's merge-commit gate applies.

## The 2026-09-27 deadlock was a stale tested tree; its mechanism is not established

Keep these two claims apart. The first is verified. The second is not.

Verified: the fix for the deadlock (`51f661247`, "tolerate 40P01 deadlock in
stale-queue teardown") merged to `master` at 2026-09-27T12:03:38Z. PR #23 then
reported a `40P01` failure at 2026-09-27T12:51:15Z. The tree it ran was pre-fix: the
failed run's own code frame shows the pre-fix fixture, for-loop at line 93 and
`await db.execute` at line 95, where the post-fix file has 104 and 106, and the run
log contains no occurrence of the post-fix helper names. That much is solid, and it
establishes that the red check was not a live defect.

Not established: why the tested tree was pre-fix. A stale base explains it when the
base lacks the fix. It does not explain this instance, because PR #23's base was
`master`, and `master` already contained the fix about 47 minutes before the run.
Nothing recorded at the time establishes the historical base state at the moment of
the run. Do not read the current base of a merged PR as evidence of what the base was
at run time.

The practical rule survives that gap, because it does not depend on this example.
Target `master`, and the tested tree cannot fall behind `master` fixes through the
base. Do not carry this forward as "once bases are `master`, this class of false red
cannot happen". That conclusion is not established by this evidence.

The failure is easy to misread either way. An agent that reads only a red check may
conclude a fix did not work and re-fix code that is already fixed. Check what the
tested tree actually contained before acting.

## Integration branches are still allowed, with one rule

An integration branch is fine as a place to combine several changes before they
become pull requests. It is not fine as a pull request base.

If you need one, state on the branch itself that it must be synced onto the current
`master` before any new pull request is opened from it. That is the whole obligation.
Do not invent a commit-count threshold. A fixed number goes stale without failing, so
it does not prevent anything.

`fork/keece/upstream-master` was the branch that caused the original false red. It
reached 79 commits behind `master`. It no longer exists on the fork. The near
neighbour `fork/keece/upstream-master-mirror` is a read-only upstream mirror at
`01d9a121859a3d8298dce91452f75516e837e819`, 217 commits behind `master`, with no
commits of its own. It is a mirror, not an integration branch.

## Retargeting is not free

Moving a base from behind `master` to `master` is not a rename. Measure before
you do it.

Three open pull requests have a base that is not `master`. All three are stale
against `master`.

| PR | base | commits behind `master` | diff against own base | diff against `master` | merges cleanly |
|---|---|---|---|---|---|
| #13 | `kee-216-reviewbase-master` | 218 | 8 files, +1017/-27 | 8 files, +1017/-27 | no, 3 conflicts |
| #28 | `keece/kee-923` | 222 | 1 file, +124/-10 | 11 files, +1374/-6 | no, 4 conflicts |
| #65 | `keece/kee-1020-mergetest` | 346 | 1 file, +127/-12 | 26 files, +1793/-256 | no, 5 conflicts |

A fourth open pull request, #66, is a separate case and is not in that table. Its
base is already `master`, so it is 0 behind and a retarget cost table has nothing to
say about it. It conflicts for an unrelated reason: `mergeable=CONFLICTING`,
`mergeStateStatus=DIRTY`, 1 conflict against current `master`. GitHub reports #13,
#28 and #65 as `MERGEABLE` because each merges into its own base, which is not the
same question.

"commits behind" counts commits on `master` that the base does not have.

Two things this table shows.

First, the identity that a retarget appears safe is not safety. For #13 the diff
against its own base and against `master` are identical to the line, and
`git merge-base --is-ancestor fork/kee-216-reviewbase-master fork/master` exits 0,
so its base is a strict ancestor of `master`. It still does not merge cleanly.

The cause is ordinary head divergence, not the base. #13's base has zero commits of
its own, so it cannot have "taken a different way" from `master`. What conflicts is
the head against 222 commits of `master`:
`git rev-list --left-right --count fork/master...<head>` gives `222  3`, and
`git merge-base <head> fork/master` is `4ca404b49`. On the contested file
`packages/adapter-utils/src/acpx-engine/execute.ts`, the head's last commit is
`c73cc6a50` ("fix(acpx): create session state owner-only") and `master`'s is
`8ebbcba43` ("fix(acpx): fail a turn whose only output is a provider error
payload"). Both changed the same lines.

Second, a conflict is not a reason to leave a stale base. It is the normal cost of
the branch being old. Resolve it without losing work on either side:

- Where the two sides touch different code, preserve both.
- Where they overlap, the owning seat decides, with a second reviewer. A `master`
  fix is never dropped silently to keep the head's version.

Do not resolve a retarget "in the author's favour" as a blanket rule. For #13, #28
and #65 that would keep the head's `execute.ts` and discard `8ebbcba43`, which is the
outcome this policy exists to prevent.

## How to measure, without installing or building anything

These commands use objects that are already on disk. They do not check out files and
they do not build.

Is a base an ancestor of `master`?

```
git merge-base --is-ancestor <base> fork/master ; echo $?
```

How far behind is it?

```
git rev-list --left-right --count <base>...fork/master
```

How large is the change against each base?

```
git diff --shortstat "$(git merge-base <head> <base>)"...<head>
git diff --shortstat "$(git merge-base <head> fork/master)"...<head>
```

Would it merge cleanly? The three-argument form writes no objects at all, and it is
the form to use when you only need the verdict:

```
git merge-tree "$(git rev-parse <base>^{tree})" "$(git rev-parse <head>^{tree})" \
  "$(git rev-parse "$(git merge-base <base> <head>)"^{tree})"
```

Read the result by its output, not by its exit code. This form exits 0 whether or
not there are conflicts. It reports each contested path with a `changed in both` (or
`added in both`) section; empty output means a clean merge. Verified on this host:
a conflicting pair emits those markers, a clean pair emits none, and the loose
object count did not move.

This form needs git 2.38 or later; this host has 2.55.0.

The two-argument form, `git merge-tree --write-tree --name-only <base> <head>`, is
more convenient because it exits non-zero and prints the conflicting paths, but it
is not read-only: it writes a tree object into the object store. Verified on this
host, the tree it emits for #28 against `master` is
`9536c52c5aeddd638a5ac463a3efbe4430be10ba`, which exists as a loose object in the
shared store and is referenced by zero refs. It touches no worktree, index, HEAD or
ref, so it is safe, but it does leave unreferenced objects behind. Use it when you
want the conflicting paths, and use the three-argument form when you only need the
verdict.

## What not to do

- Do not force-push a shared base branch to move it forward.
- Do not publish anything to upstream `paperclipai/paperclip`.
- Do not merge a base move and an unreviewed change together.
- Do not delete another seat's branch, including a merged one's head.
