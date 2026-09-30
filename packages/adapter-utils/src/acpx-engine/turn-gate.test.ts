import { describe, expect, it } from "vitest";
import {
  budgetSectionDeclaresLongJob,
  createTurnGate,
  extractBudgetSection,
  readTurnGateBudgetExemption,
  resolveTurnGateThresholds,
  type TurnGateDecision,
  type TurnGateThresholds,
} from "./turn-gate.js";

// The gate is pure: it counts unique tool-call IDs and returns a decision. These
// tests drive it with normalized ACP tool-call events and assert the three
// behaviours KEE-440 names as verification — 40 fires the soft checkpoint once,
// 60 stops, an exempt card does neither — plus the two properties that are easy
// to get wrong: de-duplicating `tool_call_update` re-emissions, and holding the
// decision until no tool call is in flight.

function approvedThresholds(overrides: Partial<TurnGateThresholds> = {}): TurnGateThresholds {
  return { softToolCalls: 40, hardToolCalls: 60, hardBoundarySlack: 5, ...overrides };
}

/**
 * Drive `count` complete tool calls through the gate and collect every decision.
 * Each call is emitted as ACP emits one: an initial `pending` event followed by a
 * `completed` update carrying the same ID.
 */
function runCalls(
  gate: ReturnType<typeof createTurnGate>,
  count: number,
  startAt = 1,
): TurnGateDecision[] {
  const decisions: TurnGateDecision[] = [];
  for (let i = startAt; i < startAt + count; i += 1) {
    const toolCallId = `call-${i}`;
    for (const status of ["pending", "completed"]) {
      const decision = gate.observe({ toolCallId, status });
      if (decision) decisions.push(decision);
    }
  }
  return decisions;
}

describe("createTurnGate", () => {
  it("fires the soft checkpoint exactly once, at the 40th tool call", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    const first = runCalls(gate, 39);
    expect(first).toEqual([]);
    expect(gate.softFired).toBe(false);

    const atForty = runCalls(gate, 1, 40);
    expect(atForty).toEqual([{ kind: "soft_checkpoint", toolCalls: 40, threshold: 40 }]);
    expect(gate.softFired).toBe(true);

    // Calls 41-59 are past the soft threshold but must not re-fire it.
    const after = runCalls(gate, 19, 41);
    expect(after).toEqual([]);
    expect(gate.stopped).toBe(false);
  });

  it("hard-stops at the 60th tool call and returns nothing afterwards", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    const decisions = runCalls(gate, 60);
    expect(decisions).toEqual([
      { kind: "soft_checkpoint", toolCalls: 40, threshold: 40 },
      { kind: "hard_stop", toolCalls: 60, threshold: 60, forced: false },
    ]);
    expect(gate.stopped).toBe(true);

    // A stopped gate is inert: the engine has already cancelled the turn, and
    // late events from the drain must not produce a second decision.
    expect(runCalls(gate, 5, 61)).toEqual([]);
  });

  it("does neither stage when the card's Budget section declares a long job", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: true });
    expect(runCalls(gate, 120)).toEqual([]);
    expect(gate.softFired).toBe(false);
    expect(gate.stopped).toBe(false);
    expect(gate.exemption).toEqual({
      source: "budget_section",
      detail: "the card's Budget section declares a long job",
    });
  });

  it("does neither stage when both thresholds are configured to 0", () => {
    const gate = createTurnGate({
      thresholds: approvedThresholds({ softToolCalls: 0, hardToolCalls: 0 }),
      budgetExempt: false,
    });
    expect(runCalls(gate, 120)).toEqual([]);
    expect(gate.exemption?.source).toBe("thresholds_disabled");
  });

  it("counts unique tool-call IDs, not events", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    // 200 events, all re-emissions of the same call. Counting events would trip
    // both stages here; counting IDs trips neither.
    for (let i = 0; i < 100; i += 1) {
      expect(gate.observe({ toolCallId: "call-1", status: "pending" })).toBeNull();
      expect(gate.observe({ toolCallId: "call-1", status: "in_progress" })).toBeNull();
    }
    expect(gate.toolCalls).toBe(1);
  });

  it("ignores events with no tool-call ID rather than counting them", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    for (let i = 0; i < 100; i += 1) expect(gate.observe({ toolCallId: "" })).toBeNull();
    expect(gate.toolCalls).toBe(0);
  });

  it("holds the hard stop while a tool call is still in flight", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    runCalls(gate, 59);
    // The 60th call opens and does not complete. Cancelling here would land
    // mid-tool-call, which costs a cold session on resume.
    expect(gate.observe({ toolCallId: "call-60", status: "pending" })).toBeNull();
    expect(gate.stopped).toBe(false);
    // It completes; the boundary is now clean and the stop fires.
    expect(gate.observe({ toolCallId: "call-60", status: "completed" })).toEqual({
      kind: "hard_stop",
      toolCalls: 60,
      threshold: 60,
      forced: false,
    });
  });

  it("forces the hard stop once the boundary slack is exhausted", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    runCalls(gate, 59);
    // A batch of calls that never report a terminal status must not be able to
    // hold the gate open indefinitely.
    const decisions: TurnGateDecision[] = [];
    for (let i = 60; i <= 66; i += 1) {
      const decision = gate.observe({ toolCallId: `call-${i}`, status: "pending" });
      if (decision) decisions.push(decision);
    }
    expect(decisions).toEqual([{ kind: "hard_stop", toolCalls: 65, threshold: 60, forced: true }]);
  });

  it("holds the soft checkpoint to a clean boundary too", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    runCalls(gate, 39);
    expect(gate.observe({ toolCallId: "call-40", status: "pending" })).toBeNull();
    expect(gate.observe({ toolCallId: "call-40", status: "completed" })).toEqual({
      kind: "soft_checkpoint",
      toolCalls: 40,
      threshold: 40,
    });
  });

  it("treats an absent or unknown status as settled", () => {
    const gate = createTurnGate({ thresholds: approvedThresholds(), budgetExempt: false });
    const decisions: TurnGateDecision[] = [];
    for (let i = 1; i <= 40; i += 1) {
      const decision = gate.observe({ toolCallId: `call-${i}` });
      if (decision) decisions.push(decision);
    }
    expect(decisions).toEqual([{ kind: "soft_checkpoint", toolCalls: 40, threshold: 40 }]);
  });
});

