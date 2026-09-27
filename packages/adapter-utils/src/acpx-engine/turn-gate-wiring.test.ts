// The turn gate, wired into the engine's event relay (KEE-440).
//
// `turn-gate.test.ts` covers the counter in isolation. These tests cover the
// thing the counter cannot prove on its own: that a gate decision actually
// cancels the live turn, that the engine then runs a *second* turn on the same
// session carrying the checkpoint or handback prompt, and that the second turn's
// terminal — not the cancel we caused — becomes the run's outcome.
//
// That last property is the one worth guarding. If the gate's cancel leaked out
// as the run's terminal, every gated run would record as `cancelled`: exit code
// 1, a failed run, and `discardPersistentState` throwing away the session. The
// gate would then read as a spike of failures rather than a saving.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(actual.startAdapterExecutionTargetPaperclipBridge),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(actual.startAdapterExecutionTargetProcessSessionBridge),
  };
});
import { createAcpxEngineExecutor } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-turn-gate-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }).catch(() => {})));
});

interface StartedTurnRecord {
  readonly text: string;
  readonly cancelReasons: string[];
}

/**
 * A runtime that emits `toolCalls` distinct tool calls on its first turn and
 * finishes immediately on every turn after that. Each tool call is emitted as a
 * `tool_call` then a `tool_call_update` completion, which is what ACP really
 * does — and which is exactly what would trip a gate that counted events rather
 * than unique ids.
 *
 * The generator keeps yielding after a cancel, mirroring a real runtime draining
 * the events it had already produced. A gate that stopped mid-stream instead of
 * draining would drop those from the transcript.
 */
function gateRuntime(input: { firstTurnToolCalls: number; onTurn?: (text: string) => void }) {
  const started: StartedTurnRecord[] = [];
  const runtime = {
    ensureSession: async () => ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
    }),
    startTurn: (turnInput: Record<string, unknown>) => {
      const text = String(turnInput.text ?? "");
      const record: StartedTurnRecord = { text, cancelReasons: [] };
      const isFirst = started.length === 0;
      started.push(record);
      input.onTurn?.(text);
      const count = isFirst ? input.firstTurnToolCalls : 0;
      return {
        requestId: String(turnInput.requestId ?? ""),
        events: (async function* () {
          for (let i = 1; i <= count; i += 1) {
            yield { type: "tool_call", tag: "tool_call", toolCallId: `call-${i}`, title: "Bash", status: "pending" };
            yield {
              type: "tool_call",
              tag: "tool_call_update",
              toolCallId: `call-${i}`,
              title: "Bash",
              status: "completed",
            };
          }
          yield { type: "text_delta", stream: "output", text: isFirst ? "first turn output" : "handback written" };
        })(),
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async ({ reason }: { reason: string }) => {
          record.cancelReasons.push(reason);
        },
        closeStream: async () => {},
      };
    },
    close: async () => {},
  };
  return { runtime, started };
}

async function runWithGate(input: {
  firstTurnToolCalls: number;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
}) {
  const root = await makeTempRoot();
  const stateDir = path.join(root, "state");
  const { runtime, started } = gateRuntime({ firstTurnToolCalls: input.firstTurnToolCalls });
  const logs: Record<string, unknown>[] = [];
  const execute = createAcpxEngineExecutor({ createRuntime: () => runtime as never });
  const result = await execute({
    runId: "run-turn-gate",
    agent: { id: "agent-1", companyId: "company-1" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      timeoutSec: 120,
      ...input.config,
    },
    context: input.context ?? {},
    // The engine emits run-log entries as JSON lines on a named stream.
    onLog: async (_stream: string, line: string) => {
      for (const part of String(line).split("\n")) {
        if (!part.trim()) continue;
        try {
          logs.push(JSON.parse(part) as Record<string, unknown>);
        } catch {
          // Not every line is JSON; the gate's lines are.
        }
      }
    },
    onMeta: async () => {},
  } as never);
  return { result, started, logs };
}

const LONG_JOB_CARD = ["# A long card", "", "## Budget", "", "Long job: yes", "", "## Not in scope", "", "Nothing."].join("\n");

