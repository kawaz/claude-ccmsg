// Which items of the Timeline fold to their bubble cut to one line, and the
// label on the folded bubble's frame (DR-0062 §12「解決済みのスレッドの吹き出しの
// 畳み」, P36, P37; the one pure function DR-0068 §5 asks for).
// 何を保証するか:
//   - 解決済みのスレッドの項目は、フィルタの無い TL で畳み、枠のラベルは「✅解決済み」
//   - どのフィルタ (🔔 🔐 ⭐ 👤 🔍 💬) の中でも畳まない (P36)。開いたかは忘れない
//     (フィルタを外すと、開いていた項目は開いたまま)
//   - 解決済みでないスレッドの項目は畳まず、開いたかは忘れる (付け直すと畳んだ形から、§12)
//   - 開閉のキーは cid で決まり、同じ cid なら状態に依らず同じ (DR-0068 §5 の表)
//   - 既読の応答・未読でない say と許可依頼 (DR-0068 §5) も同じ決まりで畳み、枠のラベルは
//     「✅既読」。既読でない (未読の) ものは畳まず、どのフィルタの中でも畳まない。開閉の
//     キーは応答はメッセージの uuid、say と許可依頼は tool_use の id で、種類の違う項目の
//     キーは重ならない
//   - 本文の字は扱わない (畳んでも本文は元の吹き出しのまま描く、P37)
import { describe, expect, test } from "bun:test";
import type { TimelineFilter } from "../src/client/locator.ts";
import {
  commentFoldKey,
  itemFoldOf,
  responseFoldKey,
  toolFoldKey,
  type FoldSubject,
} from "../src/client/item-fold.ts";

const FILTERS: readonly TimelineFilter[] = [
  "say",
  "permit",
  "bookmark",
  "prompt",
  "comment",
  "search",
];

function thread(patch: Partial<Extract<FoldSubject, { kind: "comment-thread" }>>): FoldSubject {
  return { kind: "comment-thread", cid: "c0001", resolved: true, ...patch };
}

describe("an item of a comment thread (DR-0062 §12)", () => {
  test("resolved, on the Timeline without a filter: folded, labelled 「✅解決済み」", () => {
    expect(itemFoldOf(thread({}), null)).toEqual({
      state: "folded",
      key: commentFoldKey("c0001"),
      label: "✅解決済み",
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

describe("a response read, a say and a request not unread (DR-0068 §5)", () => {
  const subjects: ReadonlyArray<[Exclude<FoldSubject, { kind: "comment-thread" }>, string]> = [
    [{ kind: "response", uuid: "u-1", read: true }, responseFoldKey("u-1")],
    [{ kind: "say", toolUseId: "toolu_s1", read: true }, toolFoldKey("toolu_s1")],
    [{ kind: "permit", toolUseId: "toolu_p1", read: true }, toolFoldKey("toolu_p1")],
  ];

  test("read, on the Timeline without a filter: folded, labelled 「✅既読」", () => {
    for (const [subject, key] of subjects) {
      expect(itemFoldOf(subject, null)).toEqual({ state: "folded", key, label: "✅既読" });
    }
  });

  test("read, under any filter: not folded, what opened it kept; not read: not folded, forgotten", () => {
    for (const [subject, key] of subjects) {
      for (const filter of FILTERS) {
        expect(itemFoldOf(subject, filter)).toEqual({ state: "filtered", key });
      }
      for (const filter of [null, ...FILTERS]) {
        expect(itemFoldOf({ ...subject, read: false }, filter)).toEqual({ state: "none", key });
      }
    }
  });

  test("the keys of items of different kinds do not meet", () => {
    const keys = [commentFoldKey("x"), responseFoldKey("x"), toolFoldKey("x")];
    expect(new Set(keys).size).toBe(3);
  });
});
