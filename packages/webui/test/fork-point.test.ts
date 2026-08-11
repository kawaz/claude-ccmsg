// Where a fork cuts the resumed conversation (fork-point.ts). The rules under
// test are the measured ones in docs/findings/2026-08-11-checkpoint-rewind.md
// 事実 9: the *kind* of record makes no difference (every kind on the live
// chain resumes and answers), while a record off that chain always fails with
// `No message found`.
import { describe, expect, test } from "bun:test";
import { forkActionState, liveChain } from "../src/client/fork-point.ts";
import type { ParsedLine } from "../src/client/transcript-model.ts";

/** One transcript row, reduced to the two fields the walk reads. */
function row(uuid?: string, parentUuid?: string): ParsedLine {
  return {
    kind: "turn",
    ts: null,
    role: "assistant",
    segments: [],
    ...(uuid ? { uuid } : {}),
    ...(parentUuid ? { parentUuid } : {}),
  };
}

/** A straight conversation: a -> b -> c. */
const STRAIGHT = [row("a"), row("b", "a"), row("c", "b")];

/** The shape a resume without `--fork-session` leaves behind: the file keeps
 * the abandoned turns (x, y) and then continues from `a` again. The newest row
 * is `n2`, so the live chain is a -> n1 -> n2. */
const BRANCHED = [row("a"), row("x", "a"), row("y", "x"), row("n1", "a"), row("n2", "n1")];

describe("liveChain", () => {
  test("records each chained record's predecessor", () => {
    expect(liveChain(STRAIGHT).parentOf).toEqual(
      new Map([
        ["b", "a"],
        ["c", "b"],
      ]),
    );
  });

  // A link whose target is not loaded names nothing, so it is not offered as a
  // cut point at all.
  test("a predecessor outside the window is not recorded", () => {
    expect(liveChain([row("b", "a"), row("c", "b")]).parentOf).toEqual(new Map([["c", "b"]]));
  });

  test("a straight transcript is entirely live", () => {
    expect(liveChain(STRAIGHT).uuids).toEqual(new Set(["a", "b", "c"]));
  });

  test("an abandoned branch is excluded, its ancestors kept", () => {
    expect(liveChain(BRANCHED).uuids).toEqual(new Set(["a", "n1", "n2"]));
  });

  // Rows with no uuid (queue-operation, ai-title, last-prompt...) are not
  // selectable anyway; they must not break the walk when they sit at the tail.
  test("rows without a uuid are skipped, including at the tail", () => {
    expect(liveChain([...STRAIGHT, row(), row()]).uuids).toEqual(new Set(["a", "b", "c"]));
  });

  // A "load older" window starts mid-file, so the oldest loaded row's parent is
  // not present. The walk stops there rather than returning nothing.
  test("the walk stops at the top of a partially loaded window", () => {
    expect(liveChain([row("b", "a"), row("c", "b")]).uuids).toEqual(new Set(["b", "c"]));
  });

  test("no rows, or no uuids at all, means no chain", () => {
    expect(liveChain([]).uuids).toEqual(new Set());
    expect(liveChain([row(), row()]).uuids).toEqual(new Set());
  });

  // Self-referencing / cyclic links are not something a real transcript should
  // contain, but the walk must terminate rather than hang the Timeline.
  test("a cycle terminates", () => {
    expect(liveChain([row("a", "b"), row("b", "a")]).uuids).toEqual(new Set(["b", "a"]));
  });
});

describe("forkActionState", () => {
  const CHAIN = liveChain(STRAIGHT);

  // The option is inclusive, so "keep this record" is the selection itself and
  // "drop this record too" is the one before it — both offered at once.
  test("ready carries the selection and the record before it", () => {
    expect(forkActionState("c", CHAIN)).toEqual({
      kind: "ready",
      resumeAt: "c",
      resumeAtBefore: "b",
    });
  });

  // Nothing precedes the first record of a session, so only the inclusive
  // choice exists there.
  test("no resumeAtBefore when the selection starts the chain", () => {
    expect(forkActionState("a", CHAIN)).toEqual({ kind: "ready", resumeAt: "a" });
  });

  // "load older" case: the predecessor is a real record but is not in the
  // window, so it cannot be named and only the inclusive choice is offered.
  test("no resumeAtBefore when the predecessor is outside the loaded window", () => {
    const windowed = liveChain([row("b", "a"), row("c", "b")]);
    expect(forkActionState("b", windowed)).toEqual({ kind: "ready", resumeAt: "b" });
    expect(forkActionState("c", windowed)).toEqual({
      kind: "ready",
      resumeAt: "c",
      resumeAtBefore: "b",
    });
  });

  // Measured: assistant answers, thinking blocks, dangling tool_use, user
  // tool_result, attachments and isMeta rows all resume and answer, so the
  // record kind never reaches this decision.
  test("the kind of record behind the selection makes no difference", () => {
    for (const uuid of ["a", "b", "c"]) {
      expect(forkActionState(uuid, CHAIN).kind).toBe("ready");
    }
  });

  // "head" is the Timeline's "nothing selected" position, not a uuid.
  test("no-selection while the Timeline sits at head", () => {
    expect(forkActionState("head", CHAIN)).toEqual({ kind: "no-selection" });
  });

  // The one measured failure that a user can actually click on.
  test("off-chain for a record on an abandoned branch", () => {
    const branched = liveChain(BRANCHED);
    expect(forkActionState("x", branched)).toEqual({ kind: "off-chain" });
    // The live branch resolves against the live chain, not against file order:
    // n1's predecessor is the branch point `a`, not the abandoned `y`.
    expect(forkActionState("n1", branched)).toEqual({
      kind: "ready",
      resumeAt: "n1",
      resumeAtBefore: "a",
    });
  });

  // A window that produced no chain at all is no evidence that the selection
  // is bad, so the fork stays on offer rather than being blocked by a check
  // that could not run.
  test("an empty chain does not block the selection", () => {
    expect(forkActionState("b", { uuids: new Set(), parentOf: new Map() })).toEqual({
      kind: "ready",
      resumeAt: "b",
    });
  });
});
