// fold-tree decides, from the transcript alone, which folds have to be open
// for a given line to exist in the DOM — Timeline stopped rendering a closed
// fold's body, so nav can no longer find its target by asking the page.
//
// The contract that matters is agreement with what Timeline actually renders:
// a path naming a fold that never appears would leave a match un-reachable,
// and a missing path would leave nav thinking a hidden line was already on
// screen. Both of Timeline's "no fold here after all" shortcuts are covered
// below (a fold group with no direct entry renders no outer <details>; a
// one-entry items run is hoisted instead of wrapped).
import { describe, expect, test } from "bun:test";
import {
  byteOffsetsFromLengths,
  groupTimelineLines,
  pairQueuedTurns,
  parseTranscriptLine,
  resolveToolResults,
  utf8ByteLength,
  type TimelineGroup,
} from "../src/client/transcript-model.ts";
import { foldGroupKey, foldPathsByOffset, itemsSubFoldKey } from "../src/client/fold-tree.ts";

const START = 0;

let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-08-12T00:00:${String(clock).padStart(2, "0")}.000Z`;
}
function userPrompt(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts(),
  });
}
function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(),
  });
}
function thinking(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
    timestamp: ts(),
  });
}
function toolUse(id: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }],
    },
    timestamp: ts(),
  });
}
function toolResult(id: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }],
    },
    timestamp: ts(),
  });
}

function build(raws: readonly string[]): {
  groups: TimelineGroup[];
  offsets: number[];
  paths: Map<number, string[]>;
} {
  const perLine = raws.map(parseTranscriptLine);
  const offsets = byteOffsetsFromLengths(
    START,
    raws.map((raw) => utf8ByteLength(raw)),
  );
  const parsed = resolveToolResults(pairQueuedTurns(perLine, raws));
  const groups = groupTimelineLines(parsed, offsets);
  return { groups, offsets, paths: foldPathsByOffset(groups) };
}

describe("foldPathsByOffset", () => {
  test("a boundary line is enclosed by nothing", () => {
    // 0: user prompt, 1: thinking, 2: tool_use, 3: tool_result, 4: answer
    const raws = [
      userPrompt("q"),
      thinking("hmm"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      assistantText("a"),
    ];
    const { offsets, paths } = build(raws);
    expect(paths.get(offsets[0]!)).toBeUndefined();
    expect(paths.get(offsets[4]!)).toBeUndefined();
  });

  test("thinking sits directly under the outer fold; the tool run under a sub-fold", () => {
    const raws = [
      userPrompt("q"),
      thinking("hmm"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      toolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("a"),
    ];
    const { groups, offsets, paths } = build(raws);
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    const outer = foldGroupKey(fold.entries);
    // Thinking is a direct child: opening the outer fold is enough.
    expect(paths.get(offsets[1]!)).toEqual([outer]);
    // The two tool calls (each with its result folded in by resolveToolResults)
    // are one items run, so they need the sub-fold too.
    const items = fold.entries.filter((entry) => entry.offset !== offsets[1]!);
    expect(items.map((entry) => entry.offset)).toEqual([offsets[2]!, offsets[4]!]);
    const inner = itemsSubFoldKey(items);
    for (const entry of items) {
      expect(paths.get(entry.offset)).toEqual([outer, inner]);
    }
  });

  test("a one-entry items run is hoisted, so it needs only the outer fold", () => {
    // A single tool_use/tool_result pair resolves into one entry, which
    // ItemsSubFold renders without a <details> of its own.
    const raws = [
      userPrompt("q"),
      thinking("hmm"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      assistantText("a"),
    ];
    const { groups, offsets, paths } = build(raws);
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    const outer = foldGroupKey(fold.entries);
    expect(fold.entries.length).toBe(2);
    expect(paths.get(offsets[2]!)).toEqual([outer]);
  });

  test("a fold group with no direct entry has no outer fold to open", () => {
    // No thinking, no agent traffic: FoldGroup renders the sub-folds bare.
    const raws = [
      userPrompt("q"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      toolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("a"),
    ];
    const { groups, offsets, paths } = build(raws);
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    const inner = itemsSubFoldKey(fold.entries);
    expect(paths.get(offsets[1]!)).toEqual([inner]);
    expect(paths.get(offsets[1]!)?.[0]).not.toBe(foldGroupKey(fold.entries));
  });

  test("every fold entry is accounted for, and only fold entries are", () => {
    const raws = [
      userPrompt("q1"),
      thinking("hmm"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      assistantText("a1"),
      userPrompt("q2"),
      toolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("a2"),
    ];
    const { groups, paths } = build(raws);
    const foldOffsets = groups
      .filter((group) => group.kind === "fold")
      .flatMap((group) => (group.kind === "fold" ? group.entries.map((e) => e.offset) : []));
    expect([...paths.keys()].sort((a, b) => a - b)).toEqual(foldOffsets.sort((a, b) => a - b));
  });

  test("keys are per group, so the two fold groups above never share one", () => {
    const raws = [
      userPrompt("q1"),
      thinking("t1"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      assistantText("a1"),
      userPrompt("q2"),
      thinking("t2"),
      toolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("a2"),
    ];
    const { groups } = build(raws);
    const folds = groups.filter((group) => group.kind === "fold");
    expect(folds.length).toBe(2);
    const keys = folds.map((fold) => (fold.kind === "fold" ? foldGroupKey(fold.entries) : ""));
    expect(new Set(keys).size).toBe(2);
  });
});
