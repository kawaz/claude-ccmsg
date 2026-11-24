// What the Timeline reads of a session's comments (DR-0062 §6, §12, §13).
// 何を保証するか:
//   - 💬 の数は未送信のコメントの数
//   - スレッドは返信先を辿った最初のコメントでまとまり、解決済みかはその状態で決まる。
//     未送信を含むスレッドは解決にできない。見ていた最後の記録はスレッドの最後の記録
//   - 項目ごとのコメントの数は、その項目 (行・コメント) をアンカーにした人のコメントの数
//   - 送って transcript に出ていないコメントは送った時点の行の後に (送った時点がまだ
//     無い送信中・未確認のものは書いた時点の行の後に)、未送信のコメントは
//     アンカーの項目の後 (タイミングなら書いた時点の行の後) に置かれる
//   - 送る・全部送信の対象は、未送信のコメント (btw のコメントは入らない) と FAB のキューの
//     下書きの全部で、書いた時刻の順。チェックボックスで隠れているものも入る
//   - 💬 のフィルタのチェックボックスの既定は sent / comment / btw が入り resolved が切れて
//     いる。sent を外すと未送信だけが残り、comment / btw はその種類を、resolved は解決済み
//     のスレッドを隠す。FAB の下書きは comment / btw に依らない。FAB の下書きは送った時点
//     (無ければ書いた時点) の行の後に置かれる
//   - fold の項目でコメントの対象になるのは agent への指示と agent からの応答だけで、
//     msg_start_with はその見出しの文の冒頭。tool の呼び出しと thinking だけの行は対象でない
//   - 窓の外の届いたコメントは、その行の uuid と送った時刻で一覧に出る
//   - 送った結果と断りは日本語の文になり、daemon の英語の文も理由のコードも出さない。
//     返事の来なかった依頼はそれと分かる
//   - 窓の外のエージェントの返信は記録の時刻で一覧に出る (窓の中のものは出ない)。返信先の
//     引用は人のコメントなら本文の冒頭、エージェントの返信なら記録の本文の冒頭 (body_start)。エージェントの
//     返信への未送信の返信は、その返信の呼び出しの行 (窓に無ければ記録した時点の行) の
//     後に置かれる
//   - 吹き出しの範囲のコメントは、メッセージなら同じ行と冒頭の選択範囲のアンカー、
//     コメントなら同じ cid で選んだ文字を持つ返信 (消したもの・全体へのものは除く)。
//     💬 のフィルタの選択は項目ごと (その項目のコメント全部) か 1 件 (範囲の 💬)
import { describe, expect, test } from "bun:test";
import type {
  AgentReply,
  BtwAnswer,
  CommentRecord,
  PromptDraftRecord,
  UserComment,
} from "@ccmsg/protocol";
import type { TurnLine } from "../src/client/transcript-model.ts";
import {
  commentCounts,
  commentPlaceRow,
  openThreadRoots,
  threadOpenOf,
  threadPressKey,
  commentErrorText,
  commentOnOfResponse,
  commentOnOfFoldLine,
  deliveredOutside,
  pendingComments,
  recordQuoteOf,
  repliesOutside,
  replyLost,
  sendResultText,
  sendResultsText,
  stockedItems,
  COMMENT_SHOW_DEFAULT,
  commentItemShown,
  commentShowTokens,
  placedDrafts,
  threadLastCid,
  threadResolvable,
  threadResolved,
  threadRootOf,
  unsentComments,
  unsentCount,
  commentSelected,
  commentSelectionKey,
  quoteOnBubble,
  quotesOn,
} from "../src/client/comment-view.ts";

const SID = "s1";

function user(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: "row-1", msg_start_with: "x" },
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
      anchor: { kind: "message", uuid: "row-2", msg_start_with: "x" },
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

  test("everything stocked is the unsent comments in the order written, btw ones apart", () => {
    const later = user({ cid: "c0001", written: { at: "2030-01-01T00:00:05.000Z" } });
    const earlier = user({ cid: "c0002", written: { at: "2030-01-01T00:00:01.000Z" } });
    const btw = user({ cid: "c0003", btw: true });
    const sent = user({ cid: "c0004", status: "sent" });
    expect(stockedItems([later, earlier, btw, sent], [])).toEqual([
      { kind: "comment", cid: "c0002", seen_updated_at: "v" },
      { kind: "comment", cid: "c0001", seen_updated_at: "v" },
    ]);
  });
});

