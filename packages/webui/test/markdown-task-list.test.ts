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
  anchorTaskLine,
  findTaskLines,
  resolveTaskLine,
  scanTaskStates,
  taskStatesAlign,
  toggledAnchor,
  toggleTaskLine,
  type TaskAnchor,
} from "../src/client/markdown-task-list.ts";
import { extractTaskStates, parseMarkdownDocument } from "../src/client/markdown-view.tsx";

/** The states the renderer would show, in the order it assigns ordinals. */
function parsedStates(source: string): boolean[] {
  return extractTaskStates(parseMarkdownDocument(source));
}

/** A click on the `ordinal`-th item of `source`, as the viewer captures it.
 * Throws on refusal so a test that meant to click something valid fails at the
 * click rather than silently exercising the null path. */
function click(source: string, ordinal: number, expected: boolean): TaskAnchor {
  const anchor = anchorTaskLine(source, ordinal, expected);
  if (anchor === null) throw new Error(`anchorTaskLine refused ordinal ${ordinal}`);
  return anchor;
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

describe("anchorTaskLine", () => {
  test("captures the clicked item's own source line and its ordinal", () => {
    const source = "# head\n\n- [ ] a\n- [x] b\n";
    expect(anchorTaskLine(source, 1, true)).toEqual({ ordinal: 1, line: "- [x] b" });
  });

  // The ordinal comes from the render walk; if the line it names does not hold
  // the state the render displayed, the two sides are numbering differently
  // and nothing about the click can be trusted.
  test("refuses when the ordinal's line is not in the displayed state", () => {
    expect(anchorTaskLine("- [x] a\n", 0, false)).toBeNull();
  });

  test("refuses an ordinal past the end", () => {
    expect(anchorTaskLine("- [ ] a\n", 3, false)).toBeNull();
    expect(anchorTaskLine("no tasks here\n", 0, false)).toBeNull();
  });
});

describe("toggleTaskLine", () => {
  test("checks an unchecked item, touching only that character", () => {
    const source = "- [ ] a\n- [ ] b\n";
    expect(toggleTaskLine(source, click(source, 1, false), true)).toEqual({
      ok: true,
      source: "- [ ] a\n- [x] b\n",
    });
  });

  test("unchecks a checked item", () => {
    const source = "- [x] a\n";
    expect(toggleTaskLine(source, click(source, 0, true), false)).toEqual({
      ok: true,
      source: "- [ ] a\n",
    });
  });

  // `[X]` is checked to the parser; unchecking it must produce a plain `[ ]`
  // rather than leave the uppercase marker behind.
  test("uppercase [X] is treated as checked and normalizes on uncheck", () => {
    expect(scanTaskStates("- [X] a")).toEqual([true]);
    expect(toggleTaskLine("- [X] a", click("- [X] a", 0, true), false)).toEqual({
      ok: true,
      source: "- [ ] a",
    });
  });

  test("preserves indentation, bullet style and quote prefix of the edited line", () => {
    const source = ">   1) [ ] deep item";
    expect(toggleTaskLine(source, click(source, 0, false), true)).toEqual({
      ok: true,
      source: ">   1) [x] deep item",
    });
  });

  // The rest of the line — including further `[ ]` text that is not the task
  // marker — must survive untouched.
  test("later [ ] occurrences on the same line are not rewritten", () => {
    const source = "- [ ] a `[ ]` and [ ] more";
    expect(toggleTaskLine(source, click(source, 0, false), true)).toEqual({
      ok: true,
      source: "- [x] a `[ ]` and [ ] more",
    });
  });

  test("leaves every other line, and the trailing newline, byte-identical", () => {
    const source = "# head\n\n- [ ] a\n- [x] b\n\ntext\n";
    const res = toggleTaskLine(source, click(source, 0, false), true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("# head\n\n- [x] a\n- [x] b\n\ntext\n");
  });

  test("a file with no trailing newline stays that way", () => {
    expect(toggleTaskLine("- [ ] a", click("- [ ] a", 0, false), true)).toEqual({
      ok: true,
      source: "- [x] a",
    });
  });

  // Toggling to the state an item already holds is a no-op write, not a
  // refusal — the UI never asks for it, but it must not corrupt the line.
  test("toggling to the current state rewrites the same character", () => {
    expect(toggleTaskLine("- [x] a", click("- [x] a", 0, true), true)).toEqual({
      ok: true,
      source: "- [x] a",
    });
  });
});

// The point of anchoring by content: the file the write lands on is a fresh
// read, not the one that was rendered, and an AI session may have rewritten
// any part of it in between. docs/QUESTIONS.md — the arbitration queue this
// feature serves — is edited by other sessions constantly, so "someone else
// touched the file" must not, by itself, cost the user their click.
describe("relocating an anchor in an edited file", () => {
  const rendered = [
    "# 👺XX-Q1",
    "",
    "説明の段落。",
    "",
    "- [ ] a: 最初の選択肢",
    "- [ ] b: 次の選択肢",
    "",
  ].join("\n");

  test("unrelated lines changed elsewhere: the click still lands", () => {
    const anchor = click(rendered, 1, false);
    const fresh = [
      "# 👺XX-Q1",
      "",
      "説明の段落を AI が全面的に書き換えた。",
      "追加の段落もある。",
      "",
      "- [ ] a: 最初の選択肢",
      "- [ ] b: 次の選択肢",
      "",
      "## 👺XX-Q2",
      "",
      "- [ ] 別の質問",
      "",
    ].join("\n");
    const res = toggleTaskLine(fresh, anchor, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe(fresh.replace("- [ ] b: 次の選択肢", "- [x] b: 次の選択肢"));
  });

  // The anchored line moved *and* its ordinal changed, because a new item was
  // inserted above it. Content is the primary key precisely so this works.
  test("the item moved and its ordinal shifted: still tracked by content", () => {
    const anchor = click(rendered, 1, false);
    const fresh = ["- [ ] 新しく先頭に挿入された項目", ...rendered.split("\n")].join("\n");
    const res = toggleTaskLine(fresh, anchor, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toContain("- [x] b: 次の選択肢");
    expect(res.source).toContain("- [ ] 新しく先頭に挿入された項目");
    expect(res.source).toContain("- [ ] a: 最初の選択肢");
  });

  // A real conflict: someone else toggled this very item. The user's intent
  // may no longer make sense, so this is the one case that still alerts.
  test("the anchored item itself was toggled: refused as a conflict", () => {
    const anchor = click(rendered, 1, false);
    const fresh = rendered.replace("- [ ] b: 次の選択肢", "- [x] b: 次の選択肢");
    expect(toggleTaskLine(fresh, anchor, true)).toEqual({ ok: false, reason: "conflict" });
  });

  test("the anchored item's text was edited: refused as gone", () => {
    const anchor = click(rendered, 1, false);
    const fresh = rendered.replace("- [ ] b: 次の選択肢", "- [ ] b: 言い換えた選択肢");
    expect(toggleTaskLine(fresh, anchor, true)).toEqual({ ok: false, reason: "gone" });
  });

  test("the anchored item was deleted: refused as gone", () => {
    const anchor = click(rendered, 1, false);
    const fresh = rendered.replace("- [ ] b: 次の選択肢\n", "");
    expect(toggleTaskLine(fresh, anchor, true)).toEqual({ ok: false, reason: "gone" });
  });

  test("every task item removed: refused as gone", () => {
    const anchor = click(rendered, 1, false);
    expect(toggleTaskLine("# 👺XX-Q1\n\nもう選択肢はない。\n", anchor, true)).toEqual({
      ok: false,
      reason: "gone",
    });
  });
});

// Short option lines like `- [ ] a: …` repeat across questions, so duplicates
// are not hypothetical. Content alone cannot separate them; the ordinal is the
// tie-breaker, and when it is no longer usable the write is refused rather
// than guessed.
describe("duplicate task lines", () => {
  const dup = ["- [ ] やる", "- [ ] やる", "- [ ] やる", ""].join("\n");

  test("the ordinal picks the right one among identical lines", () => {
    const res = toggleTaskLine(dup, click(dup, 1, false), true);
    expect(res).toEqual({ ok: true, source: "- [ ] やる\n- [x] やる\n- [ ] やる\n" });
  });

  // The ordinal still lands on a line identical to the anchor, so the click is
  // honored: the user's intent ("check one of these N identical items") is
  // satisfied by any of them, and the ordinal names the one they saw.
  test("an unrelated insertion above keeps the ordinal usable", () => {
    const anchor = click(dup, 1, false);
    const fresh = "見出し\n\n" + dup;
    const res = toggleTaskLine(fresh, anchor, true);
    expect(res).toEqual({ ok: true, source: "見出し\n\n- [ ] やる\n- [x] やる\n- [ ] やる\n" });
  });

  // A *task item* inserted above shifts the ordinals, so the ordinal now names
  // a different one of the duplicates than the user clicked. Since the
  // duplicates are indistinguishable, so is the ordinal's answer — but here it
  // still points at an identical line, which is exactly as good as the one
  // clicked, so the write proceeds on that line.
  test("a task item inserted above still resolves to an identical line", () => {
    const anchor = click(dup, 1, false);
    const fresh = "- [ ] 別の項目\n" + dup;
    const res = toggleTaskLine(fresh, anchor, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source.split("\n").filter((l) => l === "- [x] やる")).toHaveLength(1);
  });

  // Here the ordinal lands on a line that is *not* one of the candidates, so
  // there is no evidence left for which duplicate was clicked. Guessing would
  // risk checking an item the user never touched.
  test("refuses when the ordinal no longer names any candidate", () => {
    const anchor = click(dup, 2, false);
    const fresh = ["- [ ] やる", "- [ ] やる", "- [x] 別物", ""].join("\n");
    expect(toggleTaskLine(fresh, anchor, true)).toEqual({ ok: false, reason: "ambiguous" });
  });

  test("refuses when the ordinal is past the end of a shrunken document", () => {
    const anchor = click(dup, 2, false);
    // Two remain (still ambiguous), but ordinal 2 no longer exists.
    expect(toggleTaskLine("- [ ] やる\n- [ ] やる\n", anchor, true)).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  // Duplicates differing only in state are not the same item: matching is on
  // the state-normalized identity, and the raw-text check then reports the
  // mismatch as a conflict on the item itself rather than silently retargeting
  // onto the other one.
  test("a same-text item in the other state is a conflict, not a substitute", () => {
    const source = "- [ ] やる\n";
    const anchor = click(source, 0, false);
    expect(toggleTaskLine("- [x] やる\n", anchor, true)).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});

// An optimistic UI update has to be undoable when the write behind it fails,
// and the undo must hit only the item that failed — the user may have ticked
// other boxes while it was in flight, and those are unrelated writes.
describe("toggledAnchor (undoing an optimistic update)", () => {
  test("re-anchors onto the flipped line", () => {
    const anchor = click("- [ ] a\n", 0, false);
    expect(toggledAnchor(anchor, true)).toEqual({ ordinal: 0, line: "- [x] a" });
    expect(toggledAnchor(toggledAnchor(anchor, true), false)).toEqual(anchor);
  });

  test("undoes one item without disturbing a toggle made meanwhile", () => {
    const source = "- [ ] a\n- [ ] b\n";
    const failing = click(source, 0, false);
    // The optimistic paint for the failed click, plus a later click on b.
    const painted = "- [x] a\n- [x] b\n";
    const undone = toggleTaskLine(painted, toggledAnchor(failing, true), false);
    expect(undone).toEqual({ ok: true, source: "- [ ] a\n- [x] b\n" });
  });

  // The failed item was itself edited away while the write was in flight;
  // there is nothing to put back, and guessing would corrupt the file.
  test("refuses to undo an item that no longer exists", () => {
    const anchor = click("- [ ] a\n", 0, false);
    expect(toggleTaskLine("- [x] renamed\n", toggledAnchor(anchor, true), false)).toEqual({
      ok: false,
      reason: "gone",
    });
  });
});

describe("resolveTaskLine", () => {
  // The index is what the write uses; asserting it directly pins down that
  // relocation tracks the line rather than merely producing some valid edit.
  test("reports the line index the anchor now lives at", () => {
    const source = "- [ ] a\n- [ ] b\n";
    const anchor = click(source, 1, false);
    expect(resolveTaskLine("# h\n\ntext\n\n- [ ] a\n- [ ] b\n", anchor)).toEqual({
      ok: true,
      lineIndex: 5,
    });
  });

  // Fenced code is not task content, so a line inside a fence must never be
  // adopted as the anchor's new home.
  test("does not relocate onto an identical line inside fenced code", () => {
    const source = "- [ ] a\n";
    const anchor = click(source, 0, false);
    expect(resolveTaskLine("```md\n- [ ] a\n```\n", anchor)).toEqual({
      ok: false,
      reason: "gone",
    });
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
    expect(toggleTaskLine(source, click(source, 0, false), true)).toEqual({
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
