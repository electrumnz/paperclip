import { describe, expect, it } from "vitest";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import {
  retainedUnblockDescriptorForBindBlocker,
  unblockDescriptorForStatusCommit,
} from "./status-decision-committer.js";

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

/**
 * The defect this guards (KEE-925): `unblockDescriptorForStatusCommit` returns
 * `null` both for "kept the existing descriptor" and for "nothing attachable".
 * The `bind_blocker` effect read that `null` and fell back to the owner the
 * effect itself proposed, so it woke and recorded an agent the card did not
 * name. The helper resolves which descriptor actually remains so the write, the
 * wake and the recorded effect cannot disagree.
 */
describe("retainedUnblockDescriptorForBindBlocker", () => {
  it("returns the attached proposal when the card has no usable descriptor", () => {
    expect(
      retainedUnblockDescriptorForBindBlocker({
        existing: null,
        proposed: { owner: { agentId: "agent-1" }, action: "Re-run the migration." },
      }),
    ).toEqual({
      descriptor: { owner: { agentId: "agent-1" }, action: "Re-run the migration." },
      source: "proposed",
    });
  });

  it("returns the kept descriptor when an existing one is valid", () => {
    // The divergence case: the proposal names an agent, the card keeps a
    // user-owned descriptor. The retained descriptor is the user's, so no agent
    // may be woken or named as the owner.
    const existing: IssueUnblockDescriptor = {
      owner: { userId: "user-1" },
      action: "Decide whether to accept the schema change.",
    };
    expect(
      retainedUnblockDescriptorForBindBlocker({
        existing,
        proposed: { owner: { agentId: "agent-1" }, action: "Agent action that must not land." },
      }),
    ).toEqual({ descriptor: existing, source: "existing" });
  });

  it("keeps an existing agent-owned descriptor that names a different agent", () => {
    const existing: IssueUnblockDescriptor = {
      owner: { agentId: "agent-2" },
      action: "Re-run the failed migration.",
    };
    expect(
      retainedUnblockDescriptorForBindBlocker({
        existing,
        proposed: { owner: { agentId: "agent-1" }, action: "Agent action that must not land." },
      }),
    ).toEqual({ descriptor: existing, source: "existing" });
  });

  it("replaces a degenerate existing descriptor and reports the proposal", () => {
    expect(
      retainedUnblockDescriptorForBindBlocker({
        existing: { owner: "board", action: "   " },
        proposed: { owner: { agentId: "agent-1" }, action: "Real next step." },
      }),
    ).toEqual({
      descriptor: { owner: { agentId: "agent-1" }, action: "Real next step." },
      source: "proposed",
    });
  });

  it("falls back to the proposal when neither side has a usable action", () => {
    // Nothing is written, so there is no retained owner to disagree with. The
    // proposal is reported rather than an owner invented from nothing.
    expect(
      retainedUnblockDescriptorForBindBlocker({
        existing: { owner: "board", action: "  " },
        proposed: { owner: { agentId: "agent-1" }, action: "  " },
      }),
    ).toEqual({
      descriptor: { owner: { agentId: "agent-1" }, action: "" },
      source: "proposed",
    });
  });

  it("agrees with unblockDescriptorForStatusCommit about what is written", () => {
    // The whole point: the descriptor this helper reports as retained is the
    // descriptor the card ends up carrying.
    const cases: Array<{
      existing: IssueUnblockDescriptor | null;
      proposed: { owner: { agentId: string } | "board"; action: string };
    }> = [
      { existing: null, proposed: { owner: { agentId: "a1" }, action: "Do the thing." } },
      {
        existing: { owner: { userId: "u1" }, action: "User decides." },
        proposed: { owner: { agentId: "a1" }, action: "Agent acts." },
      },
      {
        existing: { owner: { agentId: "a2" }, action: "Other agent acts." },
        proposed: { owner: { agentId: "a1" }, action: "Agent acts." },
      },
      {
        existing: { owner: "board", action: "Board acts." },
        proposed: { owner: { agentId: "a1" }, action: "Agent acts." },
      },
    ];
    for (const { existing, proposed } of cases) {
      const written = unblockDescriptorForStatusCommit({ existing, proposed });
      const retained = retainedUnblockDescriptorForBindBlocker({ existing, proposed });
      // Whatever is written, the reported descriptor is what the card carries.
      expect(retained.descriptor).toEqual(written ?? existing);
    }
  });
});
