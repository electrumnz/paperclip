// Classify a nominally completed ACP turn whose only output is a provider
// error payload.
//
// A provider that refuses to serve the requested model does not always fail
// the turn. Codex on a ChatGPT account answers the rejection as ordinary
// assistant text, ends the turn `end_turn`, and exits 0, so the run is recorded
// `succeeded` with a null `errorCode`:
//
//   acpx.text_delta  Warning: Model metadata for `claude-haiku-4-5` not found...
//   acpx.text_delta  {"type":"error","status":400,"error":{"type":"invalid_request_error",
//                     "message":"The 'claude-haiku-4-5' model is not supported when using
//                     Codex with a ChatGPT account."}}
//   acpx.result      stopReason=end_turn
//
// Zero tool calls, no work done, and every operator surface reads healthy. The
// only symptom is an assigned card that never moves, which a stall sweep later
// reads as a stalled card and flips to `blocked` — attributing a platform fault
// to the card and to the seat. `model_not_found` already has a destination
// (`isConfigurationIncompleteFailedRun`), so the whole gap is that a provider
// 400 never reaches that classification.
//
// This seam is deliberately narrow. Zero tool calls is a weak signal on its own
// — most zero-tool-call runs are legitimate no-op heartbeats — so it never
// fails a run by itself. The classification needs all three of:
//
//   1. no tool activity at all,
//   2. a parseable provider error envelope in the output, and
//   3. nothing else of substance in the output.
//
// Condition 3 is what keeps an agent that *writes about* a provider 400 (a
// support answer, or work on this very bug) out of the classification: its
// output carries prose the error payload does not account for.

/**
 * The error code a classified turn records. `model_not_found` routes through
 * the existing configuration-incomplete path; `adapter_failed` is the ordinary
 * adapter failure code, which recovery already classifies from the message
 * text (quota, configuration blocker, or neither).
 */
export type AcpxOutputRejectionCode = "model_not_found" | "adapter_failed";

export interface AcpxOutputRejection {
  /** Why the turn was reclassified. */
  readonly kind: "model_rejected" | "error_payload_only";
  /** The error code to record on the run. */
  readonly errorCode: AcpxOutputRejectionCode;
  /** The operator-facing failure message. */
  readonly message: string;
}

/** Longest provider message carried onto the run result. */
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Text the output may carry alongside the error payload without disqualifying
 * the classification: blank lines, code fences, and the provider's own
 * warning/error prose (the `Warning: Model metadata ... not found` line the
 * Codex CLI prints before it forwards the rejection).
 */
