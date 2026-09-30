/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */
import { classifyHermesProviderFailure } from "./provider-failure.js";

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  HERMES_ARGV_PROMPT_LIMIT_BYTES,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";
import {
  hermesCommandSupportsQueryFile,
  promptExceedsArgvLimit,
} from "./cli-capabilities.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

/**
 * Drop bare `--` end-of-options markers from operator-supplied extraArgs.
 *
 * `hermes chat` is a CPython argparse subparser and it declares no positional
 * arguments, so a bare `--` in argv ends option parsing and every remaining
 * token is then rejected as an unrecognised argument. It can never make a
 * following token do anything useful here, so keeping it can only turn a run
 * into a usage error.
 *
 * Removing it is not "silently dropping a flag the operator set": a config that
 * already carries a bare `--` already fails today, so this converts an
 * already-broken run into a working one rather than breaking a working config.
 * The caller logs the change so the edit is never silent.
 *
 * Only an exact `--` is removed. A value that merely starts with two hyphens
 * (`--foo`, `-p`) is a real option and is left alone.
 */
export function stripBareDoubleDash(args: string[]): {
  args: string[];
  removed: number;
} {
  const kept = args.filter((a) => a !== "--");
  return { args: kept, removed: args.length - kept.length };
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate) || (context.conversationMode === true
    ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
    : HERMES_DEFAULT_PROMPT_TEMPLATE);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const paperclipTaskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: options.resumedSession === true,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    conversationMode: context.conversationMode === true,
    resumedSession: options.resumedSession === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: paperclipTaskMarkdown.length > 0,
  });
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);
  return joinPromptSections([
    wakePrompt,
    sessionHandoffMarkdown,
    paperclipTaskMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/**
 * Hermes in quiet mode (`-Q`) deliberately routes its session-resume status
 * lines to stderr so that stdout stays machine-readable. Those lines are
 * informational.
 *
 * See `hermes_cli/cli_agent_setup_mixin.py` `_say()`: the `_say()` helper prints
 * to `sys.stderr` in quiet mode, and every successful resume goes through it.
 * Only the two shapes below are informational, and each is matched in full
 * rather than by prefix, so a diagnostic that happens to share the line is
 * still judged on its own words (review finding R4).
 */
const RESUME_BANNER_REGEX =
  /^\s*↻\s*Resumed session\s+\S+(?:\s+".*")?\s*\(\d+ user messages?(?:, \d+ total messages?)?\)\s*$/i;

const RESUME_NO_MESSAGES_REGEX =
  /^Session\s+\S+\s+found but has no messages\.?\s*Starting fresh\.?$/i;

/**
 * A single line of stderr is treated as a genuine failure only when it names a
 * failure word as a whole word.
 *
 * The previous pattern was `/error|exception|traceback|failed/i`, unanchored,
 * so it matched any line that merely *contained* one of those letters
 * sequences. A resumed session whose title read "Set Sam's exceptional approval
 * boundaries" contains the substring "exception" inside the word
 * "exceptional", which made an exit-0 run that had already saved its task
 * outcome report as `adapter_failed` (live run
 * ea8f13f4-2c62-461a-a763-2f52d54d9049). Word boundaries fix that class of
 * false positive without suppressing a real diagnostic: "Error:",
 * "Exception:", "Traceback" and "call failed" all still match.
 */
const STDERR_FAILURE_WORD_REGEX = /\b(?:errors?|exceptions?|tracebacks?|failed|failure)\b/i;

/**
 * Python exception class names are CamelCase compounds in which the failure
 * word is glued to a prefix, so `\bError\b` does not match `RuntimeError` or
 * `ValueError`. Those are genuine failures and must keep being reported, so a
 * PascalCase identifier that *ends* in a failure word counts too. The leading
 * capital is what keeps this from re-ignoring lowercase prose such as
 * "exceptional".
 */
const STDERR_FAILURE_IDENTIFIER_REGEX = /\b[A-Z]\w*(?:Error|Exception|Traceback)\b/;

/**
 * Review finding R1: the typed provider vocabulary is snake_case, so neither
 * rule above sees it. `overloaded_error` is a literal alternative in
 * `provider-failure.ts` `TRANSIENT_PATTERN` and the KEE-593 classifier is only
 * ever called once an `errorMessage` exists, so a run that printed
 * `HTTP 503: Service Unavailable (overloaded_error)` on exit 0 was recorded as
 * a *success* while the provider was overloaded. This matches an identifier
 * token — a run of word characters, optionally joined by `_` — whose final
 * underscore-separated segment is a failure word. Requiring a word character
 * immediately before the keyword is what keeps it from re-ignoring "exceptional"
 * or "exceptionally": the character before `error` must not be a letter.
 */
const STDERR_FAILURE_SNAKE_REGEX = /\b\w*(?:[a-z0-9]_)*(?:error|exception|traceback)\b/i;

/**
 * Review finding R2: `errored` and `Erroring` are Hermes' own vocabulary for a
 * failed unit of work, not hypothetical English. Real call sites in the
 * installed tree: `agent/lsp/install.py:155,226` ("install errored for"),
 * `agent/error_surface.py:9` ("gateway (local runtime errored)") and
 * `cron/jobs.py:905` ("a job that has been sitting errored").
 *
 * These are matched as whole words only. "Errored" is therefore a failure while
 * "Erroring out:" is one via the trailing form, and neither matches "errored"
 * embedded in a longer word.
 */
const STDERR_FAILURE_INFLECTION_REGEX = /\b(?:errored|Erroring)\b/;

/**
 * Recognise a known-informational stderr line so it cannot be mistaken for a
 * runtime failure. Kept deliberately narrow: an allow-list of the exact
 * informational shapes, not a suppression of stderr as a whole.
 */
function isInformationalStderrLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return RESUME_BANNER_REGEX.test(trimmed) || RESUME_NO_MESSAGES_REGEX.test(trimmed);
}

/**
 * True when a stderr line names a genuine runtime or provider failure.
 *
 * Order matters only for readability: the informational allow-list is applied by
 * the caller before this, so a known banner is never judged as a failure.
 */
function isFailureStderrLine(line: string): boolean {
  return (
    STDERR_FAILURE_WORD_REGEX.test(line) ||
    STDERR_FAILURE_IDENTIFIER_REGEX.test(line) ||
    STDERR_FAILURE_SNAKE_REGEX.test(line) ||
    STDERR_FAILURE_INFLECTION_REGEX.test(line)
  );
}

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr.
  //
  // A line counts as a failure only when it names a failure word as a whole
  // word, and never when it is a known-informational startup/resume banner.
  // The old unanchored `/error|exception|traceback|failed/i` substring scan
  // turned a resume banner whose session title contained "exceptional" into a
  // spurious `adapter_failed` on an exit-0 run (KEE-1154, live run
  // ea8f13f4-2c62-461a-a763-2f52d54d9049). stderr is still scanned: this is not
  // a blanket ignore of stderr on exit 0, so a real exit-0 provider failure
  // keeps producing an errorMessage and keeps reaching the typed
  // provider-failure classifier below.
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => !isInformationalStderrLine(line))
      .filter((line) => isFailureStderrLine(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, inject that bundle into the Hermes prompt.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  let prompt = buildPrompt(ctx, config, { resumedSession: Boolean(prevSessionId) });
  if (agentInstructions) {
    prompt = agentInstructions + "\n\n---\n\n" + prompt;
  }

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) === true; // default false
  const args: string[] = ["chat"];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  if (persistSession && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    // Argparse ordering: this block runs before the prompt transport flag is
    // chosen below, so an operator's extraArgs land on argv AHEAD of `-q
    // <prompt>` / `--query-file -`. A bare `--` among them ends option parsing
    // for everything after, which includes the transport flag itself, so
    // hermes would take the query option as positional text and reject the
    // run. Removing the bare marker is what keeps the prompt bound to its flag;
    // the order of the remaining tokens is irrelevant to argparse.
    const stripped = stripBareDoubleDash(extraArgs);
    if (stripped.removed > 0) {
      await ctx.onLog(
        "stdout",
        `[hermes] Ignored ${stripped.removed} bare "--" token(s) in the configured extraArgs: \`hermes chat\` takes no positional arguments, so an end-of-options marker there can only produce a usage error.\n`,
      );
    }
    args.push(...stripped.args);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  // Wake context travels in the prompt; drop both inherited and configured copies.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Choose the prompt transport ────────────────────────────────────────
  // `hermes chat -q <prompt>` puts the whole prompt in ONE argv string. Linux
  // caps a single argv string at MAX_ARG_STRLEN (131072 bytes) even though
  // ARG_MAX is 2097152, so a long wake history plus the agent instructions
  // makes spawn() fail with E2BIG and the agent never starts.
  // `hermes chat --query-file -` reads the same query from stdin, which has no
  // per-string ceiling, so a prompt at or above the limit takes that path.
  //
  // The decision is made only for prompts that exceed the limit, so ordinary
  // runs keep today's single-spawn argv behaviour with no extra process. The
  // probe is not cached either: an operator can upgrade Hermes while the server
  // runs, and the next oversized run should pick that up without a restart.
  //
  // This block must stay after `env` and `cwd` are resolved, since the probe
  // runs the operator's configured binary in the run's working directory.
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const useQueryFile = promptExceedsArgvLimit(prompt);
  if (useQueryFile) {
    const supported = await hermesCommandSupportsQueryFile({
      command: hermesCmd,
      cwd,
      env,
      // The probe is a child of the Paperclip server, so a cancelled run must
      // take it down with it rather than leaving it running untracked.
      signal: ctx.signal,
    });
    if (supported === true) {
      // -q and --query-file are mutually exclusive in hermes' own parser, so
      // the query argument is left off argv entirely in this branch.
      args.push("--query-file", "-");
      await ctx.onLog(
        "stdout",
        `[hermes] Prompt is ${promptBytes} bytes, at or above the ${HERMES_ARGV_PROMPT_LIMIT_BYTES}-byte single-argument limit; sending it on stdin via --query-file -.\n`,
      );
    } else if (ctx.signal?.aborted) {
      // The probe reports "inconclusive" for every reason it could not reach a
      // conclusion, and operator cancellation is one of them. Blaming the CLI
      // here would be wrong twice over: it tells the operator to upgrade
      // Hermes when the real answer is that they stopped this run, and
      // heartbeat.ts records this message as the run error. Report the
      // cancellation the acpx engine already reports, so the run is
      // classified as cancelled rather than as a capability failure.
      await ctx.onLog(
        "stderr",
        `[hermes] Run cancelled while probing this hermes CLI for --query-file support; the prompt is ${promptBytes} bytes.\n`,
      );
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "cancelled",
        errorMessage: "Stopped before provider startup",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        provider: resolvedProvider,
        model,
      } satisfies AdapterExecutionResult;
    } else {
      // The CLI cannot take the prompt on stdin. Passing it as one argument
      // would fail in spawn() with a bare E2BIG that names neither the size
      // nor the cause, so refuse here and say what to do about it.
      await ctx.onLog(
        "stderr",
        `[hermes] Prompt is ${promptBytes} bytes, at or above the ${HERMES_ARGV_PROMPT_LIMIT_BYTES}-byte single-argument limit, but this hermes CLI does not support --query-file (probe result: ${supported === false ? "not advertised" : "inconclusive"}). Upgrade Hermes Agent, or reduce the agent instructions and the wake history, and retry.\n`,
      );
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: `Hermes prompt is ${promptBytes} bytes, which exceeds the ${HERMES_ARGV_PROMPT_LIMIT_BYTES}-byte single-argument limit, and this hermes CLI does not support --query-file.`,
        provider: resolvedProvider,
        model,
      } satisfies AdapterExecutionResult;
    }
  } else {
    args.push("-q", prompt);
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: wrappedOnLog,
    onSpawn: ctx.onSpawn,
    // Only the stdin branch carries the prompt. Leaving this undefined in the
    // argv branch keeps runChildProcess's stdio as "ignore" for stdin, exactly
    // as before, so hermes keeps seeing a non-TTY stdin in both transports.
    stdin: useQueryFile ? prompt : undefined,
  });

  // A child that exits before draining stdin makes the write fail with EPIPE.
  // On this transport that means the prompt may have been truncated or never
  // reached the CLI, so the operator needs the distinction: "Hermes answered
  // with exit 0" and "Hermes exited before reading the prompt" are not the
  // same run, and without this line they look identical in the log.
  if (useQueryFile && result.stdinWriteError) {
    await ctx.onLog(
      "stderr",
      `[hermes] stdin write failed: ${result.stdinWriteError}. The prompt may not have reached the hermes CLI in full.\n`,
    );
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
    executionResult.errorMessage = `Hermes exited with code ${result.exitCode}`;
  }

  // Hermes reports provider failures as rendered text, so translate them into
  // the same typed vocabulary the ACP adapters emit. Without this the heartbeat
  // sees an opaque `adapter_failed` and retries terminal conditions forever.
  // A timeout is excluded: the harness already classified it, and provider text
  // quoted in a timed-out run is not evidence about the run's own failure.
  if (executionResult.errorMessage && !result.timedOut) {
    const failure = classifyHermesProviderFailure(
      `${result.stderr || ""}\n${result.stdout || ""}`,
    );
    if (failure) {
      executionResult.errorCode = failure.errorCode;
      if (failure.errorFamily) executionResult.errorFamily = failure.errorFamily;
      if (failure.retryDelaySec != null) {
        executionResult.retryNotBefore = new Date(
          Date.now() + failure.retryDelaySec * 1000,
        ).toISOString();
      }
    }
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
