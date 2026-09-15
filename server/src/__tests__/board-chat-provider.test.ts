import { describe, expect, it } from "vitest";
import { resolveBoardChatProvider } from "../services/board-chat-provider.js";

/**
 * Event fixtures are transcripts captured from the real CLIs, not invented
 * shapes — the parsers exist to absorb vendor differences, so inventing the
 * differences would defeat the test.
 */
describe("resolveBoardChatProvider", () => {
  it("defaults to Claude on sonnet, preserving the previous hardcoded behaviour", () => {
    const provider = resolveBoardChatProvider({});
    expect(provider.id).toBe("claude");
    expect(provider.command).toBe("claude");
    expect(provider.model).toBe("sonnet");
    expect(provider.args).toContain("--dangerously-skip-permissions");
    expect(provider.args).toContain("sonnet");
  });

  it("selects Codex and its default model", () => {
    const provider = resolveBoardChatProvider({ PAPERCLIP_BOARD_CHAT_PROVIDER: "codex" });
    expect(provider.id).toBe("codex");
    expect(provider.command).toBe("codex");
    expect(provider.model).toBe("gpt-5.6-sol");
    expect(provider.args[0]).toBe("exec");
    // Board chat runs from a scratch cwd that is not a repository.
    expect(provider.args).toContain("--skip-git-repo-check");
  });

  it("honours explicit model and command overrides", () => {
    const provider = resolveBoardChatProvider({
      PAPERCLIP_BOARD_CHAT_PROVIDER: "codex",
      PAPERCLIP_BOARD_CHAT_MODEL: "gpt-6-astra",
      PAPERCLIP_BOARD_CHAT_COMMAND: "/opt/bin/codex",
    });
    expect(provider.command).toBe("/opt/bin/codex");
    expect(provider.model).toBe("gpt-6-astra");
    expect(provider.args.join(" ")).toContain("gpt-6-astra");
  });

  it("falls back to Claude for an unrecognised provider rather than failing to chat", () => {
    expect(resolveBoardChatProvider({ PAPERCLIP_BOARD_CHAT_PROVIDER: "wat" }).id).toBe("claude");
  });

  it("gives Codex the skill on stdin, since it has no system-prompt flag", () => {
    const codex = resolveBoardChatProvider({ PAPERCLIP_BOARD_CHAT_PROVIDER: "codex" });
    const stdin = codex.buildStdin("SKILL BODY", "the conversation");
    expect(stdin.startsWith("SKILL BODY")).toBe(true);
    expect(stdin).toContain("the conversation");

    // Claude receives it via --append-system-prompt, so stdin stays clean.
    const claude = resolveBoardChatProvider({});
    expect(claude.buildStdin("SKILL BODY", "the conversation")).toBe("the conversation");
  });
});

describe("Claude stream parsing", () => {
  const provider = () => resolveBoardChatProvider({});

  it("streams token deltas and then ignores the duplicate final message", () => {
    const p = provider();
    expect(
      p.parseEvent({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { text: "Hel" } },
      }).chunks,
    ).toEqual(["Hel"]);
    expect(
      p.parseEvent({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { text: "lo" } },
      }).chunks,
    ).toEqual(["lo"]);
    // The terminal assistant message repeats the same text; consuming it would
    // render the reply twice.
    expect(
      p.parseEvent({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })
        .chunks,
    ).toEqual([]);
  });

  it("falls back to the whole message when no delta was seen", () => {
    const p = provider();
    expect(
      p.parseEvent({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } })
        .chunks,
    ).toEqual(["Hello"]);
  });

  it("reports tool use as status, not as assistant text", () => {
    const update = provider().parseEvent({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } },
    });
    expect(update.chunks).toEqual([]);
    expect(update.status).toBe("Running a command...");
  });
});

describe("Codex stream parsing", () => {
  const provider = () => resolveBoardChatProvider({ PAPERCLIP_BOARD_CHAT_PROVIDER: "codex" });

  it("ignores thread and turn lifecycle lines", () => {
    const p = provider();
    for (const event of [
      { type: "thread.started", thread_id: "01a0" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 1 } },
    ]) {
      expect(p.parseEvent(event)).toEqual({ chunks: [] });
    }
  });

  it("emits each completed agent message, since a turn can contain several", () => {
    const p = provider();
    expect(
      p.parseEvent({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "I'll run that command now." },
      }).chunks,
    ).toEqual(["I'll run that command now."]);
    expect(
      p.parseEvent({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "Done." },
      }).chunks,
    ).toEqual(["Done."]);
  });

  it("announces a command when it starts and stays quiet when it completes", () => {
    const p = provider();
    const started = p.parseEvent({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "/usr/bin/bash -lc 'echo hi'" },
    });
    expect(started.status).toBe("Running a command...");
    expect(started.chunks).toEqual([]);
    // The completion would otherwise repeat the same status line.
    expect(
      p.parseEvent({
        type: "item.completed",
        item: { id: "item_1", type: "command_execution" },
      }),
    ).toEqual({ chunks: [] });
  });
});
