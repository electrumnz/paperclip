// The run-loop turn gate (KEE-440, thresholds approved on KEE-418).
//
// A small minority of runs carry most of the billed input: 8% of runs carry
// ~40% of it, because billed input is `turns x context carried` and nothing
// compacts. The gate bounds that tail by tool-call count — the unit the board
// approved — rather than by wall clock, which kills work mid-tool-call.
//
// Two stages:
//   - a soft checkpoint, which tells the run it has reached the checkpoint and
//     must write durable progress and a next action before it continues;
//   - a hard stop, which ends the turn with no discretion.
//
// This module is pure. It counts and decides; it performs no cancel, writes no
// comment, and reads no clock. The engine's event relay feeds it normalized ACP
// tool-call events and acts on the decision it returns. Keeping it pure is what
// makes the threshold behaviour unit-testable without an agent process.
//
// Two properties matter and are easy to get wrong:
//
//   1. Count unique tool-call IDs, not events. ACP re-emits the same call as
//      `tool_call_update` for every status change, so counting events would
//      trip the gate several times earlier than the approved threshold.
//
//   2. Fire only between tool calls, never during one. The engine's session
//      preservation treats an interrupted turn as unsafe to resume unless every
//      in-flight tool was a completed read (see `safeInterruptedSession` in
//      execute.ts). Cancelling mid-write therefore costs a cold session and a
//      full replay — the rework the gate exists to avoid. So the gate holds its
//      decision until no call is in flight. `hardBoundarySlack` bounds that
//      wait, so a tool that never reports a terminal status cannot defeat the
//      hard stop outright.

import { asNumber, asString } from "../server-utils.js";

/** The gate's decision for one observed event. `null` means carry on. */
export type TurnGateDecision =
  | { readonly kind: "soft_checkpoint"; readonly toolCalls: number; readonly threshold: number }
  | {
      readonly kind: "hard_stop";
      readonly toolCalls: number;
      readonly threshold: number;
      /** True when the stop fired without a clean boundary, because slack ran out. */
      readonly forced: boolean;
    };

/**
 * The resolved thresholds, in tool calls. `0` disables a stage, which is how the
 * gate is set to unlimited without a redeploy — the requirement that the
 * threshold be config, not a constant.
 */
export interface TurnGateThresholds {
  readonly softToolCalls: number;
  readonly hardToolCalls: number;
  /**
   * How many further tool calls the hard stop waits for a clean boundary before
   * it fires anyway. Bounds the pathological case where a tool never reports a
   * terminal status.
   */
  readonly hardBoundarySlack: number;
}

/** The board-approved defaults from KEE-418 (`kee418:threshold:v1`, `two_stage_40_60`). */
export const DEFAULT_TURN_GATE_SOFT_TOOL_CALLS = 40;
export const DEFAULT_TURN_GATE_HARD_TOOL_CALLS = 60;
export const DEFAULT_TURN_GATE_HARD_BOUNDARY_SLACK = 5;

/**
 * Read the thresholds from adapter config. Absent keys take the approved
 * defaults; an explicit `0` disables that stage. A negative or non-numeric value
 * is treated as absent rather than as a disable, so a typo cannot silently
 * switch the gate off.
 */
export function resolveTurnGateThresholds(config: Record<string, unknown> | null | undefined): TurnGateThresholds {
  const source = config ?? {};
  const read = (key: string, fallback: number): number => {
    const raw = asNumber(source[key], Number.NaN);
    if (!Number.isFinite(raw) || raw < 0) return fallback;
    return Math.floor(raw);
  };
  return {
    softToolCalls: read("turnGateSoftToolCalls", DEFAULT_TURN_GATE_SOFT_TOOL_CALLS),
    hardToolCalls: read("turnGateHardToolCalls", DEFAULT_TURN_GATE_HARD_TOOL_CALLS),
    hardBoundarySlack: read("turnGateHardBoundarySlack", DEFAULT_TURN_GATE_HARD_BOUNDARY_SLACK),
  };
}

