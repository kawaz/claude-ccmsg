// Where the 💬 filter's items stand, by thread (DR-0062 §13, P10).
// 何を保証するか:
//   - スレッドの始まりの項目は描いた順のままで、その返信 (エージェントの返信、それへの人の
//     返信、未送信の返信) は返信先の直後に、同じ返信先への返信は時刻の順に続く。
//     3 件まとめて送って 3 件の返信が返った時は コメント 1 → 返信 1 → コメント 2 → …
//   - 返信先が一覧に無い返信と、スレッドを持たない項目 (FAB の下書き・btw) は自分の位置に立つ
//   - 線は見えているスレッドとスレッドの間にだけ立ち (見えている最初の項目が持つ)、スレッドの
//     中・一覧の頭には立たず、チェックボックスで隠れたスレッドは線を持たない
import { describe, expect, test } from "bun:test";
import type { AgentReply, CommentRecord, UserComment } from "@ccmsg/protocol";
import { threadPlaces, type ListedItem } from "../src/client/comment-threads.ts";
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
    };
  });
}

/** The keys in the order placed, and the ones a line stands above. */
function placedOf(
  items: ListedItem[],
  records: ReadonlyMap<string, CommentRecord>,
  show = COMMENT_SHOW_DEFAULT,
) {
  const places = threadPlaces(items, records, show);
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
    expect(placedOf(items, records)).toEqual({
      order: ["c0001", "b1", "c0011", "d1", "c0002"],
      lines: ["b1", "c0011", "d1", "c0002"],
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
