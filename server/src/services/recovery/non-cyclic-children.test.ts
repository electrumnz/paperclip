import { describe, expect, it } from "vitest";
import { nonCyclicRecoveryChildren } from "./non-cyclic-children.js";

const child = (id: string) => ({ id, identifier: `KEE-${id}` });

describe("nonCyclicRecoveryChildren", () => {
  it("keeps children the source does not already reach", () => {
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B"), child("C")],
      [{ issueId: "X", relatedIssueId: "A" }],
    );

    expect(result.map((c) => c.id)).toEqual(["B", "C"]);
  });

  it("drops a child the source already reaches directly", () => {
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B")],
      [{ issueId: "A", relatedIssueId: "B" }],
    );

    // A blocks B already; proposing B as a blocker of A would close the loop.
    expect(result).toEqual([]);
  });

  it("drops a child reachable transitively from the source", () => {
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("C"), child("D")],
      [
        { issueId: "A", relatedIssueId: "B" },
        { issueId: "B", relatedIssueId: "C" },
        { issueId: "A", relatedIssueId: "D" },
      ],
    );

    expect(result.map((c) => c.id)).toEqual([]);
  });

  it("drops the source itself when it appears among its own children", () => {
    const result = nonCyclicRecoveryChildren("A", [child("A"), child("B")], []);

    expect(result.map((c) => c.id)).toEqual(["B"]);
  });

  it("ignores edges that do not start at a reachable node", () => {
    // X -> B is irrelevant: nothing in the search reaches X.
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B")],
      [{ issueId: "X", relatedIssueId: "B" }],
    );

    expect(result.map((c) => c.id)).toEqual(["B"]);
  });

  it("only follows blocks edges of the supplied set", () => {
    // A cycle that exists among other nodes must not remove unrelated children.
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B"), child("Z")],
      [
        { issueId: "P", relatedIssueId: "Q" },
        { issueId: "Q", relatedIssueId: "P" },
      ],
    );

    expect(result.map((c) => c.id)).toEqual(["B", "Z"]);
  });

  it("returns an empty list unchanged", () => {
    expect(nonCyclicRecoveryChildren("A", [], [{ issueId: "A", relatedIssueId: "B" }])).toEqual([]);
  });

  it("terminates on a cyclic edge set and drops the cycle-closing child", () => {
    // A and B already block each other. B is reachable from A, so proposing B
    // as a blocker of A is a cycle; Z is untouched by the cycle and survives.
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B"), child("Z")],
      [
        { issueId: "A", relatedIssueId: "B" },
        { issueId: "B", relatedIssueId: "A" },
      ],
    );

    expect(result.map((c) => c.id)).toEqual(["Z"]);
  });

  it("keeps a child that a self-referential edge set does not reach", () => {
    // A -> A is a malformed edge for the source itself, not a reason to drop
    // unrelated children. `syncBlockedByIssueIds` rejects a self-block
    // separately ("Issue cannot be blocked by itself"); reachability from A is
    // still just {A}.
    const result = nonCyclicRecoveryChildren(
      "A",
      [child("B")],
      [
        { issueId: "A", relatedIssueId: "A" },
        { issueId: "B", relatedIssueId: "B" },
      ],
    );

    expect(result.map((c) => c.id)).toEqual(["B"]);
  });

  it("preserves candidate order and identity of the survivors", () => {
    const survivors = [child("B"), child("D")];
    const result = nonCyclicRecoveryChildren(
      "A",
      [...survivors, child("C")],
      [
        { issueId: "A", relatedIssueId: "C" },
      ],
    );

    expect(result).toEqual(survivors);
  });
});
