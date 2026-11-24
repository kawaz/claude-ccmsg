// Where the 💬 filter's items stand, by thread (DR-0062 §13, P10).
// 何を保証するか:
//   - スレッドの始まりの項目は描いた順のままで、その返信 (エージェントの返信、それへの人の
//     返信、未送信の返信) は返信先の直後に、同じ返信先への返信は時刻の順に続く。
//     3 件まとめて送って 3 件の返信が返った時は コメント 1 → 返信 1 → コメント 2 → …
//   - 返信先が一覧に無い返信と、スレッドを持たない項目 (FAB の下書き・btw) は自分の位置に立つ
//   - 線は見えているスレッドとスレッドの間にだけ立ち (見えている最初の項目が持つ)、スレッドの
//     中・一覧の頭には立たず、チェックボックスで隠れたスレッドは線を持たない
//   - エージェントの側は開いたスレッド (選んだコメントのスレッド) でだけ見え、見えない間は
//     線を持たない。押して選べるのは人のコメントの項目だけ (kawaz 2026-11-24)
//   - フィルタの無い TL で、エージェントの返信と続きの人のコメントの間に畳み以外の項目が
//     挟まっている時だけ、その返信に「↓続きへ↓」の移る先がある
import { describe, expect, test } from "bun:test";
import type { AgentReply, CommentRecord, UserComment } from "@ccmsg/protocol";
import {
  continuationsApart,
  nextComment,
  threadPlaces,
  type DrawnUnit,
  type ListedItem,
} from "../src/client/comment-threads.ts";
import { COMMENT_SHOW_DEFAULT } from "../src/client/comment-view.ts";

const SID = "s1";
const at = (s: number) => `2030-01-01T00:00:${String(s).padStart(2, "0")}.000Z`;

function user(cid: string, s: number, patch: Partial<UserComment> = {}): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: SID,
    anchor: { kind: "message", uuid: "row-1", msg_start_with: "x" },
    body: cid,
    written: { at: at(s) },
    sent: { at: at(s) },
    updated_at: "v",
    btw: false,
    status: "delivered",
    ...patch,
  };
}

function reply(cid: string, to: string, s: number): AgentReply {
  return {
    kind: "comment",
    author: "agent",
    cid,
    session_id: SID,
    anchor: { kind: "comment", cid: to },
    written: { at: at(s) },
    updated_at: "v",
  };
}

const byCid = (records: CommentRecord[]) => new Map(records.map((r) => [r.cid, r] as const));

/** The items of `records` (by cid) and `others` (keys), in the order given. */
function listed(
  records: ReadonlyMap<string, CommentRecord>,
  keys: readonly string[],
): ListedItem[] {
  return keys.map((key) => {
    const record = records.get(key);
    if (record === undefined) {
      return {
        key,
        kind: key.startsWith("b") ? "btw" : "draft",
        unsent: key.startsWith("d"),
        resolved: false,
      };
    }
    return {
      key: `c:${key}`,
      cid: key,
      kind: "comment",
      unsent: record.author === "user" && record.status === "draft",
      resolved: false,
      agent: record.author === "agent",
    };
  });
}

/** The keys in the order placed, and the ones a line stands above. */
function placedOf(
  items: ListedItem[],
  records: ReadonlyMap<string, CommentRecord>,
  show = COMMENT_SHOW_DEFAULT,
  open: ReadonlySet<string> = new Set(),
) {
  const places = threadPlaces(items, records, show, open);
  const order = [...places.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([key]) => key.replace(/^c:/, ""));
  const lines = [...places.entries()]
    .filter(([, p]) => p.sep)
    .map(([key]) => key.replace(/^c:/, ""));
  return { order, lines };
}

