/**
 * Provider selection for board chat.
 *
 * Board chat spawns a coding-agent CLI and streams its output back to the
 * browser. Which CLI that is used to be hardcoded (`claude`, `--model sonnet`),
 * which tied the operator's own console to one vendor's subscription — the same
 * one their agents may already be competing for. This module makes the binary,
 * the model and the argument shape a configuration choice, and keeps the
 * per-vendor stream parsing in one place.
 *
 * Defaults are unchanged from the hardcoded behaviour: Claude, model `sonnet`.
 */

export type BoardChatProviderId = "claude" | "codex";

/** What one line of provider stdout means to the chat transport. */
export interface BoardChatStreamUpdate {
  /** Assistant text to append and forward to the browser. */
  chunks: string[];
  /** Human-readable activity line, e.g. "Running a command...". */
  status?: string;
}

export interface BoardChatProvider {
  id: BoardChatProviderId;
  /** Executable to spawn. */
  command: string;
  /** Model identifier passed to that executable. */
  model: string;
  /**
   * True when the provider emits token-level deltas. Providers that only emit
   * whole messages still render, just not token-by-token.
   */
  streamsDeltas: boolean;
  /** Arguments for the spawn. The prompt always arrives on stdin. */
  args: string[];
  /**
   * Text written to the child's stdin. Providers without a system-prompt flag
   * receive the skill inline, ahead of the conversation.
   */
  buildStdin(systemPrompt: string, prompt: string): string;
  /** Interpret one parsed stdout line. */
  parseEvent(event: unknown): BoardChatStreamUpdate;
}

const EMPTY: BoardChatStreamUpdate = { chunks: [] };

function describeTool(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "command_execution") return "Running a command...";
  if (name === "read") return "Reading a file...";
  if (name === "grep") return "Searching...";
  if (name === "file_change" || name === "patch") return "Editing files...";
  if (name === "web_search") return "Searching the web...";
  return `Using ${toolName}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Claude Code. Emits `stream_event`-wrapped Anthropic deltas when asked for
 * partial messages, then a terminal `assistant` message carrying the same text
 * — so the full message is only consumed when no delta was seen, otherwise the
 * reply would render twice.
 */
function createClaudeProvider(command: string, model: string): BoardChatProvider {
  let sawDelta = false;
  return {
    id: "claude",
    command,
    model,
    streamsDeltas: true,
    args: [
      "-p",
      "-",
      "--output-format",
      "stream-json",
      // Emit content_block_delta events so the UI renders token-by-token
      // rather than a single block once the whole turn completes.
      "--include-partial-messages",
      "--verbose",
      "--model",
      model,
      "--dangerously-skip-permissions",
    ],
    buildStdin(_systemPrompt, prompt) {
      // The skill goes in via --append-system-prompt, appended by the caller,
      // so stdin carries the conversation alone.
      return prompt;
    },
    parseEvent(event) {
      if (!isRecord(event)) return EMPTY;
      const outer = event as Record<string, any>;
      const inner = outer.type === "stream_event" ? outer.event : outer;
      if (!isRecord(inner)) return EMPTY;
      const node = inner as Record<string, any>;

      if (node.type === "content_block_delta" && node.delta?.text) {
        sawDelta = true;
        return { chunks: [String(node.delta.text)] };
      }
      if (node.type === "content_block_start" && node.content_block?.type === "tool_use") {
        return { chunks: [], status: describeTool(String(node.content_block.name ?? "working")) };
      }
      if (outer.type === "assistant" && Array.isArray(outer.message?.content)) {
        if (sawDelta) return EMPTY;
        const chunks = outer.message.content
          .filter((b: any) => b?.type === "text" && b.text)
          .map((b: any) => String(b.text));
        return { chunks };
      }
      if (outer.type === "result" && typeof outer.result === "string" && !sawDelta) {
        return { chunks: [outer.result] };
      }
      return EMPTY;
    },
  };
}

/**
 * Codex. Emits JSONL thread/turn/item events and has no token deltas: an
 * `agent_message` item arrives complete, and a turn may contain several. It
 * also has no system-prompt flag, so the skill is prepended to stdin.
 */
function createCodexProvider(command: string, model: string): BoardChatProvider {
  return {
    id: "codex",
    command,
    model,
    streamsDeltas: false,
    args: [
      "exec",
      "--json",
      // Board chat runs from a scratch cwd, which is not a repository.
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `model=${JSON.stringify(model)}`,
      "-",
    ],
    buildStdin(systemPrompt, prompt) {
      // No --append-system-prompt equivalent, so the skill leads the turn.
      // Delimited so the model can tell operating instructions from the
      // conversation it is being asked to continue.
      return `${systemPrompt}\n\n---\n\n${prompt}`;
    },
    parseEvent(event) {
      if (!isRecord(event)) return EMPTY;
      const node = event as Record<string, any>;
      const item = isRecord(node.item) ? (node.item as Record<string, any>) : null;
      if (!item) return EMPTY;

      if (node.type === "item.completed" && item.type === "agent_message" && item.text) {
        return { chunks: [String(item.text)] };
      }
      // Announce work when it starts; the matching completion would duplicate.
      if (node.type === "item.started" && typeof item.type === "string") {
        return { chunks: [], status: describeTool(item.type) };
      }
      return EMPTY;
    },
  };
}

function normalizeProviderId(value: string | undefined): BoardChatProviderId {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "codex" ? "codex" : "claude";
}

const DEFAULT_MODELS: Record<BoardChatProviderId, string> = {
  claude: "sonnet",
  codex: "gpt-5.6-sol",
};

/**
 * Resolve the provider from the environment.
 *
 * `PAPERCLIP_BOARD_CHAT_PROVIDER`  claude | codex   (default claude)
 * `PAPERCLIP_BOARD_CHAT_MODEL`     model id         (default per provider)
 * `PAPERCLIP_BOARD_CHAT_COMMAND`   executable       (default = provider id)
 */
export function resolveBoardChatProvider(
  env: NodeJS.ProcessEnv = process.env,
): BoardChatProvider {
  const id = normalizeProviderId(env.PAPERCLIP_BOARD_CHAT_PROVIDER);
  const model = env.PAPERCLIP_BOARD_CHAT_MODEL?.trim() || DEFAULT_MODELS[id];
  const command = env.PAPERCLIP_BOARD_CHAT_COMMAND?.trim() || id;
  return id === "codex"
    ? createCodexProvider(command, model)
    : createClaudeProvider(command, model);
}
