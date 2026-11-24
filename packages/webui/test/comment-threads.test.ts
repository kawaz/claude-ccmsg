// Where the 💬 filter's items stand, by thread (DR-0062 §13, P10).
// 何を保証するか:
//   - スレッドの始まりの項目は描いた順のままで、その返信 (エージェントの返信、それへの人の
//     返信) は返信先の直後に、同じ返信先への返信は時刻の順に続く。
//     3 件まとめて送って 3 件の返信が返った時は コメント 1 → 返信 1 → コメント 2 → …
//   - 返信先が一覧に無い返信と、スレッドを持たない項目 (送った FAB の下書き・btw) は自分の位置に立つ
//   - 未送信のもの (未送信のコメント・スレッドへの未送信の返信・未送信の FAB の下書き) は、時刻や
//     スレッドに関係なく一番下にまとまり、その中は書いた時刻の順 (kawaz 2026-11-24)。送ったものの
//     並びは未送信を抜いても変わらない
//   - 線は見えているスレッドとスレッドの間と、未送信のかたまりの手前にだけ立ち (見えている最初の
//     項目が持つ)、スレッドの中・未送信のかたまりの中・一覧の頭には立たず、チェックボックスで
//     隠れたスレッドは線を持たない
//   - エージェントの側は開いたスレッド (選んだコメントのスレッド) でだけ見え、見えない間は
//     線を持たない。押して選べるのは人のコメントの項目だけ (kawaz 2026-11-24)
//   - フィルタの無い TL で、エージェントの返信と続きの人のコメントの間に畳み以外の項目が
//     挟まっている時だけ、その返信に「↓続きへ↓」の移る先がある
import { describe, expect, test } from "bun:test";
import type { AgentReply, CommentRecord, UserComment } from "@ccmsg/protocol";
import {
  continuationsApart,
  nextComment,
  resolveMovesFrom,
  resolveMovesNext,
  threadNumbers,
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

  test("replies to one item by their time", () => {
    const records = byCid([
      user("c0001", 1),
      reply("c0011", "c0001", 2),
      user("c0005", 3),
      user("c0022", 6, { anchor: { kind: "comment", cid: "c0001" } }),
      user("c0021", 4, { anchor: { kind: "comment", cid: "c0001" } }),
    ]);
    const items = listed(records, ["c0001", "c0011", "c0022", "c0005", "c0021"]);
    expect(placedOf(items, records).order).toEqual(["c0001", "c0011", "c0021", "c0022", "c0005"]);
  });

  test("a reply whose reply-to is not listed, a draft sent and a btw stand at their own place", () => {
    const records = byCid([user("c0001", 1), reply("c0011", "c0099", 2), user("c0002", 3)]);
    // A FAB's draft sent (not known to have arrived) is not unsent.
    const items = listed(records, ["c0001", "b1", "c0011", "s1", "c0002"]);
    // Its thread open (its root is itself: what it answers is not a record).
    expect(placedOf(items, records, COMMENT_SHOW_DEFAULT, new Set(["c0011"]))).toEqual({
      order: ["c0001", "b1", "c0011", "s1", "c0002"],
      lines: ["b1", "c0011", "s1", "c0002"],
    });
    // None open: the agent's reply whose person's comment is not listed has
    // no other way to be seen, so it stands shown, with its line.
    expect(placedOf(items, records)).toEqual({
      order: ["c0001", "b1", "c0011", "s1", "c0002"],
      lines: ["b1", "c0011", "s1", "c0002"],
    });
    expect(threadPlaces(items, records, COMMENT_SHOW_DEFAULT).get("c:c0011")).toMatchObject({
      shown: true,
      agent: false,
    });
  });
});

