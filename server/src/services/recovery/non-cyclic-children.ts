/**
 * Recovery reverse-dependency filtering, KEE-1087 hotfix 1 and 3 port.
 *
 * Recovery proposes "this issue is blocked by these children". If a proposed
 * child is already reachable from the source issue through existing `blocks`
 * edges, proposing it would create a cycle: A blocks B, and B blocks A.
 *
 * Upstream refuses such a write, but only at the write layer:
 * `assertNoBlockingCycles` (services/issues.ts) throws `unprocessable`, and that
 * throw escapes `reconcileStrandedAssignedIssues`, which has no error handling of
 * its own. The recovery pass is abandoned for every remaining issue and the
 * failure is swallowed by the caller's rejection handler.
 *
 * Filtering the candidate set here is the same intent as the 2026-09-23 Atria
 * pilot patch, lifted to a pure module so it can be proven without a database.
 * The caller still passes the surviving ids to `issuesSvc.update`, so the write
 * path is unchanged.
 *
 * Kept as a pure function for that reason: the DB query for the edge set stays
 * with the caller.
 */

export interface RecoveryBlockingEdge {
  /** The blocking issue. */
  issueId: string;
  /** The issue the edge blocks. */
  relatedIssueId: string;
}

export interface RecoveryChildCandidate {
  id: string;
}

/**
 * Drop proposed blocker children that the source issue already reaches, so
 * adding them as `blocks` edges cannot form a cycle.
 *
 * A child is dropped when it is reachable from `sourceId` along existing
 * `blocks` edges. Reachability is transitive and includes the source itself:
 * if a child is the source, or downstream of it, the edge would close a loop.
 */
export function nonCyclicRecoveryChildren<
  T extends RecoveryChildCandidate,
>(sourceId: string, candidates: readonly T[], edges: readonly RecoveryBlockingEdge[]): T[] {
  if (candidates.length === 0) return [];

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.issueId);
    if (targets) targets.push(edge.relatedIssueId);
    else outgoing.set(edge.issueId, [edge.relatedIssueId]);
  }

  const reachable = new Set<string>();
  const pending = [sourceId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }

  return candidates.filter((child) => !reachable.has(child.id));
}