describe("by thread", () => {
  test("3 comments sent together and 3 replies: each reply right after its comment", () => {
    const records = byCid([
      user("c0001", 1),
      user("c0002", 1),
      user("c0003", 1),
      reply("c0011", "c0001", 5),
      reply("c0012", "c0002", 6),
      reply("c0013", "c0003", 7),
    ]);
    const items = listed(records, ["c0001", "c0002", "c0003", "c0011", "c0012", "c0013"]);
    expect(placedOf(items, records)).toEqual({
      order: ["c0001", "c0011", "c0002", "c0012", "c0003", "c0013"],
      lines: ["c0002", "c0003"],
    });
  });

  test("a reply to a reply follows the reply, before the next thread", () => {
    const records = byCid([
      user("c0001", 1),
      reply("c0011", "c0001", 2),
      user("c0005", 3),
      user("c0021", 4, { anchor: { kind: "comment", cid: "c0011" } }),
      reply("c0031", "c0021", 5),
    ]);
    const items = listed(records, ["c0001", "c0011", "c0005", "c0021", "c0031"]);
    expect(placedOf(items, records)).toEqual({
      order: ["c0001", "c0011", "c0021", "c0031", "c0005"],
      lines: ["c0005"],
    });
  });

  test("an unsent reply stands right after what it answers; replies to one item by their time", () => {
    const records = byCid([
      user("c0001", 1),
      reply("c0011", "c0001", 2),
      user("c0005", 3),
      user("c0022", 9, {
        anchor: { kind: "comment", cid: "c0001" },
        status: "draft",
        sent: undefined,
      }),
      user("c0021", 4, { anchor: { kind: "comment", cid: "c0001" } }),
    ]);
    // Drawn: the unsent one last (the filter's, at the end), c0021 at its row.
    const items = listed(records, ["c0001", "c0011", "c0021", "c0005", "c0022"]);
    expect(placedOf(items, records).order).toEqual(["c0001", "c0011", "c0021", "c0022", "c0005"]);
  });

  test("a reply whose reply-to is not listed, a draft and a btw stand at their own place", () => {
    const records = byCid([user("c0001", 1), reply("c0011", "c0099", 2), user("c0002", 3)]);
    const items = listed(records, ["c0001", "b1", "c0011", "d1", "c0002"]);
    // Its thread open (its root is itself: what it answers is not a record).
    expect(placedOf(items, records, COMMENT_SHOW_DEFAULT, new Set(["c0011"]))).toEqual({
      order: ["c0001", "b1", "c0011", "d1", "c0002"],
      lines: ["b1", "c0011", "d1", "c0002"],
    });
    // None open: the agent's reply is hidden, and has no line.
    expect(placedOf(items, records)).toEqual({
      order: ["c0001", "b1", "c0011", "d1", "c0002"],
      lines: ["b1", "d1", "c0002"],
    });
  });
});

describe("the lines between threads", () => {
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    user("c0002", 3),
    user("c0021", 4, {
      anchor: { kind: "comment", cid: "c0002" },
      status: "draft",
      sent: undefined,
    }),
    user("c0003", 5),
  ]);
  const items = listed(records, ["c0001", "c0011", "c0002", "c0021", "c0003", "d1"]);

  test("without sent, a thread all sent has no line, and the first one shown none", () => {
    const show = { ...COMMENT_SHOW_DEFAULT, sent: false };
    // Shown: c0021 (unsent, of c0002's thread) and the draft.
    expect(placedOf(items, records, show).lines).toEqual(["d1"]);
  });

  test("a resolved thread hidden has no line; the next one shown takes it", () => {
    const resolved = items.map((item) =>
      item.cid === "c0001" || item.cid === "c0011" ? { ...item, resolved: true } : item,
    );
    expect(placedOf(resolved, records).lines).toEqual(["c0003", "d1"]);
    expect(placedOf(resolved, records, { ...COMMENT_SHOW_DEFAULT, resolved: true }).lines).toEqual([
      "c0002",
      "c0003",
      "d1",
    ]);
  });
});

describe("the agent's side and the thread open", () => {
  // エージェントの返信は選んだスレッド (open) でだけ見え、見えない返信は線を持たない。
  // 押して選ぶのは人のコメントの項目 (btw の質問を含む) だけ。
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    user("c0021", 3, { anchor: { kind: "comment", cid: "c0011" } }),
    reply("c0031", "c0021", 4),
    user("c0002", 5),
    reply("c0012", "c0002", 6),
  ]);
  const items = [
    ...listed(records, ["c0001", "c0011", "c0021", "c0031", "c0002", "c0012"]),
    { key: "b1", cid: "b1", kind: "btw" as const, unsent: false, resolved: false },
    { key: "d1", kind: "draft" as const, unsent: true, resolved: false },
  ];
  const openOf = (open: ReadonlySet<string>) =>
    [...threadPlaces(items, records, COMMENT_SHOW_DEFAULT, open).entries()]
      .filter(([, place]) => place.open)
      .map(([key]) => key.replace(/^c:/, ""));

  test("none open: the agent's replies are marked and none is open; the lines stay on the person's comments", () => {
    const places = threadPlaces(items, records, COMMENT_SHOW_DEFAULT);
    expect(
      [...places.entries()].filter(([, p]) => p.agent).map(([key]) => key.replace(/^c:/, "")),
    ).toEqual(["c0011", "c0031", "c0012"]);
    expect(openOf(new Set())).toEqual([]);
    expect(placedOf(items, records).lines).toEqual(["c0002", "b1", "d1"]);
  });

  test("one open: all of its thread is open (a reply to a reply too), the other not", () => {
    expect(openOf(new Set(["c0001"]))).toEqual(["c0001", "c0011", "c0021", "c0031"]);
    expect(openOf(new Set(["c0002"]))).toEqual(["c0002", "c0012"]);
  });

  test("a press selects the person's comment it is (a btw's question too); the agent's side and a draft none", () => {
    const places = threadPlaces(items, records, COMMENT_SHOW_DEFAULT);
    expect(
      [...places.entries()].map(([key, place]) => [key.replace(/^c:/, ""), place.selects]),
    ).toEqual([
      ["c0001", "c0001"],
      ["c0011", undefined],
      ["c0021", "c0021"],
      ["c0031", undefined],
      ["c0002", "c0002"],
      ["c0012", undefined],
      ["b1", "b1"],
      ["d1", undefined],
    ]);
  });
});

