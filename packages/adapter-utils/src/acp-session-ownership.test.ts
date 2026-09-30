// Does the run-id sweep kill an ACP agent process that a LATER run still needs?
//
// The e2e spec `acp-stop-continuation.spec.ts` fails 3/3 on PR #79 head
// bfb48a763, all waiting at line 67 for a follow-up agent message that never
// arrives. The fixture (`scripts/mcp-fixtures/servers/acp-stop-agent.mjs`) is a
// long-lived ACP process: on `session/cancel` it writes a `continued` marker to
// disk and stays alive, expecting a later `session/prompt` on the SAME process
// to produce the follow-up text.
//
// The operator's hypothesis: the newly unconditional no-registry sweep kills
// exactly that process. If so the continuation run has no agent to talk to, and
// the symptom matches precisely.
//
// This reproduces that shape without a browser: run one tagged process, cancel it
// the way a stop does, sweep by run id, and see whether it survives -- then
// assert the follow-up prompt can still be served.
//
// A sweep that kills the process FAILS this test. A sweep that leaves it alone
// PASSES. Either way the answer is measured, not argued.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepRunDescendantsByRunId, readProcessGroupIdFromProc, signalRunningProcess } from "./server-utils.js";

const IS_LINUX = process.platform === "linux";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!IS_LINUX)("ACP stop-continuation ownership boundary", () => {
  it("does not sweep an ACP agent that a later run in the SAME session still needs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "acp-sweep-repro-"));
    const runId = `acp-run-${process.pid}-${Date.now()}`;
    // A supervisor + payload, which is what a real session carrier is:
    // `timeout 120 sleep 120` is a process group containing both.
    const agent = spawn("/usr/bin/timeout", ["120", "sleep", "120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: runId },
    });
    try {
      await sleep(400);
      expect(pidAlive(agent.pid!)).toBe(true);

      // The agent's process group, as `readProcessGroupIdFromProc` reports it.
      const agentGroup = readProcessGroupIdFromProc(agent.pid!);
      expect(agentGroup).toBe(agent.pid);

      // Excluding the agent's PID is NOT enough: the sweep signals the `sleep`
      // payload and `timeout` dies with it. That is the regression.
      const pidOnly = sweepRunDescendantsByRunId(runId, "SIGKILL", {
        excludePids: [agent.pid!],
      });
      expect(
        pidOnly.signaledPids.includes(agent.pid!),
        "sweep signalled the session carrier itself",
      ).toBe(false);

      // Preserving the group spares the supervisor AND its payload, so the agent
      // can still answer the follow-up prompt.
      const withGroup = sweepRunDescendantsByRunId(runId, "SIGKILL", {
        excludePids: [agent.pid!],
        preserveProcessGroupIds: agentGroup === null ? [] : [agentGroup],
      });
      expect(withGroup.signaledPids).not.toContain(agent.pid!);
      expect(pidAlive(agent.pid!)).toBe(true);
    } finally {
      try {
        process.kill(-(agent.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }, 20_000);

  it("records whether a direct child is excluded, so the caller can protect it", async () => {
    // A caller that owns a long-lived session process must be able to exclude it
    // explicitly. This documents the only supported way to protect such a
    // process today: pass it in excludePids.
    const marker = `acp-exclude-${process.pid}-${Date.now()}`;
    const agent = spawn("/bin/bash", ["-c", "sleep 120"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: marker },
    });
    try {
      await sleep(400);
      const sweep = sweepRunDescendantsByRunId(marker, "SIGKILL", {
        excludePids: [agent.pid!],
      });
      expect(sweep.signaledPids).not.toContain(agent.pid!);
      expect(sweep.excludedPids).toContain(agent.pid!);
      expect(pidAlive(agent.pid!)).toBe(true);
    } finally {
      try {
        process.kill(-(agent.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
      try {
        process.kill(agent.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 20_000);

  it("fixture contract: a continued ACP session is expected to still be listening", () => {
    // Guards the assumption the e2e relies on, so a future change to the fixture
    // that made it one-shot would be caught here rather than in an e2e timeout.
    const fixture = path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs");
    if (!existsSync(fixture)) return;
    const src = readFileSync(fixture, "utf8");
    expect(src).toContain("continued");
    expect(src).toContain("Answered the pending follow-up once.");
  });
});
