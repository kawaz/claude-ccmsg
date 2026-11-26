// Which items of the Timeline fold to a bubble of one line, and what the line
// says (DR-0062 §12「解決済みのスレッドの吹き出しの畳み」, P36, P37; the one
// pure function DR-0068 §5 asks for).
// 何を保証するか:
//   - 解決済みのスレッドの項目は、フィルタの無い TL で畳む。行の中身は「✅ 解決済み:」の後に
//     本文の冒頭で、冒頭は原文の頭から空白と改行の並びを 1 つの空白に詰めた文字。markdown の
//     記号は落とさない。全角の括弧は CSS が付けるので、ここの文字に入らない (名前・選択・
//     コピーに入れない、P37)
//   - どのフィルタ (🔔 🔐 ⭐ 👤 🔍 💬) の中でも畳まない (P36)。開いたかは忘れない
//     (フィルタを外すと、開いていた項目は開いたまま)
//   - 解決済みでないスレッドの項目は畳まず、開いたかは忘れる (付け直すと畳んだ形から、§12)
//   - 開閉のキーは cid で決まり、同じ cid なら状態に依らず同じ (DR-0068 §5 の表)
import { describe, expect, test } from "bun:test";
import type { TimelineFilter } from "../src/client/locator.ts";
import { commentFoldKey, itemFoldOf, type FoldSubject } from "../src/client/item-fold.ts";

const FILTERS: readonly TimelineFilter[] = [
  "say",
  "permit",
  "bookmark",
  "prompt",
  "comment",
  "search",
];

function thread(patch: Partial<Extract<FoldSubject, { kind: "comment-thread" }>>): FoldSubject {
  return {
    kind: "comment-thread",
    cid: "c0001",
    resolved: true,
    text: "全く同じではありません。",
    frame: "comment",
    ...patch,
  };
}

describe("an item of a comment thread (DR-0062 §12)", () => {
  test("resolved, on the Timeline without a filter: folded to 「✅ 解決済み: <start>」", () => {
    expect(itemFoldOf(thread({}), null)).toEqual({
      state: "folded",
      key: commentFoldKey("c0001"),
      line: "✅ 解決済み: 全く同じではありません。",
      frame: "comment",
    });
  });

  test("the start squeezes runs of spaces and line breaks into one space, and keeps markdown", () => {
    const fold = itemFoldOf(
      thread({ text: "\n  **太字**\n\n- 箇条  の\t`code`\r\n> 引用  \n", frame: "reply" }),
      null,
    );
    expect(fold).toEqual({
      state: "folded",
      key: commentFoldKey("c0001"),
      line: "✅ 解決済み: **太字** - 箇条 の `code` > 引用",
      frame: "reply",
    });
  });

  test("an empty text leaves the words of the mark alone", () => {
    expect(itemFoldOf(thread({ text: " \n " }), null)).toMatchObject({
      state: "folded",
      line: "✅ 解決済み:",
    });
  });

  test("resolved, under any filter: not folded, and what opened it is kept (P36)", () => {
    for (const filter of FILTERS) {
      expect(itemFoldOf(thread({}), filter)).toEqual({
        state: "filtered",
        key: commentFoldKey("c0001"),
      });
    }
  });

  test("not resolved: not folded, with or without a filter, and what opened it is forgotten", () => {
    for (const filter of [null, ...FILTERS]) {
      expect(itemFoldOf(thread({ resolved: false }), filter)).toEqual({
        state: "none",
        key: commentFoldKey("c0001"),
      });
    }
  });

  test("the key is the cid's, whatever the state", () => {
    expect(commentFoldKey("c0001")).not.toBe(commentFoldKey("c0002"));
    const keys = [
      itemFoldOf(thread({}), null).key,
      itemFoldOf(thread({}), "comment").key,
      itemFoldOf(thread({ resolved: false }), null).key,
    ];
    expect(new Set(keys)).toEqual(new Set([commentFoldKey("c0001")]));
  });
});