describe("turn gate wiring", () => {
  it("runs one turn and never cancels when the run stays under both thresholds", async () => {
    const { result, started } = await runWithGate({
      firstTurnToolCalls: 5,
      config: { turnGateSoftToolCalls: 40, turnGateHardToolCalls: 60 },
    });

    expect(started).toHaveLength(1);
    expect(started[0].cancelReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("cancels at the hard stop and runs a handback turn whose result becomes the run outcome", async () => {
    const { result, started, logs } = await runWithGate({
      firstTurnToolCalls: 10,
      // Soft disabled, so this test isolates stage 2.
      config: { turnGateSoftToolCalls: 0, turnGateHardToolCalls: 4 },
    });

    // Two turns: the gated one and the handback.
    expect(started).toHaveLength(2);
    // The first turn was cancelled, once, with the gate's reason.
    expect(started[0].cancelReasons).toEqual(["paperclip turn gate hard stop at 4 tool calls"]);
    // The second turn carries the handback instruction, not a replay of the card.
    expect(started[1].text).toContain("reaches the hard stop of 4");
    expect(started[1].text).toContain("Write a handback comment on the issue now");
    expect(started[1].text).toContain("Next action");
    expect(started[1].cancelReasons).toEqual([]);

    // The run is a success. The cancel was ours and is not the run's outcome —
    // the handback turn's completed terminal is.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorCode ?? null).toBeNull();
    expect((result.resultJson as { status?: string }).status).toBe("completed");
    // The handback text reaches the run summary, so the stop leaves evidence.
    expect(String(result.summary ?? "")).toContain("handback written");
    // The gate announced itself in the run log.
    const gateLogs = logs.filter((entry) => entry.tag === "turn_gate");
    expect(gateLogs.length).toBeGreaterThanOrEqual(2);
    expect(String(gateLogs[0].text)).toContain("hard_stop at 4 tool calls");
  });

  it("fires the soft checkpoint once and continues in a second turn", async () => {
    const { result, started } = await runWithGate({
      firstTurnToolCalls: 10,
      // Hard disabled, so this test isolates stage 1.
      config: { turnGateSoftToolCalls: 3, turnGateHardToolCalls: 0 },
    });

    expect(started).toHaveLength(2);
    expect(started[0].cancelReasons).toEqual(["paperclip turn gate soft checkpoint at 3 tool calls"]);
    // The checkpoint asks for progress and a decision, not for a full stop.
    expect(started[1].text).toContain("reaches the soft checkpoint of 3");
    expect(started[1].text).toContain("Write durable progress to the issue");
    expect(started[1].text).toContain("hand back now");
    expect(result.exitCode).toBe(0);
  });

  it("does not fire either stage when the card's Budget section declares a long job", async () => {
    const { result, started } = await runWithGate({
      firstTurnToolCalls: 10,
      config: { turnGateSoftToolCalls: 3, turnGateHardToolCalls: 4 },
      context: { paperclipTaskMarkdown: LONG_JOB_CARD },
    });

    expect(started).toHaveLength(1);
    expect(started[0].cancelReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("does not fire either stage when both thresholds are configured to 0", async () => {
    const { result, started } = await runWithGate({
      firstTurnToolCalls: 10,
      config: { turnGateSoftToolCalls: 0, turnGateHardToolCalls: 0 },
    });

    expect(started).toHaveLength(1);
    expect(started[0].cancelReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("escalates soft then hard across three turns, and leaves the handback turn ungated", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    // 3 tool calls on the first turn trips soft at 3; the continuation turn then
    // emits 3 more, taking the running total to 6 and tripping hard at 5. The
    // handback turn must not be gated again, or the run ends with no handback.
    let turnIndex = 0;
    const started: StartedTurnRecord[] = [];
    const runtime = {
      ensureSession: async () => ({
        backendSessionId: "backend-session",
        agentSessionId: "agent-session",
        runtimeSessionName: "runtime-session",
      }),
      startTurn: (turnInput: Record<string, unknown>) => {
        const record: StartedTurnRecord = { text: String(turnInput.text ?? ""), cancelReasons: [] };
        started.push(record);
        const index = turnIndex;
        turnIndex += 1;
        return {
          requestId: String(turnInput.requestId ?? ""),
          events: (async function* () {
            if (index < 2) {
              for (let i = 1; i <= 3; i += 1) {
                const id = `turn${index}-call-${i}`;
                yield { type: "tool_call", tag: "tool_call", toolCallId: id, title: "Bash", status: "pending" };
                yield { type: "tool_call", tag: "tool_call_update", toolCallId: id, title: "Bash", status: "completed" };
              }
            }
            yield { type: "text_delta", stream: "output", text: `turn ${index} output` };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async ({ reason }: { reason: string }) => {
            record.cancelReasons.push(reason);
          },
          closeStream: async () => {},
        };
      },
      close: async () => {},
    };
    const execute = createAcpxEngineExecutor({ createRuntime: () => runtime as never });
    const result = await execute({
      runId: "run-turn-gate-escalate",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        timeoutSec: 120,
        turnGateSoftToolCalls: 3,
        turnGateHardToolCalls: 5,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(started).toHaveLength(3);
    expect(started[0].cancelReasons).toEqual(["paperclip turn gate soft checkpoint at 3 tool calls"]);
    expect(started[1].text).toContain("soft checkpoint of 3");
    // The count carries across turns: the gate is run-scoped, not turn-scoped.
    expect(started[1].cancelReasons).toEqual(["paperclip turn gate hard stop at 5 tool calls"]);
    expect(started[2].text).toContain("hard stop of 5");
    // The handback turn ran ungated and was never cancelled.
    expect(started[2].cancelReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
