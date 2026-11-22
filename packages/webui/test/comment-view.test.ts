// What the Timeline reads of a session's comments (DR-0062 §6, §12, §13).
// 何を保証するか:
//   - 💬 の数は未送信のコメントの数
//   - スレッドは返信先を辿った最初のコメントでまとまり、解決済みかはその状態で決まる。
//     未送信を含むスレッドは解決にできない。見ていた最後の記録はスレッドの最後の記録
//   - 項目ごとのコメントの数は、その項目 (行・コメント) をアンカーにした人のコメントの数
//   - 送って transcript に出ていないコメントは送った時点の行の後に、未送信のコメントは
//     アンカーの項目の後 (タイミングなら書いた時点の行の後) に置かれる
//   - 全部送る順は書いた順で、btw のコメントは入らない
import { describe, expect, test } from "bun:test";
import type { AgentReply, CommentRecord, UserComment } from "@ccmsg/protocol";
import {
  commentCounts,
  pendingComments,
  sendOrder,
  threadLastCid,
  threadResolvable,
  threadResolved,
  threadRootOf,
  unsentComments,
  unsentCount,
} from "../src/client/comment-view.ts";

const SID = "s1";

function user(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: "row-1", on: "応答" },
    body: "x",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: "row-9" },
    updated_at: "v",
    btw: false,
    status: "draft",
    ...patch,
  };
}

function agent(cid: string, replyTo: string): AgentReply {
  return {
    kind: "comment",
    author: "agent",
    cid,
    session_id: SID,
    anchor: { kind: "comment", cid: replyTo },
    written: { at: "2030-01-01T00:00:09.000Z" },
    updated_at: "v",
  };
}

const byCid = (records: CommentRecord[]) => new Map(records.map((r) => [r.cid, r] as const));

describe("counts", () => {
  test("the badge counts the unsent comments, and an item the comments made on it", () => {
    const records = [
      user({ cid: "c0001" }),
      user({ cid: "c0002", status: "sent" }),
      user({ cid: "c0003", anchor: { kind: "comment", cid: "c0002" } }),
      agent("c0004", "c0002"),
    ];
    expect(unsentCount(records)).toBe(2);
    expect(commentCounts(records)).toEqual(
      new Map([
        ["u:row-1", 2],
        ["c:c0002", 1],
      ]),
    );
  });
});

describe("threads", () => {
  const records = byCid([
    user({ cid: "c0001", status: "delivered" }),
    agent("c0002", "c0001"),
    user({ cid: "c0003", status: "sent", anchor: { kind: "comment", cid: "c0002" } }),
    user({
      cid: "c0004",
      status: "delivered",
      anchor: { kind: "message", uuid: "row-2", on: "応答" },
    }),
  ]);

  test("a thread is followed up to its first comment, and its last record is the newest", () => {
    expect(threadRootOf(records, "c0003")).toBe("c0001");
    expect(threadLastCid(records, "c0001")).toBe("c0003");
    expect(threadRootOf(records, "c0004")).toBe("c0004");
  });

  test("whether it is resolved is its first comment's thread state", () => {
    const threads = new Map([
      ["c0001", { kind: "thread" as const, session_id: SID, root: "c0001", resolved_at: "t" }],
    ]);
    expect(threadResolved(records, threads, "c0003")).toBe(true);
    expect(threadResolved(records, threads, "c0004")).toBe(false);
  });

  test("a thread with an unsent comment is not resolvable", () => {
    const withDraft = new Map(records).set(
      "c0005",
      user({ cid: "c0005", anchor: { kind: "comment", cid: "c0003" } }),
    );
    expect(threadResolvable(records, "c0001")).toBe(true);
    expect(threadResolvable(withDraft, "c0001")).toBe(false);
  });
});

describe("placement", () => {
  test("a comment sent and not delivered stands after the row it was sent at", () => {
    const sent = user({
      cid: "c0001",
      status: "sent",
      sent: { at: "2030-01-01T00:00:03.000Z", after_uuid: "row-5" },
    });
    expect(pendingComments([sent, user({ cid: "c0002", status: "delivered" })])).toEqual([
      { comment: sent, after: "row-5", ts: "2030-01-01T00:00:03.000Z" },
    ]);
  });

  test("an unsent comment stands after its item, a reply after what it answers, a moment where it was written", () => {
    const replied = user({ cid: "c0001", status: "delivered", row_uuid: "row-7" });
    const onItem = user({ cid: "c0002" });
    const reply = user({ cid: "c0003", anchor: { kind: "comment", cid: "c0001" } });
    const atMoment = user({ cid: "c0004", anchor: { kind: "timing" } });
    const placed = unsentComments(byCid([replied, onItem, reply, atMoment]));
    expect(placed.map((p) => [p.comment.cid, p.after])).toEqual([
      ["c0002", "row-1"],
      ["c0003", "row-7"],
      ["c0004", "row-9"],
    ]);
  });

  test("全部送る sends the unsent comments in the order written, btw ones apart", () => {
    const later = user({ cid: "c0001", written: { at: "2030-01-01T00:00:05.000Z" } });
    const earlier = user({ cid: "c0002", written: { at: "2030-01-01T00:00:01.000Z" } });
    const btw = user({ cid: "c0003", btw: true });
    expect(sendOrder(byCid([later, earlier, btw])).map((c) => c.cid)).toEqual(["c0002", "c0001"]);
  });
});
