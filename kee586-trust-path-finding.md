# KEE-586 — trust-path finding for the third unscoped run class

Reconciled against the **deployed artifact**, not the merge: the running install is
git `f3003d3adc6c` (`~/.paperclip/cli/current -> installs/git/f3003d3adc6c`).

## 0. Reconciliation first: KEE-540 is NOT in the running artifact

`grep -c board_automation` against the deployed
`node_modules/@paperclipai/server/dist/services/cross-issue-influence-limit.js` returns **0**.
`grep -c readUnscopedRunSourceKind` returns **0**.

The deployed predicate is the pre-KEE-529 two-case function
(`isUnscopedHeartbeatTimerRun` → boolean, `heartbeat_timer` or `null`). The
KEE-529 commit that introduced `readUnscopedRunSourceKind()` and the
`board_automation` kind (`67e88e1160`) is **not an ancestor of f3003d3**:

```
$ git merge-base --is-ancestor 67e88e1160 HEAD   -> NO
$ git merge-base --is-ancestor 24d2607efc HEAD   -> YES   # that merge is only the 403 copy, KEE-540
```

What *did* land from KEE-540 was the shared 403 copy
(`13b937499f`, "name the no-anchor case") — a string change in
`packages/shared/src/issue-write-denial.ts`, not the predicate. So the board was
right that the merge and the artifact disagreed, and this time the reason is
different from the KEE-540 install: **the predicate was never merged into
fork/master at all.** It existed only as a hot-patch on the old npm
`2026.831.1` install (`~/Work/kee540-deploy.sh` line 17 patched the `.js`
directly). When the service moved to a git install on 2026-10-01 08:19, that
hot-patch was not carried over and the deployed behaviour silently regressed to
the pre-KEE-529 guard.

Consequence: `board_automation` writes stopped being recorded on 2026-09-17
08:50 (`max(created_at)` over `details->>'sourceKind'='board_automation'`), and
every board-dispatched automation wake since has been refused exactly as
`on_demand` is. **The card's premise — "2 of 3 classes admitted" — is not true of
the running install. All three are refused.**

Measured over the last 20 days of board-dispatched unscoped wakes:

| day | automation | on_demand |
|---|---|---|
| 09-16 | 41 | 1 |
| 09-17 | 114 (20 cross-issue rows — the hot-patch window) | 7 |
| 09-18 | 82 | 9 |
| 09-24 | 3 | 0 |
| 09-25 | 2 | 2 |
| 09-26 | 7 | 0 |
| 09-29 | 0 | 1 |
| 10-01 | 0 | 1 |

## 1. Who can cause an `on_demand` board wake?

This is step 1 of the card and it gates the rest.

**An agent cannot make one.** `triggeredBy` is written from
`req.actor.type`, never from the request body:

- `server/src/routes/agents.ts:5964` (`/agents/:id/wakeup`) and `:6070`
  (legacy `/heartbeat/invoke`) both set
  `contextSnapshot.triggeredBy = req.actor.type`.
- `req.actor.type` is set in `server/src/middleware/auth.ts` and is one of
  `board` / `agent` / `none`, resolved from the credential: board API key,
  Better Auth session, local-trusted implicit board, agent JWT, or agent API key.
- An agent hitting either route is additionally constrained — wakeup requires
  `req.actor.agentId === id` (`:5792`), the legacy route returns 403 otherwise
  (`:6042`).

`wakeReason` is attacker-shaped (free text, e.g. the long KEE-1090 unblock-owner
instruction in run `1a2b6bae-ea8f-...`), so it is not a trust signal.
`wakeSource` is server-derived from `source` (heartbeat.ts:7141).

**But `triggeredBy` in `contextSnapshot` is still the wrong thing to key on**,
and this is the substantive security finding.

`contextSnapshot` is a JSON blob that a wake caller partially controls, and it is
carried through the deferred/promoted wake queue. `triggeredBy` is only
server-derived at the *route* boundary; downstream the blob is copied wholesale:

- `enqueueWakeup` seeds `contextSnapshot` from `opts.contextSnapshot`
  (heartbeat.ts:26540) and `enrichWakeContextSnapshot` mutates it in place
  (`:7090`). The wake route builds that seed server-side, but
