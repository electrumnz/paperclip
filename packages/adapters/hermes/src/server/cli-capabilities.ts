/**
 * Capability probing for the Hermes Agent CLI.
 *
 * `hermes chat` accepts the query either as `-q/--query <text>` or as
 * `--query-file <path>`, and the two are mutually exclusive in Hermes' own
 * argparse definition:
 *
 *   usage: hermes chat [-h] [-q QUERY | --query-file PATH] ...
 *     --query-file PATH  Read the single query from a file instead of the
 *                        command line ('-' reads stdin).
 *
 * A prompt passed with `-q` occupies one argv string, which Linux caps at
 * MAX_ARG_STRLEN (131072 bytes) regardless of the much larger ARG_MAX. Once
 * the wake history plus the agent instructions cross that size, `spawn()`
 * fails with E2BIG and the agent never starts. `--query-file -` moves the same
 * query onto stdin, which has no such per-string ceiling, so this module
 * probes for it rather than assuming a Hermes version.
 *
 * A version floor is not used on purpose: an operator may point
 * `hermesCommand` at a wrapper or a fork, and the only reliable signal is
 * whether that binary advertises the flag itself.
 */

import { spawn } from "node:child_process";

import { HERMES_ARGV_PROMPT_LIMIT_BYTES } from "../shared/constants.js";

export { HERMES_ARGV_PROMPT_LIMIT_BYTES };

export type HermesQueryFileProbeResult =
  /** Help text advertised `--query-file`. */
  | true
  /** Help text printed and succeeded, and the flag is absent. */
  | false
  /**
   * The probe could not reach a conclusion: the run was cancelled, the probe
   * timed out, the binary could not be spawned, or it exited non-zero without
   * printing usage. This is deliberately NOT a boolean. Treating it as
   * "no support" reports a reason that has nothing to do with the actual
   * cause, and that reason then lands in the run's error message.
   */
  | null;

/**
 * True when a prompt of this size cannot be passed as a single argv string.
 *
 * The comparison is on UTF-8 bytes, which is what the kernel counts. A prompt
 * of 40 000 astral-plane characters is 160 000 bytes and must take the stdin
 * path even though its `length` is far below the limit.
 */
export function promptExceedsArgvLimit(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") >= HERMES_ARGV_PROMPT_LIMIT_BYTES;
}

export interface HermesQueryFileProbeInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /**
   * Run-scoped operator cancellation. The probe is a child process of the
   * Paperclip server, so a cancelled run must not leave it running: on abort
   * it is killed and the probe reports "inconclusive" rather than hanging.
   */
  signal?: AbortSignal;
}

/**
 * Kill the probe and every process it started.
 *
 * The probe runs in its own process group so that a wrapper script, or a CLI
 * that shells out to a launcher, is signalled too. `signalRunningProcess`
 * cannot be used here: that registry is keyed by runId and holds the agent
 * process itself, and overwriting that entry with the probe's would hand
 * operator cancellation to the wrong pid.
 */
function killProbeTree(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group may already be gone, or the child never became a group
      // leader; fall through to signalling the child directly.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Ask the CLI whether it supports `--query-file`.
 *
 * Returns true when the flag is advertised, false when the help output is
 * conclusive and lacks it, and null when the probe itself is inconclusive
 * (timeout, cancellation, non-zero exit that still printed help, spawn
 * failure). A null result must not be treated as support: guessing wrong
 * either way produces a run that cannot start.
 */
export async function hermesCommandSupportsQueryFile(
  input: HermesQueryFileProbeInput,
): Promise<boolean | null> {
  const timeoutMs = Math.max(1000, Math.min(input.timeoutMs ?? 20_000, 60_000));
  const signal = input.signal;

  if (signal?.aborted) return null;

  return new Promise<boolean | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const finish = (value: boolean | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, ["chat", "--help"], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        // Own process group, so the kill below reaches anything the CLI spawns.
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }

    // SIGKILL rather than SIGTERM: the probe only reads help text, and a
    // wedged CLI that ignores SIGTERM must not outlive the timeout.
    timer = setTimeout(() => {
      killProbeTree(child);
      finish(null);
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        killProbeTree(child);
        finish(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // A child that cannot start emits 'error' asynchronously. Unhandled, that
    // is an uncaught exception that would take down the Paperclip server.
    child.on("error", () => finish(null));

    let out = "";
    const collect = (chunk: Buffer | string) => {
      // Cap the buffer: help text is a few kilobytes, and a misbehaving
      // binary must not be able to grow this string without bound.
      if (out.length < 64 * 1024) out += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("close", (code) => {
      // `--query-file` is the flag as argparse prints it. Match it as a whole
      // option so unrelated help prose mentioning "query file" cannot produce
      // a false positive.
      if (/(^|\s)--query-file(\s|$)/.test(out)) return finish(true);
      // Conclusive absence requires help that actually printed and succeeded.
      if (code === 0 && out.trim().length > 0) return finish(false);
      finish(null);
    });
  });
}