describe("resolveTurnGateThresholds", () => {
  it("takes the board-approved defaults when the config says nothing", () => {
    expect(resolveTurnGateThresholds({})).toEqual({
      softToolCalls: 40,
      hardToolCalls: 60,
      hardBoundarySlack: 5,
    });
  });

  it("reads configured thresholds, so the gate changes without a redeploy", () => {
    expect(resolveTurnGateThresholds({ turnGateSoftToolCalls: 25, turnGateHardToolCalls: 45 })).toMatchObject({
      softToolCalls: 25,
      hardToolCalls: 45,
    });
  });

  it("treats an explicit 0 as unlimited", () => {
    expect(resolveTurnGateThresholds({ turnGateSoftToolCalls: 0, turnGateHardToolCalls: 0 })).toMatchObject({
      softToolCalls: 0,
      hardToolCalls: 0,
    });
  });

  it("falls back to the defaults on a malformed value rather than disabling the gate", () => {
    // A typo must not silently switch enforcement off.
    expect(resolveTurnGateThresholds({ turnGateSoftToolCalls: "forty", turnGateHardToolCalls: -1 })).toMatchObject({
      softToolCalls: 40,
      hardToolCalls: 60,
    });
  });
});

describe("extractBudgetSection", () => {
  it("returns the Budget section and stops at the next same-level heading", () => {
    const markdown = [
      "## Where",
      "engine code",
      "",
      "## Budget",
      "Long job: yes",
      "",
      "## Not in scope",
      "Long job: yes",
    ].join("\n");
    expect(extractBudgetSection(markdown)).toBe("Long job: yes");
  });

  it("returns an empty string when the card has no Budget section", () => {
    expect(extractBudgetSection("## Where\nengine code\n")).toBe("");
  });
});

describe("budgetSectionDeclaresLongJob", () => {
  it("accepts the explicit declarations", () => {
    for (const line of [
      "Long job: yes",
      "long-job: true",
      "- **Long job:** yes",
      "Turn gate: off",
      "`turn gate` = unlimited",
    ]) {
      expect(budgetSectionDeclaresLongJob(`## Budget\n${line}\n`)).toBe(true);
    }
  });

  it("does not exempt on prose that merely mentions a long job", () => {
    // This is KEE-440's own Budget section plus the phrase from its "Not in
    // scope" section. Neither may exempt the card.
    const markdown = [
      "## Budget",
      "A few runs. Needs judgement on the mechanism.",
      "If this exceeds 4 runs, stop and come back on this card.",
      "",
      "## Not in scope",
      "- Do not enforce the gate on cards whose `Budget` section declares a long job.",
    ].join("\n");
    expect(budgetSectionDeclaresLongJob(markdown)).toBe(false);
  });

  it("does not exempt when the declaration says the gate stays on", () => {
    expect(budgetSectionDeclaresLongJob("## Budget\nTurn gate: on\n")).toBe(false);
    expect(budgetSectionDeclaresLongJob("## Budget\nLong job: no\n")).toBe(false);
  });

  it("ignores a declaration outside the Budget section", () => {
    expect(budgetSectionDeclaresLongJob("## Where\nLong job: yes\n\n## Budget\nA few runs.\n")).toBe(false);
  });
});

describe("readTurnGateBudgetExemption", () => {
  it("reads the full task markdown the engine already holds at run start", () => {
    expect(readTurnGateBudgetExemption({ paperclipTaskMarkdown: "## Budget\nLong job: yes\n" })).toBe(true);
  });

  it("falls back to the issue description", () => {
    expect(
      readTurnGateBudgetExemption({ paperclipIssue: { description: "## Budget\nTurn gate: off\n" } }),
    ).toBe(true);
  });

  it("is false for a card with no declaration, and for an empty context", () => {
    expect(readTurnGateBudgetExemption({ paperclipTaskMarkdown: "## Budget\nA few runs.\n" })).toBe(false);
    expect(readTurnGateBudgetExemption({})).toBe(false);
    expect(readTurnGateBudgetExemption(null)).toBe(false);
  });
});