/** Why the gate is not enforcing on this run, or `null` when it is. */
export interface TurnGateExemption {
  readonly source: "budget_section" | "thresholds_disabled";
  readonly detail: string;
}

// The exemption is declared on the card, in its `## Budget` section, and it must
// be an explicit key-value line. Prose matching was rejected: the phrase "long
// job" appears in cards that discuss the gate without claiming an exemption
// (KEE-440's own "Not in scope" section is the example), so a loose match would
// exempt the very cards that must be gated. Scoping to the Budget section is
// necessary but not sufficient — the declaration itself has to be unambiguous.
const BUDGET_EXEMPTION_KEYS = new Set(["long job", "long-job", "longjob", "turn gate", "turn-gate", "turngate"]);
const BUDGET_EXEMPTION_VALUES = new Set(["yes", "true", "on", "off", "exempt", "unlimited", "none", "disabled"]);
// `Turn gate: on` reads as "the gate is on", i.e. NOT an exemption. `Long job:
// off` reads as "not a long job", likewise not an exemption. The key decides
// which values mean exempt.
const GATE_KEYS = new Set(["turn gate", "turn-gate", "turngate"]);
const GATE_EXEMPT_VALUES = new Set(["off", "exempt", "unlimited", "none", "disabled"]);
const LONG_JOB_EXEMPT_VALUES = new Set(["yes", "true", "on"]);

/**
 * Extract the `## Budget` section from card markdown. Returns "" when the card
 * has no Budget section. The section ends at the next heading of the same or a
 * higher level, so a `### ` subheading inside Budget stays in the section.
 */
export function extractBudgetSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let depth = 0;
  const collected: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (depth === 0) {
      if (heading && heading[2].trim().toLowerCase().replace(/[:\s]+$/, "") === "budget") {
        depth = heading[1].length;
      }
      continue;
    }
    if (heading && heading[1].length <= depth) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

/**
 * Decide whether the card's Budget section declares a long job. Accepts
 * `Long job: yes` and `Turn gate: off` (and the obvious spelling variants),
 * optionally as a markdown list item or bolded. Anything else is not an
 * exemption.
 *
 * Verified on 2026-09-16: the engine can read this at run start. The full card
 * markdown arrives as `context.paperclipTaskMarkdown` and is already consumed by
 * `buildPrompt` before the turn starts, so no new fetch is needed. Note the
 * engine must read the *full* variant directly: `selectPaperclipTaskMarkdown`
 * returns `paperclipTaskMarkdownCompact` on non-assignment resume wakes, and the
 * compact variant has the description — and therefore the Budget section —
 * stripped. Reading through the selector would silently drop the exemption on
 * every resumed run.
 */
