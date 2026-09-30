import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { isUuidLike, issueWriteDenialResponse } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";

export const CROSS_ISSUE_INFLUENCE_LIMIT = 20;
export const CROSS_ISSUE_INFLUENCE_ENFORCE_AT = new Date("2026-08-11T00:00:00.000Z");

const CROSS_ISSUE_INFLUENCE_ACTIVITY = "issue.cross_issue_influence_observed";
const CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY = "issue.cross_issue_influence_cap_rejected";

/**
 * Every kind shares one per-run counter. `interaction_resolution` covers the
 * issue-thread accept/reject/respond/verdict routes: an open `anyone` resolver
 * audience is not a licence to resolve, wake, and spawn suggested tasks across
 * the whole company from one run.
 */
export type CrossIssueInfluenceKind = "comment" | "update" | "interaction_resolution";

export type CrossIssueInfluenceDecision = {
  allowed: boolean;
  mode: "log_only" | "enforce";
  count: number;
  cap: number;
  enforceAt: string;
};

export function crossIssueInfluenceRunContextError() {
  // Copy comes from the shared issue-write denial contract (the open cross-task write design (failure UX))
  // so the agent reading this 403 is told the fix, not just the refusal.
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_context_required");
  return forbidden(body.error, body.details);
}

/**
 * Distinct from `crossIssueInfluenceRunContextError`: that one fires when the
 * run id header itself is missing, malformed, or doesn't resolve to this
 * actor's own run — sending the header fixes it. This one fires when the run
 * id is genuinely correct but the run's own context was never anchored to an
 * issue, so no header on a retry can ever supply the missing source issue.
 */
export function crossIssueInfluenceRunNotIssueScopedError() {
  const { body } = issueWriteDenialResponse("cross_issue_influence_run_not_issue_scoped");
  return forbidden(body.error, body.details);
}

