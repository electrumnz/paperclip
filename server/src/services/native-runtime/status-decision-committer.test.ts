import { describe, expect, it } from "vitest";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { unblockDescriptorForStatusCommit } from "./status-decision-committer.js";

/**
 * The defect this guards (KEE-916): the status-commit projection wrote
 * `unblockDescriptor` unconditionally, so an already-`blocked` card carrying a
 * valid agent- or user-owned descriptor had its owner replaced by a
 * board-owned one, severing the wake route to whoever was already responsible.
 */
describe("unblockDescriptorForStatusCommit", () => {
  it("attaches the proposed board-owned descriptor when the card has none", () => {
    expect(
      unblockDescriptorForStatusCommit({
        existing: null,
        proposed: {
          owner: "board",
          action: "Review the failing run and choose a recovery action.",
        },
      }),
    ).toEqual({
      owner: "board",
      action: "Review the failing run and choose a recovery action.",
    });
  });

  it("attaches a proposed agent-owned descriptor with its owner intact", () => {
    // A `bind_blocker` can name an agent as the owner. Rewriting that as
    // board-owned would stop the agent being given the block from ever being
    // woken for it, which is the same failure mode as the displacement.
    expect(
      unblockDescriptorForStatusCommit({
        existing: null,
        proposed: { owner: { agentId: "agent-1" }, action: "Re-run the migration." },
      }),
    ).toEqual({ owner: { agentId: "agent-1" }, action: "Re-run the migration." });
  });

  it("keeps an existing agent-owned descriptor instead of displacing it", () => {
    const existing: IssueUnblockDescriptor = {
      owner: { agentId: "agent-1" },
      action: "Re-run the failed migration.",
    };
    expect(
      unblockDescriptorForStatusCommit({
        existing,
        proposed: { owner: "board", action: "Generic board action that must not land." },
      }),
    ).toBeNull();
  });

  it("keeps an existing user-owned descriptor", () => {
    const existing: IssueUnblockDescriptor = {
      owner: { userId: "user-1" },
      action: "Decide whether to accept the schema change.",
    };
    expect(
      unblockDescriptorForStatusCommit({
        existing,
        proposed: { owner: "board", action: "Board action." },
      }),
    ).toBeNull();
  });

  it("keeps an existing board-owned descriptor rather than rewriting it", () => {
    const existing: IssueUnblockDescriptor = {
      owner: "board",
      action: "Existing board action.",
    };
    expect(
      unblockDescriptorForStatusCommit({
        existing,
        proposed: { owner: "board", action: "Replacement text." },
      }),
    ).toBeNull();
  });

  it("replaces a degenerate descriptor whose action is blank", () => {
    // A whitespace-only action is not a real unblock path, so it must not
    // suppress a genuine descriptor.
    expect(
      unblockDescriptorForStatusCommit({
        existing: { owner: "board", action: "   " },
        proposed: { owner: "board", action: "Real next step." },
      }),
    ).toEqual({ owner: "board", action: "Real next step." });
  });

  it("returns null when there is nothing proposed to attach", () => {
    expect(unblockDescriptorForStatusCommit({ existing: null, proposed: null })).toBeNull();
    expect(unblockDescriptorForStatusCommit({ existing: undefined, proposed: undefined })).toBeNull();
    expect(
      unblockDescriptorForStatusCommit({
        existing: null,
        proposed: { owner: "board", action: "  " },
      }),
    ).toBeNull();
  });

  it("trims the action it attaches", () => {
    expect(
      unblockDescriptorForStatusCommit({
        existing: null,
        proposed: { owner: "board", action: "  Padded action.  " },
      }),
    ).toEqual({ owner: "board", action: "Padded action." });
  });
});
