# Fork branch base policy (Keece fork of Paperclip)

This file is a fork-side rule. Upstream `paperclipai/paperclip` does not have it.
It records one decision so that the next agent does not re-derive it.

Scope: `electrumnz/paperclip` (the fork). Every statement below was measured on
2026-09-30 against fork `master` at `c4d5e2cd82a5fa29a7871b601624ab7194991b37`.

## The rule

1. Open a new pull request against `master`.
2. If `master` has moved on since you branched, move your branch onto the current
   `master` before you open the pull request.
3. Do not keep a long-lived integration branch as a pull request base.

## Why

A pull request base is the code the pull request is tested against. If the base
is behind `master`, the test run cannot see fixes that are already in `master`.

The deadlock investigation of 2026-09-27 merged its fix, `51f661247` ("tolerate
40P01 deadlock in stale-queue teardown"), to `master` at 2026-09-27T12:03:38Z.
PR #23 then reported a `40P01` failure at 2026-09-27T12:51:15Z. The branch under
test structurally could not contain the fix, so the red check was not a live
defect.

The failure is easy to misread. An agent that reads only the red check concludes
that the fix did not work, and re-fixes code that is already fixed.

## Integration branches are still allowed, with one rule

An integration branch is fine as a place to combine several changes before they
become pull requests. It is not fine as a pull request base.

If you need one, put it in `doc/`'s rule above in words as well: state on the
branch itself that it must be synced onto the current `master` before any new
pull request is opened from it. That is the whole obligation. Do not invent a
commit-count threshold. A fixed number goes stale without failing, so it does not
prevent anything.

`fork/keece/upstream-master` was the branch that caused this. It reached 79
commits behind `master`. It no longer exists on the fork. The near neighbour
`fork/keece/upstream-master-mirror` is a read-only upstream mirror at
`01d9a121859a3d8298dce91452f75516e837e819`, 217 commits behind `master`, with no
commits of its own. It is a mirror, not an integration branch.

## Retargeting is not free

Moving a base from behind `master` to `master` is not a rename. Measure before
you do it.

| PR | base | commits behind `master` | diff against own base | diff against `master` | merges cleanly |
|---|---|---|---|---|---|
| #13 | `kee-216-reviewbase-master` | 218 | 8 files, +1017/-27 | 8 files, +1017/-27 | no, 3 conflicts |
| #28 | `keece/kee-923` | 222 | 1 file, +124/-10 | 11 files, +1374/-6 | no, 3 conflicts |
| #65 | `keece/kee-1020-mergetest` | 346 | 1 file, +127/-12 | 26 files, +1793/-256 | no, 5 conflicts |
| #66 | `master` | 0 | 1 file, +60/-13 | 1 file, +60/-13 | no, 1 conflict |

"commits behind" counts commits on `master` that the base does not have.

Two things this table shows.

First, the identity that a retarget appears safe is not safety. For #13 the diff
against its own base and against `master` are identical to the line, and
`git merge-base --is-ancestor` says its base is a strict ancestor of `master`.
It still does not merge cleanly. The base has commits that `master` took a
different way.

Second, a conflict is not a reason to leave a stale base. It is the normal cost
of the branch being old. Resolve it in the author's favour, keep their change,
and get a second review of the result.

## How to measure, without installing or building anything

These commands read objects that are already on disk. They do not check out
files and they do not build.

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

Would it merge cleanly?

```
git merge-tree --write-tree --name-only fork/master <head>
```

`merge-tree` exits 0 on a clean merge and non-zero with the conflicting paths on
stdout when it is not. It needs git 2.38 or later. This host has 2.55.0.

## What not to do

- Do not force-push a shared base branch to move it forward.
- Do not publish anything to upstream `paperclipai/paperclip`.
- Do not merge a base move and an unreviewed change together.
- Do not delete another seat's branch, including a merged one's head.