describe("the unsent ones at the bottom", () => {
  // 何を保証するか (DR-0062 §13、kawaz 2026-11-24): 未送信のもの (未送信のコメント、スレッドへの
  // 未送信の返信、未送信の FAB の下書き) は、時刻やスレッドに関係なく一番下にまとまり、その中は
  // 書いた時刻の順。送ったものの並び (スレッドのまとめ方) は未送信を抜いた形のまま変わらない。
  // 未送信のかたまりの手前に線が 1 本立ち、かたまりの中には立たない。
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    // Unsent, written before everything after it: still at the bottom.
    user("c0003", 3, { status: "draft", sent: undefined }),
    user("c0021", 4, { anchor: { kind: "comment", cid: "c0011" } }),
    // An unsent reply to c0001's thread, written before c0021 was sent.
    user("c0022", 3, {
      anchor: { kind: "comment", cid: "c0011" },
      status: "draft",
      sent: undefined,
    }),
    user("c0002", 5),
    reply("c0012", "c0002", 6),
    // Sent once, back to unsent: its time written is the one that counts.
    user("c0004", 8, { status: "draft", written: { at: at(1) }, sent: { at: at(8) } }),
  ]);
  /** A FAB's draft written at second `s`. */
  const draft = (key: string, s: number, unsent = true): ListedItem => ({
    key,
    kind: "draft",
    unsent,
    resolved: false,
    written: at(s),
  });
  // d0 is written at the same moment as c0003 and c0022, and listed before
  // them: a comment comes first, as a send takes them (stockedItems).
  const items = [
    draft("d0", 3),
    ...listed(records, ["c0001", "c0011", "c0003", "c0022", "c0021", "c0002", "c0012", "c0004"]),
    draft("d1", 2),
    draft("d2", 7, false),
  ];

  test("whatever their time and thread, in the order written; the sent ones as they were", () => {
    expect(placedOf(items, records)).toEqual({
      order: [
        "c0001",
        "c0011",
        "c0021",
        "c0002",
        "c0012",
        "d2",
        // The unsent ones, by the time written.
        "c0004",
        "d1",
        "c0003",
        "c0022",
        "d0",
      ],
      lines: ["c0002", "d2", "c0004"],
    });
    // The sent ones stand as they stand with no unsent one listed.
    const sent = items.filter((item) => !item.unsent);
    expect(placedOf(sent, records).order).toEqual([
      "c0001",
      "c0011",
      "c0021",
      "c0002",
      "c0012",
      "d2",
    ]);
  });

  test("the unsent reply is of its thread still: open with it, selects itself", () => {
    const places = threadPlaces(items, records, COMMENT_SHOW_DEFAULT, new Set(["c0001"]));
    expect(places.get("c:c0022")).toMatchObject({ open: true, selects: "c0022" });
    expect(places.get("c:c0003")).toMatchObject({ open: false });
  });

  test("without sent, only the unsent ones, the first with no line", () => {
    expect(placedOf(items, records, { ...COMMENT_SHOW_DEFAULT, sent: false }).lines).toEqual([]);
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
    // Shown: c0021 (unsent, of c0002's thread) and the draft, together at the
    // bottom with no line between.
    expect(placedOf(items, records, show).lines).toEqual([]);
  });

  test("a resolved thread hidden has no line; the next one shown takes it", () => {
    const resolved = items.map((item) =>
      item.cid === "c0001" || item.cid === "c0011" ? { ...item, resolved: true } : item,
    );
    expect(placedOf(resolved, records).lines).toEqual(["c0003", "c0021"]);
    expect(placedOf(resolved, records, { ...COMMENT_SHOW_DEFAULT, resolved: true }).lines).toEqual([
      "c0002",
      "c0003",
      "c0021",
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

describe("the numbers in a thread (「1 / 3」)", () => {
  // 何を保証するか (DR-0062 §12、§13、kawaz 2026-11-24): 人のコメントが 2 つ以上のスレッドの
  // 人のコメントに、そのスレッドの人のコメントの数と何番目かを付ける。数えるのは消していない
  // もの (未送信も数える)。順はスレッドの中の順 (返信先の直後、同じ返信先への返信は時刻の順) で、
  // 未送信のものも、💬 のフィルタで一番下に置かれる前のスレッドの中の位置で数える。人のコメントが
  // 1 つだけのスレッドには付けない。エージェントの返信は付けない (返信先の番号を出す)。
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    user("c0022", 6, { anchor: { kind: "comment", cid: "c0011" } }),
    user("c0021", 4, {
      anchor: { kind: "comment", cid: "c0011" },
      status: "draft",
      sent: undefined,
    }),
    user("c0023", 5, { anchor: { kind: "comment", cid: "c0011" }, status: "deleted" }),
    reply("c0031", "c0022", 7),
    user("c0002", 3),
    reply("c0012", "c0002", 4),
  ]);

  test("each of the person's comments of a thread of 3, in the thread's order; unsent counted, deleted not", () => {
    const numbers = threadNumbers(records);
    expect(
      ["c0001", "c0021", "c0022"].map((cid) => {
        const n = numbers.get(cid);
        return n === undefined ? null : `${String(n.at)} / ${String(n.of)}`;
      }),
    ).toEqual(["1 / 3", "2 / 3", "3 / 3"]);
    expect(numbers.has("c0023")).toBe(false);
    expect(numbers.has("c0011")).toBe(false);
    expect(numbers.has("c0031")).toBe(false);
    // In the 💬 filter the sent ones stand in the order of their numbers, the
    // unsent one (2 / 3) at the bottom.
    const order = placedOf(
      listed(records, ["c0001", "c0011", "c0021", "c0022", "c0031", "c0002", "c0012"]),
      records,
    ).order.filter((cid) => numbers.has(cid));
    expect(order).toEqual(["c0001", "c0022", "c0021"]);
  });

  test("a thread of one person's comment has none", () => {
    const numbers = threadNumbers(records);
    expect(numbers.has("c0002")).toBe(false);
    expect(numbers.has("c0012")).toBe(false);
  });
});

describe("what moves as threads are resolved (ResolveMoves)", () => {
  // 何を保証するか (DR-0062 §13、kawaz 2026-11-24): フィルタに入った時は何も動かず、その後に
  // 解決が変わったスレッド (付けても外しても) と、resolved のチェックを切り替えた後の解決済みの項目が
  // 動く。他の出し入れ (他のチェックボックス、スレッドの開閉) が変わると動きは解ける (その変化では
  // 動かさない)。変わらない描画では前の値をそのまま返す (描画の度に作り直さない)。
  const records = byCid([
    user("c0001", 1),
    reply("c0011", "c0001", 2),
    user("c0002", 3),
    user("c0003", 4),
  ]);
  const items = listed(records, ["c0001", "c0011", "c0002", "c0003"]);
  const moving = (moves: Parameters<typeof threadPlaces>[4], resolvedCids: string[] = []) =>
    [
      ...threadPlaces(
        items.map((item) => ({ ...item, resolved: resolvedCids.includes(item.cid ?? "") })),
        records,
        COMMENT_SHOW_DEFAULT,
        new Set(),
        moves,
      ).entries(),
    ]
      .filter(([, place]) => place.motion)
      .map(([key]) => key.replace(/^c:/, ""));

  test("entered: none; a thread resolved and taken off stays moving; the same state, the same value", () => {
    const start = resolveMovesFrom(new Set(["c0003"]), false, "o");
    expect(moving(start, ["c0003"])).toEqual([]);
    expect(resolveMovesNext(start, new Set(["c0003"]), false, "o")).toBe(start);
    const resolved = resolveMovesNext(start, new Set(["c0003", "c0001"]), false, "o");
    expect(moving(resolved, ["c0003", "c0001", "c0011"])).toEqual(["c0001", "c0011"]);
    const back = resolveMovesNext(resolved, new Set(["c0003"]), false, "o");
    expect([...back.threads]).toEqual(["c0001"]);
    expect(back.box).toBe(false);
  });

  test("the others changed: nothing moves until the next change of resolution", () => {
    const moved = resolveMovesNext(
      resolveMovesFrom(new Set(), false, "o"),
      new Set(["c0001"]),
      true,
      "o",
    );
    expect([moved.threads.size, moved.box]).toEqual([1, true]);
    const others = resolveMovesNext(moved, new Set(["c0001"]), true, "o2");
    expect([others.threads.size, others.box]).toEqual([0, false]);
    // Changed together with the others: the resolution's change moves.
    const both = resolveMovesNext(others, new Set(["c0001", "c0002"]), true, "o3");
    expect([...both.threads]).toEqual(["c0002"]);
  });

  test("the resolved box turned: every resolved item moves", () => {
    const turned = resolveMovesNext(
      resolveMovesFrom(new Set(["c0003"]), false, "o"),
      new Set(["c0003"]),
      true,
      "o",
    );
    expect(turned.box).toBe(true);
    expect(moving(turned, ["c0003"])).toEqual(["c0003"]);
  });
});