export function budgetSectionDeclaresLongJob(markdown: string | null | undefined): boolean {
  const section = extractBudgetSection(asString(markdown, ""));
  if (!section) return false;
  for (const rawLine of section.split(/\r?\n/)) {
    // Strip list markers, bold/italic markers and backticks before parsing.
    const line = rawLine.replace(/^\s*[-*+]\s+/, "").replace(/[*_`]/g, "").trim();
    const match = /^([A-Za-z][A-Za-z \-]*?)\s*[:=]\s*(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim().toLowerCase().replace(/[.,;]+$/, "");
    if (!BUDGET_EXEMPTION_KEYS.has(key) || !BUDGET_EXEMPTION_VALUES.has(value)) continue;
    if (GATE_KEYS.has(key)) {
      if (GATE_EXEMPT_VALUES.has(value)) return true;
    } else if (LONG_JOB_EXEMPT_VALUES.has(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Read the exemption for a run from the adapter execution context. Reads the
 * full task markdown directly, for the reason given on
 * `budgetSectionDeclaresLongJob`.
 */
export function readTurnGateBudgetExemption(context: Record<string, unknown> | null | undefined): boolean {
  const source = context ?? {};
  const candidates = [
    asString(source.paperclipTaskMarkdown, ""),
    asString((source.paperclipIssue as Record<string, unknown> | undefined)?.description, ""),
  ];
  return candidates.some((candidate) => budgetSectionDeclaresLongJob(candidate));
}

/**
 * The follow-up turn the engine runs after a gate cancel.
 *
 * The ACP runtime cannot deliver a message into a turn that is already running:
 * `AcpRuntimeTurn` exposes only `requestId`, `events`, `result`, `cancel()` and
 * `closeStream()`. So both stages are delivered the same way — cancel the turn at
 * a clean boundary, then start a short second turn on the same (persistent)
 * session, which continues the conversation rather than replaying it.
 *
 * This is also what makes the handback possible at all. The engine cannot write
 * the handback itself: it does not know what changed or what the working tree
 * looks like. Only the agent can, and only if it is given another turn in which
 * to do it. A cancel with no follow-up turn is the rework generator KEE-440
 * forbids.
 */
export interface TurnGateFollowUp {
  readonly kind: "soft_checkpoint" | "hard_stop";
  /** The prompt text for the second turn. */
  readonly prompt: string;
  /**
   * Whether the gate keeps counting during the follow-up turn. True after a soft
   * checkpoint, so a run that continues past the checkpoint still meets the hard
   * stop. False after a hard stop: the handback turn must be allowed to finish,
   * and gating it again could leave the run with no handback at all.
   */
  readonly gated: boolean;
  /** The cancel reason for the first turn. Recorded in the run log, not shown to the agent. */
  readonly cancelReason: string;
}

// Written as instructions to the agent, in the imperative. The run has already
// done `toolCalls` tool calls when it reads this, so the text leads with where it
// is and what is required, not with an explanation of the mechanism.
export function buildTurnGateFollowUp(decision: TurnGateDecision, thresholds: TurnGateThresholds): TurnGateFollowUp {
  if (decision.kind === "soft_checkpoint") {
    const hardLine =
      thresholds.hardToolCalls > 0
        ? ` This run stops for good at ${thresholds.hardToolCalls} tool calls, so you have about ${Math.max(thresholds.hardToolCalls - decision.toolCalls, 0)} left.`
        : "";
    return {
      kind: "soft_checkpoint",
      gated: true,
      cancelReason: `paperclip turn gate soft checkpoint at ${decision.toolCalls} tool calls`,
      prompt: [
        `[Paperclip turn gate] You have made ${decision.toolCalls} tool calls, which reaches the soft checkpoint of ${decision.threshold}.${hardLine}`,
        "",
        "Do this now, in order:",
        "",
        "1. Write durable progress to the issue — a comment saying what you have done so far, what the working tree looks like, and what the next action is. Write it even if the work feels unfinished; especially then. This comment is the whole point of the checkpoint: it is what lets the next run pick up instead of starting again.",
        "2. Then decide, and say which you chose:",
        "   - If the remaining steps are few and you can name them, finish them and end the run normally.",
        "   - Otherwise hand back now. Leave the issue in a clear state with a next action, and stop.",
        "",
        "Do not start a new line of investigation, a refactor, or a broad search. If you are mid-edit, finish that edit or revert it — do not leave the tree half-written.",
      ].join("\n"),
    };
  }
  return {
    kind: "hard_stop",
    gated: false,
    cancelReason: `paperclip turn gate hard stop at ${decision.toolCalls} tool calls${decision.forced ? " (forced: no clean boundary)" : ""}`,
    prompt: [
      `[Paperclip turn gate] You have made ${decision.toolCalls} tool calls, which reaches the hard stop of ${decision.threshold}. This run is over. You have no discretion here.`,
      "",
      "Start no new work. Do not read another file, run another search, or make another edit — except the one write below.",
      "",
      "Write a handback comment on the issue now, containing:",
      "",
      "- **Status** — what state the work is actually in.",
      "- **What changed** — files, branches, commits. Name them.",
      "- **Working tree** — clean, dirty, or mid-edit; committed or not; pushed or not.",
      "- **Next action** — the single next thing the run after this one should do.",
      "",
      "Be accurate rather than tidy. If something is half-done or broken, say so — the next run inherits it. Then end your turn.",
    ].join("\n"),
  };
}

/** The normalized tool-call fields the gate needs. The engine supplies these from its ACP events. */
export interface TurnGateToolCallEvent {
  readonly toolCallId: string;
  /** The ACP tool-call status, when the agent supplied one. */
  readonly status?: string;
}

export interface TurnGate {
  /**
   * Feed one tool-call event. Returns the decision the engine must act on, or
   * `null`. Each stage fires at most once per run.
   */
  observe(event: TurnGateToolCallEvent): TurnGateDecision | null;
  /** Unique tool calls seen so far. */
  readonly toolCalls: number;
  readonly softFired: boolean;
  readonly stopped: boolean;
  readonly exemption: TurnGateExemption | null;
}

export interface CreateTurnGateInput {
  readonly thresholds: TurnGateThresholds;
  /** True when the card's Budget section declares a long job. Skips both stages. */
  readonly budgetExempt: boolean;
}

// ACP makes tool-call status optional and its vocabulary is open. Treat only the
// statuses that mean "still running" as in-flight; an absent or unknown status
// is treated as settled, so a status-less agent does not park the gate forever.
const IN_FLIGHT_STATUSES = new Set(["pending", "in_progress", "running"]);

/**
 * Create a run-scoped gate. Both stages are skipped when the card declares a long
 * job, and each stage is skipped independently when its threshold is `0`.
 */
export function createTurnGate(input: CreateTurnGateInput): TurnGate {
  const { thresholds } = input;
  const bothDisabled = thresholds.softToolCalls === 0 && thresholds.hardToolCalls === 0;
  const exemption: TurnGateExemption | null = input.budgetExempt
    ? { source: "budget_section", detail: "the card's Budget section declares a long job" }
    : bothDisabled
      ? { source: "thresholds_disabled", detail: "both turn-gate thresholds are configured to 0" }
      : null;

  const seen = new Set<string>();
  const inFlight = new Set<string>();
  let softFired = false;
  let stopped = false;

  const gate: TurnGate = {
    observe(event) {
      if (exemption) return null;
      if (stopped) return null;
      const id = event.toolCallId;
      // A call with no ID cannot be de-duplicated. Skipping it undercounts,
      // which is the safe direction: the gate fires late rather than early.
      if (!id) return null;
      seen.add(id);
      if (event.status && IN_FLIGHT_STATUSES.has(event.status)) inFlight.add(id);
      else inFlight.delete(id);

      const count = seen.size;
      const atBoundary = inFlight.size === 0;

      // The hard stop is evaluated first: once the run is past the hard
      // threshold there is nothing a soft checkpoint can usefully add.
      if (thresholds.hardToolCalls > 0 && count >= thresholds.hardToolCalls) {
        const forced = !atBoundary && count >= thresholds.hardToolCalls + thresholds.hardBoundarySlack;
        if (atBoundary || forced) {
          stopped = true;
          return { kind: "hard_stop", toolCalls: count, threshold: thresholds.hardToolCalls, forced };
        }
        return null;
      }

      if (!softFired && thresholds.softToolCalls > 0 && count >= thresholds.softToolCalls && atBoundary) {
        softFired = true;
        return { kind: "soft_checkpoint", toolCalls: count, threshold: thresholds.softToolCalls };
      }
      return null;
    },
    get toolCalls() {
      return seen.size;
    },
    get softFired() {
      return softFired;
    },
    get stopped() {
      return stopped;
    },
    get exemption() {
      return exemption;
    },
  };
  return gate;
}
