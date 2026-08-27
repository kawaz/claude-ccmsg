// fold-tree decides, from the transcript alone, which folds have to be open
// for a given line to exist in the DOM — Timeline stopped rendering a closed
// fold's body, so nav can no longer find its target by asking the page.
//
// The contract that matters is agreement with what Timeline actually renders:
// a path naming a fold that never appears would leave a match un-reachable,
// and a missing path would leave nav thinking a hidden line was already on
// screen. Timeline's one "no fold here after all" shortcut is covered below
// (a fold group that is a single plain item is hoisted instead of wrapped).
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
import { foldGroupKey, foldPathsByOffset } from "../src/client/fold-tree.ts";

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

  test("every entry of a fold group needs only that group's outer fold", () => {
    // 2 段目のサブグループは廃止 (kawaz r151 m38): fold を開けば thinking も
    // tool 群も等しく 1 行ずつ現れるので、どの entry も outer 1 段で届く。
    const raws = [
      userPrompt("q"),
      thinking("hmm"),
      toolUse("tu_1"),
      toolResult("tu_1"),
      toolUse("tu_2"),
      toolResult("tu_2"),
      assistantText("a"),
    ];
    const { groups, paths } = build(raws);
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    const outer = foldGroupKey(fold.entries);
    for (const entry of fold.entries) {
      expect(paths.get(entry.offset)).toEqual([outer]);
    }
  });

  test("a lone plain item is hoisted, so it has no fold to open", () => {
    // A single tool_use/tool_result pair resolves into one entry, which
    // FoldGroup renders without a <details> of its own.
    const raws = [userPrompt("q"), toolUse("tu_1"), toolResult("tu_1"), assistantText("a")];
    const { groups, offsets, paths } = build(raws);
    const fold = groups.find((group) => group.kind === "fold");
    if (fold?.kind !== "fold") throw new Error("expected a fold group");
    expect(fold.entries.length).toBe(1);
    expect(paths.get(offsets[1]!)).toEqual([]);
  });

  test("a tool-only run of several entries still folds under its own outer fold", () => {
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
    const outer = foldGroupKey(fold.entries);
    expect(paths.get(offsets[1]!)).toEqual([outer]);
    expect(paths.get(offsets[3]!)).toEqual([outer]);
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