const TRIVIAL_RESIDUE_LINE_RE = /^\s*(?:`{3,}[\w-]*|(?:warning|error|note)\b.*)?\s*$/i;

/**
 * A provider message that names the requested model as one it will not serve.
 * Kept in step with the ACP-lane pattern in
 * `packages/paperclip-runner/src/native-session-runtime.ts`, so a model
 * rejection reads the same whether the provider fails the turn or answers it.
 */
const MODEL_REJECTION_RE =
  /model_not_found|(?:unknown|invalid|unsupported)\s+model|issue with the selected model|model[^\n]*(?:does not exist|not found|not supported|not available|not enabled|unsupported)/i;

/** One parsed error envelope and the span of source text it accounts for. */
interface ErrorEnvelope {
  readonly value: Record<string, unknown>;
  readonly start: number;
  readonly end: number;
}

export function classifyAcpxOutputRejection(input: {
  /** Output-stream text segments for the turn. Never the thought stream. */
  readonly outputSegments: readonly string[];
  /** Whether the turn produced any tool call or client-side tool receipt. */
  readonly sawToolActivity: boolean;
}): AcpxOutputRejection | null {
  // A turn that did real work is out of scope, whatever its text says. This is
  // the guard that keeps an agent discussing a provider 400 from being read as
  // one.
  if (input.sawToolActivity) return null;
  const text = input.outputSegments.join("");
  if (text.trim().length === 0) return null;

  const envelopes = extractErrorEnvelopes(text);
  if (envelopes.length === 0) return null;
  // A provider relays its own rejection as a payload that identifies itself: an
  // HTTP status, or a top-level `type: "error"`. An agent *writing about* an
  // error tends to quote only a fragment — `{"error":{...}}`, with no status and
  // no self-typing — so this is the discriminator between a relayed rejection
  // and a quoted one. The fleet's own `spawn-smoke` test ("preserves ordinary
  // assistant text even when it resembles a provider error") pins that
  // error-*shaped* assistant prose stays a success.
  const relayed = envelopes.filter(declaresItselfAsProviderError);
  if (relayed.length === 0) return null;
  if (!residueIsTrivial(text, relayed)) return null;

  const rejected = relayed.find(isModelRejectionEnvelope);
  if (rejected) {
    return {
      kind: "model_rejected",
      errorCode: "model_not_found",
      message:
        "The provider rejected the requested model and the run did no work: " +
        describeEnvelope(rejected.value),
    };
  }
  return {
    kind: "error_payload_only",
    errorCode: "adapter_failed",
    message:
      "The provider returned an error and the run did no work: " +
      describeEnvelope(relayed[0]!.value),
  };
}

/**
 * Whether the payload identifies itself as a provider error, rather than being
 * a fragment an agent quoted. A relayed rejection carries the status the
 * provider returned, or types the whole payload `error`.
 */
function declaresItselfAsProviderError(envelope: ErrorEnvelope): boolean {
  const value = envelope.value;
  if (statusOf(value) >= 400) return true;
  return value.type === "error";
}

/**
 * Pull every parseable JSON error envelope out of the output text, with the
 * span each one occupies. A cheap prefilter keeps the balanced-brace scan off
 * the ordinary prose case: only a `{` whose neighbourhood mentions an error
 * envelope's keys is worth parsing.
 */
function extractErrorEnvelopes(text: string): ErrorEnvelope[] {
  const envelopes: ErrorEnvelope[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open < 0) break;
    if (!looksLikeErrorEnvelopeStart(text, open)) {
      index = open + 1;
      continue;
    }
    const close = findMatchingBrace(text, open);
    if (close < 0) {
      index = open + 1;
      continue;
    }
    const parsed = parseObject(text.slice(open, close + 1));
    if (parsed && isErrorEnvelope(parsed)) {
      envelopes.push({ value: parsed, start: open, end: close + 1 });
      index = close + 1;
      continue;
    }
    index = open + 1;
  }
  return envelopes;
}

/** Window prefilter: an error envelope names at least one of these keys early. */
function looksLikeErrorEnvelopeStart(text: string, open: number): boolean {
  const window = text.slice(open, open + 200);
  return /"(?:error|status|statusCode|type)"/.test(window);
}

/**
 * Index of the `}` closing the object that opens at `open`, or -1. String
 * literals and their escapes are skipped so a brace inside a provider message
 * cannot end the object early.
 */
function findMatchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseObject(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * An error envelope is a 4xx/5xx status payload, or an object carrying a typed
 * `error` member, or a payload that types itself `error`.
 */
function isErrorEnvelope(value: Record<string, unknown>): boolean {
  if (statusOf(value) >= 400) return true;
  const error = errorMemberOf(value);
  if (!error) return false;
  return typeof error.message === "string" || typeof error.type === "string";
}

function isModelRejectionEnvelope(envelope: ErrorEnvelope): boolean {
  const status = statusOf(envelope.value);
  // A model rejection is a client-request fault. A 5xx is the provider failing,
  // not refusing, and must not be recorded as a permanent model problem.
  if (status < 400 || status >= 500) return false;
  return MODEL_REJECTION_RE.test(messageOf(envelope.value));
}

function statusOf(value: Record<string, unknown>): number {
  const error = errorMemberOf(value);
  for (const candidate of [value.status, value.statusCode, error?.status, error?.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return 0;
}

function errorMemberOf(value: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof value.error === "object" && value.error !== null && !Array.isArray(value.error)) {
    return value.error as Record<string, unknown>;
  }
  return value.type === "error" ? value : null;
}

/** The provider message plus its error type, so both can be pattern-matched. */
function messageOf(value: Record<string, unknown>): string {
  const error = errorMemberOf(value);
  return [
    typeof value.message === "string" ? value.message : "",
    typeof error?.message === "string" ? error.message : "",
    typeof error?.type === "string" ? error.type : "",
    typeof error?.code === "string" ? error.code : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function describeEnvelope(value: Record<string, unknown>): string {
  const error = errorMemberOf(value);
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof value.message === "string" && value.message) ||
    (typeof error?.type === "string" && error.type) ||
    "provider returned an error payload";
  const status = statusOf(value);
  const prefix = status >= 400 ? `${status} ` : "";
  return `${prefix}${message}`.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Whether everything the output says outside the error envelopes is
 * insubstantial. Any real sentence means the agent was talking, not relaying a
 * rejection, and the turn keeps its reported outcome.
 */
function residueIsTrivial(text: string, envelopes: readonly ErrorEnvelope[]): boolean {
  let residue = "";
  let cursor = 0;
  for (const envelope of envelopes) {
    residue += text.slice(cursor, envelope.start);
    cursor = envelope.end;
  }
  residue += text.slice(cursor);
  if (residue.trim().length === 0) return true;
  return residue.split("\n").every((line) => TRIVIAL_RESIDUE_LINE_RE.test(line));
}
