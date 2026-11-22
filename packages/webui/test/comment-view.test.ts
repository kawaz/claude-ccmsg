// What the Timeline reads of a session's comments (DR-0062 §6, §12, §13).
// 何を保証するか:
//   - 💬 の数は未送信のコメントの数
//   - スレッドは返信先を辿った最初のコメントでまとまり、解決済みかはその状態で決まる。
//     未送信を含むスレッドは解決にできない。見ていた最後の記録はスレッドの最後の記録
//   - 項目ごとのコメントの数は、その項目 (行・コメント) をアンカーにした人のコメントの数
//   - 送って transcript に出ていないコメントは送った時点の行の後に (送った時点がまだ
//     無い送信中・未確認のものは書いた時点の行の後に)、未送信のコメントは
//     アンカーの項目の後 (タイミングなら書いた時点の行の後) に置かれる
//   - 全部送る順は書いた順で、btw のコメントは入らない
//   - fold の項目へのコメントの on は、tool の呼び出し・agent への指示・agent からの応答の
//     語で、thinking だけの行は項目にならない
//   - 窓の外の届いたコメントは、その行の uuid と送った時刻で一覧に出る
//   - 送った結果と断りは日本語の文になり、daemon の英語の文も理由のコードも出さない。
//     返事の来なかった依頼はそれと分かる
//   - 窓の外のエージェントの返信は記録の時刻で一覧に出る (窓の中のものは出ない)。返信先の
//     引用は人のコメントなら本文の先頭、エージェントの返信なら記録の引用。エージェントの
//     返信への未送信の返信は、その返信の呼び出しの行 (窓に無ければ記録した時点の行) の
//     後に置かれる
import { describe, expect, test } from "bun:test";
import type { AgentReply, CommentRecord, UserComment } from "@ccmsg/protocol";
import type { TurnLine } from "../src/client/transcript-model.ts";
import {
  commentCounts,
  commentErrorText,
  commentOnOfFoldLine,
  deliveredOutside,
  pendingComments,
  recordQuoteOf,
  repliesOutside,
  replyLost,
  sendResultText,
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

  test("one waiting in the session's line, or left unknown with no point sent, stands where it was written", () => {
    // DR-0062 §11: a comment waiting its turn is `sending` with no `sent` yet,
    // and one the daemon stopped on is `unconfirmed` with none. Neither may
    // drop out of the Timeline (§2: one not sent stands where it was written).
    const waiting = user({ cid: "c0001", status: "sending" });
    const unknown = user({ cid: "c0002", status: "unconfirmed" });
    expect(pendingComments([waiting, unknown])).toEqual([
      { comment: waiting, after: "row-9", ts: "2030-01-01T00:00:00.000Z" },
      { comment: unknown, after: "row-9", ts: "2030-01-01T00:00:00.000Z" },
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

describe("outside the window", () => {
  test("a delivered comment whose row is not read stands at its row, by the time it was sent", () => {
    const outside = user({
      cid: "c0001",
      status: "delivered",
      row_uuid: "row-3",
      sent: { at: "2030-01-01T00:00:02.000Z" },
    });
    const inside = user({ cid: "c0002", status: "delivered", row_uuid: "row-4" });
    expect(deliveredOutside([outside, inside, user({ cid: "c0003" })], new Set(["c0002"]))).toEqual(
      [{ comment: outside, after: "row-3", ts: "2030-01-01T00:00:02.000Z" }],
    );
  });
});

describe("words", () => {
  test("what became of a comment sent", () => {
    const id = "c0001";
    expect(sendResultText({ kind: "comment", id, outcome: "sent" })).toBeNull();
    const texts = [
      sendResultText({ kind: "comment", id, outcome: "unconfirmed" }),
      sendResultText({ kind: "comment", id, outcome: "not_delivered", reason: "dialog" }),
      sendResultText({
        kind: "comment",
        id,
        outcome: "refused",
        reason: "not_sendable",
        status: "sent",
      }),
      sendResultText({ kind: "comment", id, outcome: "refused", reason: "conflict" }),
      sendResultText({ kind: "comment", id, outcome: "refused", reason: "not_found" }),
    ];
    expect(texts[1]).toContain("ダイアログ");
    expect(texts[2]).toContain("今は「送った」");
    for (const text of texts) expect(text ?? "").not.toMatch(/[a-z]{4,}_[a-z]+|dialog/);
  });

  test("a refusal reads by what was asked, and an unknown code is named", () => {
    const conflict = { code: "conflict", msg: "the thread has c0002 newer than c0001" };
    expect(commentErrorText("resolve", conflict)).toContain("記録が足された");
    expect(commentErrorText("update", conflict)).toContain("別の画面で先に");
    expect(commentErrorText("resolve", { code: "invalid_args", msg: "x" })).toContain(
      "解決済みにできない",
    );
    expect(commentErrorText("add", { code: "session_not_found", msg: "x" })).toContain(
      "セッションが daemon に見つからない",
    );
    expect(commentErrorText("update", { code: "state_not_writable", msg: "EACCES" })).toContain(
      "state dir に書けない",
    );
    expect(commentErrorText("add", { code: "internal", msg: "boom" })).toContain("(internal)");
    expect(commentErrorText("add", conflict)).not.toContain("newer");
  });

  test("no answer to a request written is told apart from a refusal", () => {
    expect(replyLost({ code: "request_timeout", msg: "x" })).toBe(true);
    expect(replyLost({ code: "connection_closed", msg: "x" })).toBe(true);
    expect(replyLost({ code: "conflict", msg: "x" })).toBe(false);
  });
});

describe("what a comment on a fold's row is on (DR-0062 §4, P2)", () => {
  const turn = (role: "user" | "assistant", segments: TurnLine["segments"]): TurnLine => ({
    kind: "turn",
    ts: null,
    role,
    segments,
  });
  test("a call, an instruction to an agent, and thinking alone", () => {
    expect(
      commentOnOfFoldLine(
        turn("assistant", [
          { kind: "thinking", text: "考える" },
          {
            kind: "bash-use",
            toolUseId: "t1",
            command: "ls -la",
            description: "",
            background: false,
            result: null,
            hasResult: false,
          },
        ]),
      ),
    ).toEqual({ on: "tool Bash の呼び出し", quote: "ls -la" });
    expect(
      commentOnOfFoldLine(
        turn("assistant", [
          {
            kind: "agent-send",
            to: "w1",
            summary: "直して",
            message: "全文",
            messageType: "message",
          },
        ]),
      ),
    ).toEqual({ on: "w1 への指示", quote: "直して" });
    expect(commentOnOfFoldLine(turn("assistant", [{ kind: "thinking", text: "考える" }]))).toBe(
      null,
    );
  });

  test("a teammate's answer is from that teammate", () => {
    const line: TurnLine = {
      ...turn("user", [
        {
          kind: "text",
          role: "user",
          text: '<teammate-message teammate_id="w1" summary="終わった">本文</teammate-message>',
        },
      ]),
      userMessageKind: "peer-message",
    };
    expect(commentOnOfFoldLine(line)?.on).toBe("w1 からの応答");
  });
});

describe("the agent's replies (DR-0062 §12, §13)", () => {
  const reply = (cid: string, replyTo: string, patch: Partial<AgentReply> = {}): AgentReply => ({
    ...agent(cid, replyTo),
    quote: "返信の先頭",
    written: { at: "2030-01-01T00:00:09.000Z", after_uuid: "row-7" },
    ...patch,
  });

  test("the replies outside the window are listed at the time they were kept", () => {
    const records = [
      user({ cid: "c0001", status: "delivered" }),
      reply("c0002", "c0001"),
      reply("c0003", "c0002"),
    ];
    expect(repliesOutside(records, new Set(["c0002"]))).toEqual([
      { reply: reply("c0003", "c0002"), ts: "2030-01-01T00:00:09.000Z" },
    ]);
  });

  test("what a reply quotes of the record it answers", () => {
    const records = byCid([
      user({ cid: "c0001", status: "delivered", body: "  ここは\n undefined を返すのでは？" }),
      reply("c0002", "c0001"),
    ]);
    expect(recordQuoteOf(records, "c0001")).toBe("ここは undefined を返すのでは？");
    expect(recordQuoteOf(records, "c0002")).toBe("返信の先頭");
    expect(recordQuoteOf(records, "c9999")).toBeUndefined();
  });

  test("an unsent reply to an agent's reply stands where the reply was kept", () => {
    const records = byCid([
      user({ cid: "c0001", status: "delivered", row_uuid: "row-3" }),
      reply("c0002", "c0001"),
      user({ cid: "c0003", anchor: { kind: "comment", cid: "c0002" } }),
    ]);
    expect(unsentComments(records).map((p) => [p.comment.cid, p.after])).toEqual([
      ["c0003", "row-7"],
    ]);
    // At the reply's call's row, when the window holds it.
    const rows = (cid: string) => (cid === "c0002" ? "row-call" : undefined);
    expect(unsentComments(records, rows).map((p) => [p.comment.cid, p.after])).toEqual([
      ["c0003", "row-call"],
    ]);
  });
});