function readRunSourceIssueId(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  for (const candidate of [context.issueId, context.taskId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Classifies a run that carries no issue anchor.
 *
 * Two wake classes legitimately have no source issue: the scheduler's own timer
 * wake, and the board dispatching an idle agent to go find work. Both are
 * dispatched by the control plane rather than by an agent, so attribution
 * (company, agent, run) is still intact and the cap still counts per run — the
 * only thing missing is a source issue, which never existed for either.
 *
 * Returns null for anything else, so the guard stays fail-closed by default.
 */
function readUnscopedRunSourceKind(input: {
  invocationSource: string;
  contextSnapshot: unknown;
  /** Authoritative initiator from agent_wakeup_requests, not the JSON blob. */
  requestedByActorType: string | null;
}): "heartbeat_timer" | "board_dispatch" | null {
  if (!input.contextSnapshot || typeof input.contextSnapshot !== "object" || Array.isArray(input.contextSnapshot)) {
    return null;
  }
  const context = input.contextSnapshot as Record<string, unknown>;

  if (
    input.invocationSource === "timer" &&
    context.wakeReason === "heartbeat_timer" &&
    context.wakeSource === "timer"
  ) {
    return "heartbeat_timer";
  }

  // Board-dispatched idle wakes ("idle with actionable work…") carry a free-text
  // wakeReason, so there is no reason string to match on. KEE-586: the same
  // argument covers `on_demand` board wakes, which are the class a human or an
  // operator tool triggers directly.
  //
  // The discriminator is the *initiator*, and it is deliberately read from
  // `agent_wakeup_requests.requested_by_actor_type` rather than from
  // `contextSnapshot.triggeredBy`:
  //
  //  - `requested_by_actor_type` is written by the service from the
  //    authenticated actor (heartbeat.enqueueWakeup), never from a wake payload,
  //    and the wake routes refuse a manual user wake that is not user-actor
  //    (enqueueWakeup throws 403 for requestedByActorType !== "user").
  //  - `contextSnapshot.triggeredBy` is a JSON field with no integrity
  //    guarantee on the read path: it is copied wholesale through the deferred
  //    wake queue (`payload._paperclipWakeContext` is re-seeded verbatim on
  //    promotion), and it conflates `user` with `system` — 285 unscoped runs
  //    carry triggeredBy "board" while their wakeup row says `system`.
  //
  // Requiring "user" therefore admits exactly the operator-dispatched wakes and
  // keeps every agent-dispatched and every scheduler-dispatched denial in place.
  // An agent cannot reach this branch: no agent-dispatched run has a user actor
  // type, and a run with no wakeup request at all is null here and fails closed.
  if (input.requestedByActorType === "user" && context.triggeredBy === "board") {
    return "board_dispatch";
  }

  return null;
}

export function evaluateCrossIssueInfluenceLimit(input: {
  priorCount: number;
  now?: Date;
}): CrossIssueInfluenceDecision {
  const now = input.now ?? new Date();
  const mode = now >= CROSS_ISSUE_INFLUENCE_ENFORCE_AT ? "enforce" : "log_only";
  const nextCount = input.priorCount + 1;
  return {
    allowed: mode === "log_only" || nextCount <= CROSS_ISSUE_INFLUENCE_LIMIT,
    mode,
    count: nextCount,
    cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    enforceAt: CROSS_ISSUE_INFLUENCE_ENFORCE_AT.toISOString(),
  };
}

/**
 * Atomically observes one cross-issue influence attempt for a heartbeat run.
 *
 * Locking the run row serializes concurrent attempts from the same run. The
 * observation is intentionally recorded before the route mutation: once the
 * rollout reaches enforcement, failures cannot be used to race or probe past
 * the fail-closed backstop.
 */
export async function observeCrossIssueInfluence(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    now?: Date;
  },
): Promise<CrossIssueInfluenceDecision | null> {
  // API-key callers control the run header. Reject malformed UUIDs before the
  // database can turn an untrusted identifier into a PostgreSQL cast error.
  if (!isUuidLike(input.runId)) throw crossIssueInfluenceRunContextError();

  return db.transaction(async (tx) => {
    const run = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        invocationSource: heartbeatRuns.invocationSource,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !run ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId
    ) {
      throw crossIssueInfluenceRunContextError();
    }

    // KEE-586: the initiator of record is the wakeup request row, not a field in
    // the run's own JSON context. Scoped to this run's own request and company so
    // the lookup can never be steered at another run's initiator. A run with no
    // wakeup request has no authenticated initiator and fails closed below.
    const requestedByActorType = run.wakeupRequestId
      ? await tx
          .select({ requestedByActorType: agentWakeupRequests.requestedByActorType })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.id, run.wakeupRequestId),
            eq(agentWakeupRequests.companyId, input.companyId),
          ))
          .limit(1)
          .then((rows) => rows[0]?.requestedByActorType ?? null)
      : null;

    const sourceIssueId = readRunSourceIssueId(run.contextSnapshot);
    // KEE-159: an unscoped but verified timer run is a legitimate third
    // sourceKind and is allowed through. Only a null sourceKind — a run that
    // is neither issue-anchored nor a heartbeat timer — is permanently
    // unfixable by a header, so only that case takes the new KEE-567 code.
    const sourceKind = sourceIssueId
      ? "issue"
      : readUnscopedRunSourceKind({ ...run, requestedByActorType });
    if (!sourceKind) throw crossIssueInfluenceRunNotIssueScopedError();
    if (
      sourceIssueId && (
        sourceIssueId === input.targetIssueId ||
        (input.targetIssueIdentifier && sourceIssueId.toUpperCase() === input.targetIssueIdentifier.toUpperCase())
      )
    ) {
      return null;
    }

    const priorCount = await tx
      .select({ count: count() })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.runId, input.runId),
        eq(activityLog.action, CROSS_ISSUE_INFLUENCE_ACTIVITY),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateCrossIssueInfluenceLimit({ priorCount, now: input.now });

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      responsibleUserId: input.responsibleUserId ?? run.responsibleUserId ?? null,
      action: decision.allowed
        ? CROSS_ISSUE_INFLUENCE_ACTIVITY
        : CROSS_ISSUE_INFLUENCE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        kind: input.kind,
        sourceKind,
        sourceIssueId,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        count: decision.count,
        cap: decision.cap,
        mode: decision.mode,
        enforceAt: decision.enforceAt,
        allowed: decision.allowed,
      },
    });

    const logContext = {
      event: "cross_issue_influence_cap",
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      sourceKind,
      sourceIssueId,
      targetIssueId: input.targetIssueId,
      kind: input.kind,
      count: decision.count,
      cap: decision.cap,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
      allowed: decision.allowed,
    };
    if (decision.allowed) {
      logger.info(logContext, "cross-issue influence observed");
    } else {
      logger.warn(logContext, "cross-issue influence cap exceeded");
    }

    return decision;
  });
}

export function crossIssueInfluenceLimitError(
  decision: CrossIssueInfluenceDecision,
  context: { actorLabel?: string | null; assigneeLabel?: string | null; issueIdentifier?: string | null } = {},
) {
  // The cap is a rate backstop, not a permission decision — the shared copy
  // contract says so explicitly, and names the next run as the way forward.
  const { body } = issueWriteDenialResponse("cross_issue_influence_cap_exceeded", {
    ...context,
    cap: decision.cap,
    count: decision.count,
    enforceAt: decision.enforceAt,
  });
  return {
    error: body.error,
    details: {
      ...body.details,
      cap: decision.cap,
      count: decision.count,
      mode: decision.mode,
      enforceAt: decision.enforceAt,
    },
  };
}
