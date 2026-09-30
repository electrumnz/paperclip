import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/**
 * The same union `AdapterExecutionResult["errorFamily"]` carries, so the values
 * assigned here are checked against the heartbeat's consumer.
 */
type HermesErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

/**
 * The Hermes CLI reports provider failures as rendered text on stderr/stdout,
 * not as a typed protocol error. Without this mapping a rate limit, a quota
 * exhaustion and an authentication rejection all reach the heartbeat as the
 * same opaque `adapter_failed`, so the scheduler retries a terminal condition
 * and sleeps through a recoverable one.
 *
 * The same `errorFamily` vocabulary the typed ACP adapters already emit is used
 * here so the heartbeat's existing `readHeartbeatRunErrorFamily` contract picks
 * these up unchanged.
 */

export interface HermesProviderFailureClassification {
  errorCode: string;
  errorFamily?: HermesErrorFamily;
  /** Seconds to wait before the next attempt, when the provider asked for one. */
  retryDelaySec?: number;
}

/** Terminal: the account cannot serve this traffic until an operator acts. */
const QUOTA_PATTERN =
  /atria_quota_exhausted|insufficient_quota|atria account quota exhausted|HTTP 429:[\s\S]{0,80}quota/i;

/** Recoverable: the upstream provider is busy, cooling down, or briefly down. */
const TRANSIENT_PATTERN =
  /atria_rate_limited|atria_router_busy|atria_unavailable|atria_timeout|HTTP (?:429|502|503|504):|atria connection failed|atria temporarily unavailable|overloaded_error/i;

/** Terminal: credentials or the request itself will never be accepted. */
const AUTHENTICATION_PATTERN = /atria_authentication|atria credentials were rejected|HTTP (?:401|403):/i;
const INVALID_REQUEST_PATTERN =
  /atria_input_budget|atria_invalid_request|conservative atria context budget exceeded|output token limit must be|atria rejected request parameters|HTTP 400:/i;

/**
 * A run that exited without a recorded outcome is a control-plane failure, not
 * a provider failure. It must not be recovered by retrying the provider, and it
 * must win over any provider text quoted earlier in the same output.
 */
const MISSING_OUTCOME_PATTERN = /HERMES_TASK_OUTCOME_MISSING|HERMES_TASK_OUTCOME_UNVERIFIED/;

function readRetryDelaySec(text: string): number | undefined {
  const structured = /retry_after_seconds["']?\s*:\s*(\d+)/i.exec(text);
  const rendered = /retry after at least (\d+) seconds/i.exec(text);
  const seconds = Number((structured ?? rendered)?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.max(60, seconds);
}

/**
 * Classify rendered Hermes provider output. Returns `null` when the text does
 * not describe a failure this classifier recognises, so unrelated output keeps
 * the adapter's existing behaviour.
 */
export function classifyHermesProviderFailure(
  text: string,
): HermesProviderFailureClassification | null {
  if (!text.trim()) return null;

  // Checked first: a missing disposition can quote a provider error in the same
  // output, and the missing outcome is the condition that needs repair.
  if (MISSING_OUTCOME_PATTERN.test(text)) {
    return { errorCode: "hermes_task_outcome_missing" };
  }
  if (QUOTA_PATTERN.test(text)) {
    // The upstream literal, not an adapter-prefixed name: `provider_quota` is
    // already registered in `TRANSIENT_INFRA_CONTINUATION_ERROR_CODES` and
    // allow-listed by `classifyAdapterFailureForRecovery`, and it is what
    // `readHeartbeatRunErrorFamily` maps to the `provider_quota` family. An
    // adapter-specific name here would classify as `default` (1 attempt, no
    // backoff) and would never schedule the quota recovery monitor.
    return { errorCode: "provider_quota", errorFamily: "provider_quota" };
  }
  if (TRANSIENT_PATTERN.test(text)) {
    const retryDelaySec = readRetryDelaySec(text);
    return retryDelaySec === undefined
      ? { errorCode: "hermes_transient_upstream", errorFamily: "transient_upstream" }
      : { errorCode: "hermes_transient_upstream", errorFamily: "transient_upstream", retryDelaySec };
  }
  if (AUTHENTICATION_PATTERN.test(text)) {
    return { errorCode: "hermes_provider_authentication" };
  }
  if (INVALID_REQUEST_PATTERN.test(text)) {
    return { errorCode: "hermes_provider_invalid_request" };
  }
  return null;
}