function draft(
  patch: Partial<PromptDraftRecord> & Pick<PromptDraftRecord, "id">,
): PromptDraftRecord {
  return {
    kind: "draft",
    session_id: SID,
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: "row-2" },
    updated_at: "d",
    text: "t",
    attachments: [],
    status: "queued",
    ...patch,
  };
}

describe("the 💬 filter's head (DR-0062 §13)", () => {
  test("it opens with sent, comment and btw checked and resolved not", () => {
    expect(COMMENT_SHOW_DEFAULT).toEqual({ sent: true, comment: true, btw: true, resolved: false });
    expect(commentShowTokens(COMMENT_SHOW_DEFAULT)).toBe("sent comment btw");
    expect(commentShowTokens({ sent: false, comment: true, btw: false, resolved: true })).toBe(
      "comment resolved",
    );
  });

  test("each box hides its own: sent what is sent, comment and btw their kind, resolved a resolved thread", () => {
    const all = { sent: true, comment: true, btw: true, resolved: true };
    const sentComment = { kind: "comment", unsent: false, resolved: false } as const;
    const unsentComment = { kind: "comment", unsent: true, resolved: false } as const;
    const btw = { kind: "btw", unsent: false, resolved: false } as const;
    const unsentDraft = { kind: "draft", unsent: true, resolved: false } as const;
    const sentDraft = { kind: "draft", unsent: false, resolved: false } as const;
    const resolved = { kind: "comment", unsent: false, resolved: true } as const;
    const noSent = { ...all, sent: false };
    expect(commentItemShown(noSent, sentComment)).toBe(false);
    expect(commentItemShown(noSent, btw)).toBe(false);
    expect(commentItemShown(noSent, sentDraft)).toBe(false);
    expect(commentItemShown(noSent, unsentComment)).toBe(true);
    expect(commentItemShown(noSent, unsentDraft)).toBe(true);
    const noComment = { ...all, comment: false };
    expect(commentItemShown(noComment, sentComment)).toBe(false);
    expect(commentItemShown(noComment, unsentComment)).toBe(false);
    expect(commentItemShown(noComment, btw)).toBe(true);
    expect(commentItemShown(noComment, unsentDraft)).toBe(true);
    const noBtw = { ...all, btw: false };
    expect(commentItemShown(noBtw, btw)).toBe(false);
    expect(commentItemShown(noBtw, sentComment)).toBe(true);
    expect(commentItemShown({ ...all, comment: false, btw: false }, unsentDraft)).toBe(true);
    expect(commentItemShown(COMMENT_SHOW_DEFAULT, resolved)).toBe(false);
    expect(commentItemShown(all, resolved)).toBe(true);
  });

  // 送る (FAB・コメントのフォーム) と 全部送信 は、溜めたコメントと FAB の下書きの全部を
  // 書いた時刻の順に送る (kawaz 2026-11-24)。チェックボックスも解決の状態も見ない。届いたか
  // 分からない下書きは入らない。同じ時刻は渡した順のまま。
  test("everything stocked is the unsent comments and queued drafts in the order written, whatever is hidden", () => {
    const records = byCid([
      user({ cid: "c0001", status: "delivered" }),
      user({
        cid: "c0002",
        anchor: { kind: "comment", cid: "c0001" },
        written: { at: "2030-01-01T00:00:02.000Z" },
      }),
      user({ cid: "c0003", written: { at: "2030-01-01T00:00:04.000Z" } }),
    ]);
    const drafts = [
      draft({ id: "d2", written: { at: "2030-01-01T00:00:03.000Z" } }),
      draft({ id: "d1", written: { at: "2030-01-01T00:00:03.000Z" } }),
      draft({ id: "d0", written: { at: "2030-01-01T00:00:01.000Z" } }),
      draft({ id: "d3", status: "unconfirmed" }),
    ];
    const items = stockedItems(records.values(), drafts);
    // No box nor thread state is asked: a reply (c0002) goes as any other.
    expect(items.map((item) => (item.kind === "comment" ? item.cid : item.id))).toEqual([
      "d0",
      "c0002",
      "d2",
      "d1",
      "c0003",
    ]);
    expect(items[2]).toEqual({ kind: "draft", id: "d2", seen_updated_at: "d" });
  });

  test("a FAB's draft stands after the row it was sent at, else the one it was written at", () => {
    const placed = placedDrafts([
      draft({ id: "d1" }),
      draft({
        id: "d2",
        status: "unconfirmed",
        sent: { at: "2030-01-01T00:00:04.000Z", after_uuid: "row-5" },
      }),
    ]);
    expect(placed.map((p) => [p.draft.id, p.after, p.ts])).toEqual([
      ["d1", "row-2", "2030-01-01T00:00:00.000Z"],
      ["d2", "row-5", "2030-01-01T00:00:04.000Z"],
    ]);
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

// 何を保証するか (DR-0062 §13、kawaz 2026-11-24): 全部送信で入らなかったものの文は、同じ理由の
// ものを 1 行にまとめて数を添える (4 件が同じ理由なら同じ文を 4 回並べない)。1 件なら数を
// 添えず今の文のまま、理由が違えば理由ごとに 1 行 (最初に出た順)。全部入ったなら何も言わない。
describe("sendResultsText (全部送信の送れなかった文)", () => {
  const notDelivered = (id: string) =>
    ({ kind: "comment", id, outcome: "not_delivered", reason: "no_module" }) as const;
  const conflict = (id: string) =>
    ({ kind: "draft", id, outcome: "refused", reason: "conflict" }) as const;

  test("同じ理由は数を添えて 1 行にまとめる", () => {
    const one = sendResultText(notDelivered("c0001"));
    expect(
      sendResultsText(["c0001", "c0002", "c0003", "c0004"].map((id) => notDelivered(id))),
    ).toBe(`4 件: ${one ?? ""}`);
  });

  test("1 件なら今の文のまま", () => {
    expect(sendResultsText([notDelivered("c0001")])).toBe(sendResultText(notDelivered("c0001")));
  });

  test("理由が違えば理由ごとに 1 行、最初に出た順", () => {
    const results = [
      conflict("d1"),
      notDelivered("c0001"),
      conflict("d2"),
      { kind: "comment", id: "c0002", outcome: "sent" } as const,
    ];
    expect(sendResultsText(results)).toBe(
      [`2 件: ${sendResultText(conflict("d1")) ?? ""}`, sendResultText(notDelivered("c0001"))].join(
        "\n",
      ),
    );
  });

  test("全部入ったなら null", () => {
    expect(sendResultsText([{ kind: "comment", id: "c0001", outcome: "sent" }])).toBeNull();
    expect(sendResultsText([])).toBeNull();
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

describe("what a comment on a fold's row is on (DR-0062 §2, §4)", () => {
  const turn = (role: "user" | "assistant", segments: TurnLine["segments"]): TurnLine => ({
    kind: "turn",
    ts: null,
    role,
    segments,
  });
  test("an instruction to an agent is on its start; a tool's call and thinking alone are on nothing", () => {
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
    ).toBeNull();
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
    ).toEqual({ msg_start_with: "直して" });
    expect(commentOnOfFoldLine(turn("assistant", [{ kind: "thinking", text: "考える" }]))).toBe(
      null,
    );
  });

  test("a teammate's answer starts with its summary", () => {
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
    expect(commentOnOfFoldLine(line)).toEqual({ msg_start_with: "終わった" });
  });
});

// 何を保証するか: メインの会話の応答へのコメントの msg_start_with は、応答の文の冒頭
// (空白を詰めた 30 文字)。
describe("what a comment on the main conversation's response is on (DR-0062 §4)", () => {
  test("the start of the response's text", () => {
    const line: TurnLine = {
      kind: "turn",
      ts: null,
      role: "assistant",
      segments: [{ kind: "text", role: "assistant", text: `終わった。\n\n${"続き".repeat(20)}` }],
    };
    expect(commentOnOfResponse(line)).toEqual({
      msg_start_with: `終わった。 ${"続き".repeat(12)}…`,
    });
  });
});

describe("the agent's replies (DR-0062 §12, §13)", () => {
  const reply = (cid: string, replyTo: string, patch: Partial<AgentReply> = {}): AgentReply => ({
    ...agent(cid, replyTo),
    body_start: "返信の先頭",
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

describe("quotesOn and commentSelected (DR-0062 §2, §12)", () => {
  const choice = { text: "選んだ", before: "前", after: "後" };
  const records = byCid([
    user({
      cid: "c0001",
      anchor: { kind: "selection", uuid: "u1", msg_start_with: "答え", ...choice },
    }),
    // Another message drawn of the same row (a ccmsg row's messages).
    user({
      cid: "c0002",
      anchor: { kind: "selection", uuid: "u1", msg_start_with: "別", ...choice },
    }),
    user({ cid: "c0003", anchor: { kind: "message", uuid: "u1", msg_start_with: "答え" } }),
    user({
      cid: "c0004",
      status: "deleted",
      anchor: { kind: "selection", uuid: "u1", msg_start_with: "答え", ...choice },
    }),
    user({ cid: "c0005", anchor: { kind: "comment", cid: "c0009", ...choice, start: 3 } }),
    user({ cid: "c0006", anchor: { kind: "comment", cid: "c0009" } }),
  ]);

  test("a message's quotes are its row's and start's choices, not deleted nor whole ones", () => {
    expect(
      quotesOn(records, { kind: "message", uuid: "u1", msg_start_with: "答え" }).map((q) => q.cid),
    ).toEqual(["c0001"]);
  });

  test("a comment's quotes are the replies to it with a text chosen", () => {
    expect(quotesOn(records, { kind: "comment", cid: "c0009" })).toEqual([
      { cid: "c0005", quote: { ...choice, start: 3 } },
    ]);
  });

  // 何を保証するか: 記録のアンカーとフォームのアンカーは同じ形で、吹き出しの中の引用を
  // 同じ規則で読む (開いているフォームの範囲を記録の範囲と同じく探し直して塗るため)。
  // 吹き出し全体・別の吹き出し・ファイルの箇所へのアンカーは引用を持たない。
  test("quoteOnBubble: a choice in that message or comment; none for the whole, another, a file", () => {
    const message = { kind: "message", uuid: "u1", msg_start_with: "答え" } as const;
    expect(
      quoteOnBubble({ kind: "selection", uuid: "u1", msg_start_with: "答え", ...choice }, message),
    ).toEqual(choice);
    expect(quoteOnBubble({ kind: "message", uuid: "u1", msg_start_with: "答え" }, message)).toBe(
      null,
    );
    expect(
      quoteOnBubble({ kind: "selection", uuid: "u2", msg_start_with: "答え", ...choice }, message),
    ).toBe(null);
    expect(
      quoteOnBubble(
        { kind: "file", path: "a.md", view: "source", ...choice, line: 1, line_text: "x" },
        message,
      ),
    ).toBe(null);
    expect(
      quoteOnBubble(
        { kind: "comment", cid: "c0009", text: "選んだ" },
        { kind: "comment", cid: "c0009" },
      ),
    ).toEqual({ text: "選んだ", before: "", after: "", start: undefined });
  });

  test("selected: every comment on the item selected, or the one comment selected", () => {
    const anchor = { kind: "message", uuid: "u1", msg_start_with: "答え" } as const;
    expect(commentSelected("u:u1", anchor, "c0003")).toBe(true);
    expect(commentSelected(commentSelectionKey("c0003"), anchor, "c0003")).toBe(true);
    expect(commentSelected(commentSelectionKey("c0001"), anchor, "c0003")).toBe(false);
    expect(commentSelected(null, anchor, "c0003")).toBe(false);
  });
});

// 何を保証するか (DR-0062 §13「元の場所へ」): 「コメントした場所へ」の行は、届いた人の
// コメントはその行、エージェントの返信は呼び出しの行、btw の問答と届く前の送ったコメントは
// その項目が後ろに描かれる行 (送った時点、無ければ書いた時点)。消したもの・無いものは無し。
describe("commentPlaceRow", () => {
  const btwAnswer: BtwAnswer = {
    kind: "comment",
    author: "btw",
    cid: "c0012",
    session_id: SID,
    anchor: { kind: "comment", cid: "c0011" },
    body: "答え",
    written: { at: "2030-01-01T00:00:02.000Z", after_uuid: "row-answer" },
    updated_at: "v",
    status: "done",
  };
  const records = byCid([
    user({ cid: "c0001", status: "delivered", row_uuid: "row-3" }),
    user({ cid: "c0002", status: "sent", sent: { at: "t", after_uuid: "row-5" } }),
    user({ cid: "c0003", status: "deleted" }),
    user({ cid: "c0011", btw: true, status: "sent", sent: { at: "t", after_uuid: "row-7" } }),
    btwAnswer,
    agent("c0021", "c0001"),
  ]);
  const replyRow = (cid: string) => (cid === "c0021" ? "row-call" : undefined);

  test("each kind's row", () => {
    expect(commentPlaceRow(records, "c0001", replyRow)).toBe("row-3");
    expect(commentPlaceRow(records, "c0002", replyRow)).toBe("row-5");
    expect(commentPlaceRow(records, "c0011", replyRow)).toBe("row-7");
    expect(commentPlaceRow(records, "c0012", replyRow)).toBe("row-7");
    expect(commentPlaceRow(records, "c0021", replyRow)).toBe("row-call");
  });

  test("none for a deleted comment, an unknown cid, or a reply the window does not hold", () => {
    expect(commentPlaceRow(records, "c0003", replyRow)).toBeUndefined();
    expect(commentPlaceRow(records, "c9999", replyRow)).toBeUndefined();
    expect(commentPlaceRow(records, "c0021", () => undefined)).toBeUndefined();
  });
});

// 何を保証するか (DR-0062 §13): 💬 のフィルタで選んだものが開くスレッドは、選んだコメント
// 1 件ならそのスレッド、項目の 💬 (その項目の全部のコメント) ならそれらのスレッド。
// 返信を選んでもそのスレッドの始まりが開く。選んでいなければ無し。
describe("openThreadRoots", () => {
  const records = byCid([
    user({ cid: "c0001", status: "delivered" }),
    user({ cid: "c0002", status: "delivered" }),
    agent("c0011", "c0001"),
    user({ cid: "c0021", status: "sent", anchor: { kind: "comment", cid: "c0011" } }),
  ]);
  test("one comment, a reply in a thread, an item's comments, none", () => {
    expect([...openThreadRoots(records, commentSelectionKey("c0002"))]).toEqual(["c0002"]);
    expect([...openThreadRoots(records, commentSelectionKey("c0021"))]).toEqual(["c0001"]);
    expect([...openThreadRoots(records, "u:row-1")].sort()).toEqual(["c0001", "c0002"]);
    expect([...openThreadRoots(records, null)]).toEqual([]);
  });
});

// 何を保証するか (DR-0062 §13、kawaz 2026-11-24): 💬 のフィルタで人のコメントを押すと、
// 閉じたスレッドならそのコメントを選んで開き、開いたスレッドの先頭のコメントなら閉じる
// (どれも選ばない)。2 つ目以降のコメントは閉じずに選択がそのコメントへ移る。項目の 💬 で
// 開いた時も先頭を押せば閉じる。
describe("threadPressKey", () => {
  const records = byCid([
    user({ cid: "c0001", status: "delivered" }),
    user({ cid: "c0002", status: "delivered" }),
    agent("c0011", "c0001"),
    user({ cid: "c0021", status: "sent", anchor: { kind: "comment", cid: "c0011" } }),
  ]);
  test("a closed thread's comment opens it; its first comment open closes it", () => {
    expect(threadPressKey(records, null, "c0001")).toBe(commentSelectionKey("c0001"));
    expect(threadPressKey(records, commentSelectionKey("c0002"), "c0001")).toBe(
      commentSelectionKey("c0001"),
    );
    expect(threadPressKey(records, commentSelectionKey("c0001"), "c0001")).toBeNull();
    expect(threadPressKey(records, commentSelectionKey("c0021"), "c0001")).toBeNull();
    expect(threadOpenOf(records, commentSelectionKey("c0021"), "c0011")).toBe(true);
  });
  test("a later comment of the thread open does not close it: the selection moves to it", () => {
    expect(threadPressKey(records, commentSelectionKey("c0001"), "c0021")).toBe(
      commentSelectionKey("c0021"),
    );
  });
  test("opened by an item's 💬: its first comment closes it", () => {
    expect(threadPressKey(records, "u:row-1", "c0001")).toBeNull();
  });
});
