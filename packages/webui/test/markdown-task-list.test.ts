// markdown-task-list.ts unit tests: the source-text rewrite behind a preview
// checkbox click, plus the ordinal agreement that makes clicking safe.
//
// Test strategy mirrors markdown-view.test.ts: the toggler is a pure
// string->string function, so most cases are plain source fixtures. The
// "agrees with the parser" cases deliberately DO run `parseMarkdownDocument`,
// because that agreement is the actual safety property — a scanner that
// merely satisfies its own regex would happily number items the renderer
// numbers differently, and the write would land on the wrong line.
import { describe, expect, test } from "bun:test";
import {
  findTaskLines,
  scanTaskStates,
  taskStatesAlign,
  toggleTaskLine,
} from "../src/client/markdown-task-list.ts";
import { extractTaskStates, parseMarkdownDocument } from "../src/client/markdown-view.tsx";

/** The states the renderer would show, in the order it assigns ordinals. */
function parsedStates(source: string): boolean[] {
  return extractTaskStates(parseMarkdownDocument(source));
}

describe("findTaskLines", () => {
  test("finds bullet, ordered, indented and quoted task items", () => {
    const source = [
      "- [ ] a",
      "* [x] b",
      "+ [X] c",
      "1. [ ] d",
      "2) [ ] e",
      "  - [ ] f",
      "> - [ ] g",
    ].join("\n");
    expect(findTaskLines(source)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  // The shapes the parser itself declines (verified against @mizchi/markdown):
  // counting any of them would shift every later ordinal by one.
  test("ignores non-task list items and near-miss shapes", () => {
    const source = [
      "- plain item",
      "- [ ]no-space", // parser: not a task
      "- [ ]\ttab-after", // parser: not a task
      "- x [ ] bracket not first",
      "- [] empty bracket",
      "plain [ ] prose",
      "- [ ] real",
    ].join("\n");
    expect(findTaskLines(source)).toEqual([6]);
  });

  // A bare `- [ ]` with nothing after it is a task item to the parser.
  test("accepts a task marker at end of line", () => {
    expect(findTaskLines("- [ ]\n- [x]")).toEqual([0, 1]);
  });

  // QUESTIONS.md's template section shows the `- [ ] a: …` notation inside a
  // fence; those lines are code, and consuming ordinals for them would
  // misalign every real item below.
  test("skips task lines inside fenced code, including tilde and quoted fences", () => {
    const source = [
      "- [ ] before",
      "```md",
      "- [ ] fenced",
      "- [x] fenced2",
      "```",
      "~~~",
      "- [ ] tilde-fenced",
      "~~~",
      "> ```",
      "> - [ ] quoted-fence",
      "> ```",
      "- [x] after",
    ].join("\n");
    expect(findTaskLines(source)).toEqual([0, 11]);
  });

  // A closer must be at least as long as its opener and use the same
  // character, so a shorter run inside the block does not end it.
  test("a shorter or mismatched fence run does not close the block", () => {
    const source = ["````", "```", "- [ ] still fenced", "````", "- [x] real"].join("\n");
    expect(findTaskLines(source)).toEqual([4]);
  });
});

describe("toggleTaskLine", () => {
  test("checks an unchecked item, touching only that character", () => {
    const source = "- [ ] a\n- [ ] b\n";
    const res = toggleTaskLine(source, 1, false, true);
    expect(res).toEqual({ ok: true, source: "- [ ] a\n- [x] b\n" });
  });

  test("unchecks a checked item", () => {
    const res = toggleTaskLine("- [x] a\n", 0, true, false);
    expect(res).toEqual({ ok: true, source: "- [ ] a\n" });
  });

  // `[X]` is checked to the parser; unchecking it must produce a plain `[ ]`
  // rather than leave the uppercase marker behind.
  test("uppercase [X] is treated as checked and normalizes on uncheck", () => {
    expect(scanTaskStates("- [X] a")).toEqual([true]);
    expect(toggleTaskLine("- [X] a", 0, true, false)).toEqual({ ok: true, source: "- [ ] a" });
  });

  test("preserves indentation, bullet style and quote prefix of the edited line", () => {
    const source = ">   1) [ ] deep item";
    expect(toggleTaskLine(source, 0, false, true)).toEqual({
      ok: true,
      source: ">   1) [x] deep item",
    });
  });

  // The rest of the line — including further `[ ]` text that is not the task
  // marker — must survive untouched.
  test("later [ ] occurrences on the same line are not rewritten", () => {
    const source = "- [ ] a `[ ]` and [ ] more";
    expect(toggleTaskLine(source, 0, false, true)).toEqual({
      ok: true,
      source: "- [x] a `[ ]` and [ ] more",
    });
  });

  test("leaves every other line, and the trailing newline, byte-identical", () => {
    const source = "# head\n\n- [ ] a\n- [x] b\n\ntext\n";
    const res = toggleTaskLine(source, 0, false, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("# head\n\n- [x] a\n- [x] b\n\ntext\n");
  });

  test("a file with no trailing newline stays that way", () => {
    const res = toggleTaskLine("- [ ] a", 0, false, true);
    expect(res).toEqual({ ok: true, source: "- [x] a" });
  });

  // Fail-closed cases: the write is refused rather than applied somewhere else.
  test("refuses when the item is not in the state the caller displayed", () => {
    expect(toggleTaskLine("- [x] a\n", 0, false, true)).toEqual({ ok: false, reason: "stale" });
  });

  test("refuses an ordinal past the end", () => {
    expect(toggleTaskLine("- [ ] a\n", 3, false, true)).toEqual({ ok: false, reason: "stale" });
    expect(toggleTaskLine("no tasks here\n", 0, false, true)).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  // Toggling to the state an item already holds is a no-op write, not a
  // refusal — the UI never asks for it, but it must not corrupt the line.
  test("toggling to the current state rewrites the same character", () => {
    expect(toggleTaskLine("- [x] a", 0, true, true)).toEqual({ ok: true, source: "- [x] a" });
  });
});

describe("ordinal agreement with the renderer", () => {
  // The property everything else rests on: for documents the UI will enable,
  // scan order and states must equal what the renderer walked. Nested items
  // number after their parent (document order), which is why the renderer
  // takes its ordinal before recursing.
  const agreeing = [
    "- [ ] a\n- [x] b\n",
    "- [ ] parent\n  - [x] child\n  - [ ] child2\n- [x] sibling\n",
    "# 👺XX-Q1\n\n- [ ] a (推奨): foo\n- [x] b: bar\n",
    "> - [ ] quoted\n> - [x] quoted2\n\n- [ ] top\n",
    "- [ ] before\n\n```md\n- [ ] fenced\n```\n\n- [x] after\n",
    "1. [ ] one\n2. [x] two\n",
    "- [ ] a\n- plain\n- [x] b\n",
  ];
  for (const [i, source] of agreeing.entries()) {
    test(`scan matches parse (#${i})`, () => {
      const scanned = scanTaskStates(source);
      expect(scanned).toEqual(parsedStates(source));
      expect(taskStatesAlign(scanned, parsedStates(source))).toBe(true);
    });
  }

  // Astral characters shift @mizchi/markdown's code-point offsets away from
  // JS string indices, which is why ordinals (not positions) are the write
  // coordinate. QUESTIONS.md marks every arbitration heading with 👺.
  test("astral characters do not disturb ordinals", () => {
    const source = "👺👺 XX-Q1\n\n- [ ] a\n- [x] b\n";
    expect(scanTaskStates(source)).toEqual(parsedStates(source));
    expect(toggleTaskLine(source, 0, false, true)).toEqual({
      ok: true,
      source: "👺👺 XX-Q1\n\n- [x] a\n- [x] b\n",
    });
  });

  // A line scanner cannot resolve indented-code ambiguity; the contract is
  // that disagreement is detected, not that it never happens.
  test("taskStatesAlign rejects a length or state mismatch", () => {
    expect(taskStatesAlign([false], [false, true])).toBe(false);
    expect(taskStatesAlign([false, false], [false, true])).toBe(false);
    expect(taskStatesAlign([], [])).toBe(true);
  });
});