describe("a btw's item", () => {
  // btw の項目は質問と答えを描き、答えへの返信はその項目の直後に続く。
  test("a reply to a btw's answer follows the btw's item", () => {
    const question = user("c0001", 1, { btw: true, status: "sent", anchor: { kind: "timing" } });
    const answer: CommentRecord = {
      kind: "comment",
      author: "btw",
      cid: "c0002",
      session_id: SID,
      anchor: { kind: "comment", cid: "c0001" },
      body: "a",
      written: { at: at(1) },
      updated_at: "v",
      status: "done",
    };
    const toAnswer = user("c0003", 5, { anchor: { kind: "comment", cid: "c0002" } });
    const other = user("c0004", 3);
    const records = byCid([question, answer, toAnswer, other]);
    const items: ListedItem[] = [
      {
        key: "c:c0001",
        cid: "c0001",
        also: ["c0002"],
        kind: "btw",
        unsent: false,
        resolved: false,
      },
      { key: "c:c0004", cid: "c0004", kind: "comment", unsent: false, resolved: false },
      { key: "c:c0003", cid: "c0003", kind: "comment", unsent: false, resolved: false },
    ];
    const places = threadPlaces(items, records, COMMENT_SHOW_DEFAULT);
    expect(["c:c0001", "c:c0003", "c:c0004"].map((key) => places.get(key)?.order)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("the continuation apart (「↓続きへ↓」)", () => {
  // 何を保証するか (DR-0062 §12): エージェントの返信 (と btw の答え) の続きは、それに返信した
  // 送った人のコメントのうち一番古いもの。未送信と消したものは続きにしない。続きが TL の上で
  // すぐ下 (間に畳みしか無い) なら出さず、別の項目が挟まっている時だけ移る先の行を返す。
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    user("c0022", 6, { anchor: { kind: "comment", cid: "c0011" } }),
    user("c0021", 4, { anchor: { kind: "comment", cid: "c0011" } }),
    user("c0023", 3, {
      anchor: { kind: "comment", cid: "c0011" },
      status: "draft",
      sent: undefined,
    }),
    user("c0002", 5),
    reply("c0012", "c0002", 6),
  ]);
  const rowOf = (cid: string) => `row-${cid}`;
  const item = (...cids: string[]): DrawnUnit => ({ fold: false, cids });
  const fold: DrawnUnit = { fold: true };

  test("the next is the oldest sent reply to it; not one unsent; none without", () => {
    expect(nextComment(records, "c0011")).toBe("c0021");
    expect(nextComment(records, "c0012")).toBeUndefined();
    const deleted = byCid([
      ...records.values(),
      user("c0024", 0, { anchor: { kind: "comment", cid: "c0012" }, status: "deleted" }),
    ]);
    expect(nextComment(deleted, "c0012")).toBeUndefined();
  });

  test("another item between: the row of the next; only folds between: none", () => {
    expect([
      ...continuationsApart(
        [item("c0001"), item("c0011"), fold, item(), item("c0021")],
        records,
        rowOf,
      ),
    ]).toEqual([["c0011", "row-c0021"]]);
    expect([
      ...continuationsApart(
        [item("c0001"), item("c0011"), fold, fold, item("c0021")],
        records,
        rowOf,
      ),
    ]).toEqual([]);
    expect([...continuationsApart([item("c0011"), item("c0021")], records, rowOf)]).toEqual([]);
  });

  test("a reply with no next, and a next with no row to move to, have none", () => {
    expect([...continuationsApart([item("c0012"), item(), item("c0002")], records, rowOf)]).toEqual(
      [],
    );
    expect([
      ...continuationsApart([item("c0011"), item(), item("c0021")], records, () => undefined),
    ]).toEqual([]);
  });

  test("a btw answer's next: drawn in the btw's item, apart from it", () => {
    const question = user("c0031", 1, { btw: true, status: "sent", anchor: { kind: "timing" } });
    const answer: CommentRecord = {
      kind: "comment",
      author: "btw",
      cid: "c0032",
      session_id: SID,
      anchor: { kind: "comment", cid: "c0031" },
      body: "a",
      written: { at: at(1) },
      updated_at: "v",
      status: "done",
    };
    const toAnswer = user("c0033", 5, { anchor: { kind: "comment", cid: "c0032" } });
    const btw = byCid([question, answer, toAnswer]);
    expect([
      ...continuationsApart([item("c0031", "c0032"), item(), item("c0033")], btw, rowOf),
    ]).toEqual([["c0032", "row-c0033"]]);
    expect([...continuationsApart([item("c0031", "c0032"), item("c0033")], btw, rowOf)]).toEqual(
      [],
    );
  });
});