- the **deferred** path stores the whole seed at
  `payload['_paperclipWakeContext']` (heartbeat.ts:27551), and promotion
  re-seeds the promoted run's context from that stored blob
  (`modules/wake-queue/application/use-cases.ts:409,422`), and
- `heartbeat.ts:10582` re-writes `triggeredBy: "board"` on an **operator** wake.

So `contextSnapshot.triggeredBy` is *usually* server-derived, but its integrity
on the read path is not enforced anywhere, and it is not the authoritative
record.

**The authoritative, non-forgeable initiator record already exists as
first-class columns** and the guard should key on those instead:
`heartbeat_runs.wakeup_request_id` → `agent_wakeup_requests.requested_by_actor_type`
/ `requested_by_actor_id`. These are set by the service, not from a payload
(heartbeat.ts:26644, :26731, :26934, :27093, :27558 …), and the wake route
already refuses to start a run with `requestedByActorType !== "user"` for the
manual/board cases (`:26551`, `:26619`).

Measured cross-tab over every run that has a wakeup request
(`contextSnapshot.triggeredBy` vs authoritative `requested_by_actor_type`):

| ctx `triggeredBy` | authoritative actor type | rows |
|---|---|---|
| (null) | system | 2451 |
| (null) | agent | 2024 |
| (null) | user | 614 |
| board | user | 609 |
| board | **system** | **285** |
| agent | agent | 4 |
| agent | user | 3 |

Two things follow, and both matter:

1. **`board` ≠ `user`.** 285 runs carry `triggeredBy: "board"` in their context
   while the authoritative row says the request came from `system`. Those are
   the internal scheduler-issued board-attributed wakes (breakdown:
   `automation/automation` 202, `automation/on_demand` 79, plus a handful of
   timer rows). Keying on `contextSnapshot.triggeredBy === "board"` admits
   control-plane wakes too, which is broader than "a human or operator tool
   triggered this". Keying on the authoritative `requested_by_actor_type = "user"`
   admits exactly the operator-initiated ones.

2. **`triggeredBy` is not forgeable *from the route*, and the guard must keep it
   that way.** Over 2024 agent-actor runs, every single one that chose
   `invocationSource: "automation"` recorded
   `contextSnapshot.triggeredBy = NULL` — not one claimed `board`. The one
   non-null agent value is the literal `agent`. So the existing
   `board_automation` discriminator was empirically sound on the write path.

The repair therefore has two parts, and the second is the one that matters:

- **Minimal, contained:** admit `on_demand` board wakes alongside the existing
  classes, keyed on `invocationSource === "on_demand" && wakeSource ===
  "on_demand" && triggeredBy === "board"` — structurally identical to the
  KEE-529 `board_automation` argument, and empirically backed by the measurement
  above.
- **Required for safety:** do **not** read `contextSnapshot.triggeredBy` at all
  for the authority decision. Join the run's `wakeup_request_id` to
  `agent_wakeup_requests` and require `requested_by_actor_type = "user"`.
  That value is service-written from the authenticated actor, cannot be set by a
  payload, and fails closed when the run has no wakeup request.

This is why the wake says "do not infer authority from a forgeable `triggeredBy`
field": the honest reading is that `triggeredBy` is *less* forgeable than it
looks (it is route-derived), but it is still a JSON field with no integrity
guarantee, it conflates `user` with `system`, and there is a correct
column-backed alternative sitting right next to it. Keying on the column is
narrower than the card's `on_demand` proposal and satisfies "preserve every
agent/non-board denial" without relying on a field the caller can partly shape.

## 2. What is therefore safe to land

The `requested_by_actor_type = "user"` predicate:

- still refuses every agent-dispatched unscoped run (2024 agent rows, none of
  which have a user actor type),
- still refuses system/scheduler-issued unscoped runs (2451 system rows),
- admits only the 609 user-dispatched board-attributed wakes,
- is fail-closed when `wakeup_request_id` is null,
- and needs no new column, no migration, and no new payload plumbing.

Attribution and the per-run cap are untouched: the change only decides whether
the run has *any* legitimate source kind, and the `sourceIssueId` /
cross-issue accounting downstream is unchanged.

## 3. Not done here

No deployment, no upstream write, no routing/provider change, no secret or skill
change, no broad permission expansion. The draft PR is against `electrumnz/paperclip`
only, on a seat-isolated worktree, with retained dependencies symlinked rather
than reinstalled.