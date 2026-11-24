// The comment store (DR-0062 §6〜§11): how comments are kept, changed, sent
// to the session as one prompt, seen delivered in its transcript, and
// resolved; what the tabs that look at the session are sent; what is
// refused. The session is fakes: the prompt the store puts in is recorded,
// and the transcript's prompts are what the test says they are.
// 何を保証するか:
//   - 送るのは未送信 (draft) のコメントだけ。送る前に sending になり、まとめて送った
//     コメントはブロックの行を改行で並べた (JSONL) 1 つのプロンプトで入る。他の状態・見ていた版の
//     違い・知らない cid は送らずに項目ごとに断る
//   - 入った (accepted) コメントは sent、届いたか分からないものは unconfirmed、入らな
//     かったものは理由付きで draft に戻る。transcript の人の発言にブロックが見えたら
//     delivered になり、その行の uuid を持つ
//   - 同じセッションの送信は 1 本の列で、前の送信の答えが出るまで次を入れない
//   - 送った後に始まった turn が終わっても transcript に見えないものは unconfirmed に
//     なる。turn の途中で送ったものはその turn の終わりでは落とさない
//   - 直す・消すは未送信のものだけで、見ていた版が違えば conflict
//   - 未送信・削除済みへの返信は not_found。解決にできないスレッド (始まりが未送信、
//     未送信を含む、見ていた後に記録が足された) は断る。解決済みのスレッドに返信が
//     足されると解決が外れる
//   - 記録はファイルから読み戻せ、送っている途中で止まったものは unconfirmed として
//     読まれる。タブには購読の始まりに全部 (削除済みを除く) が、以後は変わるたびに 1 件
//     ずつ届く
//   - エージェントの返信 (comment_reply、§5) は本体に送った人のコメントとエージェント
//     自身の返信にだけ付き、新しい cid の記録 (本文は持たず、本文の冒頭 (30 文字) と
//     tool_use の id を持つ) になって、返信先の冒頭を返す。未送信・削除済み・btw の
//     コメント・btw の答え・知らない cid は not_found で何も残さない。同じ tool_use の
//     id の 2 回目は新しく作らず前の cid を返す。解決済みのスレッドに返信が足される
//     と解決が外れる。行が書けなければ state_not_writable で何も変えない
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  commentBlockText,
  CommentStreamEventSchema,
  CommentsStreamEventSchema,
  jsonText,
  parseWith,
  type CommentAnchor,
  type UserComment,
} from "@ccmsg/protocol";
import {
  CommentStore,
  commentsFile,
  promptTextOfLine,
  readCommentsFile,
  type BtwStart,
  type LandedPrompt,
  type PromptOutcome,
} from "../src/comments.ts";
import {
  attachmentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";

/** The stores and directories a test made. A store's last lines are written
 * after the op that changed them answers, so a directory is removed only once
 * its store has settled (perTestTmpDir would remove it while lines still
 * go in). */
const stores: CommentStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.settled();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const ON_RESPONSE: CommentAnchor = { kind: "message", uuid: "u-1", msg_start_with: "この関数は" };

/** A promise the test settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A store over fakes: a clock the test moves, counted cids, the prompts put
 * in, and the transcript's prompts. */
function fixture(dir: string, options: { outcome?: () => Promise<PromptOutcome> } = {}) {
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
  let counter = 0;
  const sent: string[] = [];
  /** Settled when the store puts its first prompt in. */
  const firstSend = deferred<void>();
  const landed: { uuid: string; text: string; at: number }[] = [];
  const lastRow: { uuid: string | undefined } = { uuid: "u-1" };
  /** What the next look at the transcript's last row waits for. */
  let held: Promise<void> | undefined;
  const store = new CommentStore({
    stateDir: dir,
    now: () => new Date(clock),
    newCid: () => `c${String(counter++).padStart(4, "0")}`,
    newDraftId: () => crypto.randomUUID(),
    uploadDir: path.join(dir, "upload"),
    log: { info() {}, warn() {} },
    lastRowUuid: async () => {
      const wait = held;
      held = undefined;
      if (wait !== undefined) await wait;
      return lastRow.uuid;
    },
    sendPrompt: async (_sid, text) => {
      sent.push(text);
      firstSend.resolve();
      return options.outcome ? options.outcome() : { outcome: "accepted" };
    },
    landedPrompts: async (_sid, since) =>
      landed
        .filter((p) => p.at >= since)
        .map(
          ({ uuid, text, at }): LandedPrompt => ({ uuid, text, at: new Date(at).toISOString() }),
        ),
    startBtw: async (): Promise<BtwStart> => ({
      ok: false,
      reason: "btw_launch_unavailable",
      msg: "no btw is asked in this test",
    }),
  });
  stores.push(store);
  return {
    store,
    sent,
    firstSend: firstSend.promise,
    lastRow,
    holdLastRow: (until: Promise<void>) => {
      held = until;
    },
    tick: (ms = 1000) => {
      clock += ms;
    },
    now: () => new Date(clock).toISOString(),
    /** The transcript gets a person's prompt of `text` now. */
    land: (uuid: string, text: string) => landed.push({ uuid, text, at: clock }),
  };
}

async function added(
  store: CommentStore,
  body: string,
  anchor: CommentAnchor = ON_RESPONSE,
): Promise<UserComment> {
  const result = await store.add(SID, {
    anchor,
    body,
    btw: false,
    sendNow: false,
  });
  if (!result.ok) throw new Error(result.msg);
  return result.value.comment;
}

async function statusOf(store: CommentStore, cid: string): Promise<string | undefined> {
  const record = (await store.list(SID)).find((r) => r.cid === cid);
  return record?.author === "user" ? record.status : undefined;
}

describe("adding and changing", () => {
  test("a comment is kept unsent, with where the conversation stood", async () => {
    const f = fixture(tmp("comments-"));
    const comment = await added(f.store, "ここは?");
    expect(comment).toMatchObject({
      author: "user",
      session_id: SID,
      anchor: ON_RESPONSE,
      body: "ここは?",
      status: "draft",
      btw: false,
      written: { at: f.now(), after_uuid: "u-1" },
    });
    expect(comment.cid).toMatch(/^c[a-z0-9]{4}$/);
    expect(f.sent).toEqual([]);
  });

  test("only an unsent comment changes or is taken back, and only at the version seen", async () => {
    const f = fixture(tmp("comments-"));
    const comment = await added(f.store, "ここは?");
    f.tick();
    const stale = await f.store.update(SID, {
      cid: comment.cid,
      seenUpdatedAt: "2000-01-01T00:00:00.000Z",
      body: "x",
    });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    const changed = await f.store.update(SID, {
      cid: comment.cid,
      seenUpdatedAt: comment.updated_at,
      body: "直した",
    });
    if (!changed.ok) throw new Error(changed.msg);
    expect(changed.value.body).toBe("直した");
    await f.store.send(SID, [
      { kind: "comment", cid: comment.cid, seen_updated_at: changed.value.updated_at },
    ]);
    const current = (await f.store.list(SID)).find((r) => r.cid === comment.cid);
    const afterSend = await f.store.delete(SID, {
      cid: comment.cid,
      seenUpdatedAt: current?.updated_at ?? "",
    });
    expect(afterSend).toMatchObject({ ok: false, code: "invalid_args" });
  });

  test("a deleted comment is not sent to a tab that begins to look", async () => {
    const f = fixture(tmp("comments-"));
    const kept = await added(f.store, "残す");
    const gone = await added(f.store, "消す");
    expect(await f.store.delete(SID, { cid: gone.cid, seenUpdatedAt: gone.updated_at })).toEqual({
      ok: true,
      value: null,
    });
    const lines: string[] = [];
    await f.store.watch(SID, { write: (line) => lines.push(line) });
    const read = parseWith(jsonText(CommentsStreamEventSchema), lines[0] ?? "");
    if (!read.ok) throw new Error(read.failure.summary);
    expect(read.value.comments.map((c) => c.cid)).toEqual([kept.cid]);
  });

  test("a reply to an unsent or deleted comment is refused", async () => {
    const f = fixture(tmp("comments-"));
    const draft = await added(f.store, "未送信");
    const reply = await f.store.add(SID, {
      anchor: { kind: "comment", cid: draft.cid },
      body: "返信",
      btw: false,
      sendNow: false,
    });
    expect(reply).toMatchObject({ ok: false, code: "not_found" });
    const unknown = await f.store.add(SID, {
      anchor: { kind: "comment", cid: "czzzz" },
      body: "返信",
      btw: false,
      sendNow: false,
    });
    expect(unknown).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("sending", () => {
  test("comments sent together go in as one prompt of their blocks, and are sent", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "一つ目");
    const b = await added(f.store, "二つ目");
    f.lastRow.uuid = "u-2";
    const results = await f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: a.updated_at },
      { kind: "comment", cid: b.cid, seen_updated_at: b.updated_at },
    ]);
    expect(results).toEqual({
      ok: true,
      value: [
        { kind: "comment", id: a.cid, outcome: "sent" },
        { kind: "comment", id: b.cid, outcome: "sent" },
      ],
    });
    expect(f.sent).toEqual([
      [
        commentBlockText({
          comment: a.cid,
          on: { kind: "msg_start_with", value: "この関数は" },
          body: "一つ目",
        }),
        commentBlockText({
          comment: b.cid,
          on: { kind: "msg_start_with", value: "この関数は" },
          body: "二つ目",
        }),
      ].join("\n"),
    ]);
    const records = await f.store.list(SID);
    for (const record of records) {
      expect(record).toMatchObject({ status: "sent", sent: { after_uuid: "u-2" } });
    }
  });

  test("what is not an unsent comment at the version seen is refused, item by item", async () => {
    const f = fixture(tmp("comments-"));
    const sentOne = await added(f.store, "送った");
    await f.store.send(SID, [
      { kind: "comment", cid: sentOne.cid, seen_updated_at: sentOne.updated_at },
    ]);
    const draft = await added(f.store, "未送信");
    f.sent.length = 0;
    const results = await f.store.send(SID, [
      { kind: "comment", cid: sentOne.cid, seen_updated_at: sentOne.updated_at },
      { kind: "comment", cid: draft.cid, seen_updated_at: "2000-01-01T00:00:00.000Z" },
      { kind: "comment", cid: "czzzz", seen_updated_at: "x" },
    ]);
    expect(results).toEqual({
      ok: true,
      value: [
        {
          kind: "comment",
          id: sentOne.cid,
          outcome: "refused",
          reason: "not_sendable",
          status: "sent",
        },
        { kind: "comment", id: draft.cid, outcome: "refused", reason: "conflict" },
        { kind: "comment", id: "czzzz", outcome: "refused", reason: "not_found" },
      ],
    });
    expect(f.sent).toEqual([]);
  });

  test("a comment not put in is a draft again with why; one not known is unconfirmed", async () => {
    const outcomes: PromptOutcome[] = [
      { outcome: "not_delivered", reason: "dialog" },
      { outcome: "unconfirmed" },
    ];
    const f = fixture(tmp("comments-"), {
      outcome: async () => outcomes.shift() ?? { outcome: "accepted" },
    });
    const a = await added(f.store, "a");
    const sentFirst = await f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: a.updated_at },
    ]);
    const first = sentFirst.ok ? sentFirst.value[0] : undefined;
    expect(first).toEqual({
      kind: "comment",
      id: a.cid,
      outcome: "not_delivered",
      reason: "dialog",
    });
    const back = (await f.store.list(SID)).find((r) => r.cid === a.cid);
    expect(back).toMatchObject({ status: "draft", send_error: "dialog" });
    expect(back).not.toHaveProperty("sent");
    const again = await f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: back?.updated_at ?? "" },
    ]);
    expect(again).toEqual({
      ok: true,
      value: [{ kind: "comment", id: a.cid, outcome: "unconfirmed" }],
    });
    expect(await statusOf(f.store, a.cid)).toBe("unconfirmed");
  });

  test("a session's sends go one at a time: the next waits for the answer before it", async () => {
    // What happened, in order: each prompt put in, and each answer given.
    const events: string[] = [];
    let calls = 0;
    const first = deferred<void>();
    const f = fixture(tmp("comments-"), {
      outcome: async () => {
        const n = calls;
        calls += 1;
        events.push(`put ${String(n)}`);
        // The first answer comes only once the test lets it.
        if (n === 0) await first.promise;
        events.push(`answered ${String(n)}`);
        return { outcome: "accepted" };
      },
    });
    const a = await added(f.store, "a");
    const b = await added(f.store, "b");
    const sendA = f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: a.updated_at },
    ]);
    const sendB = f.store.send(SID, [
      { kind: "comment", cid: b.cid, seen_updated_at: b.updated_at },
    ]);
    await f.firstSend;
    first.resolve();
    expect(await sendA).toEqual({
      ok: true,
      value: [{ kind: "comment", id: a.cid, outcome: "sent" }],
    });
    expect(await sendB).toEqual({
      ok: true,
      value: [{ kind: "comment", id: b.cid, outcome: "sent" }],
    });
    expect(events).toEqual(["put 0", "answered 0", "put 1", "answered 1"]);
  });

  test("send_now keeps the comment and sends it at once", async () => {
    const f = fixture(tmp("comments-"));
    const result = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "今",
      btw: false,
      sendNow: true,
    });
    if (!result.ok) throw new Error(result.msg);
    expect(result.value.outcome).toEqual({
      kind: "comment",
      id: result.value.comment.cid,
      outcome: "sent",
    });
    expect(result.value.comment.status).toBe("sent");
    expect(f.sent.length).toBe(1);
  });
});

describe("seen delivered", () => {
  test("a sent comment whose block a prompt of the transcript holds is delivered, with its row", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    f.land("row-9", f.sent[0] ?? "");
    f.store.rowsPushed(SID);
    await f.store.settled();
    const record = (await f.store.list(SID)).find((r) => r.cid === a.cid);
    expect(record).toMatchObject({ status: "delivered", row_uuid: "row-9" });
  });

  // DR-0062 §11: the block sent, not the cid alone, and in a prompt of
  // nothing but blocks. A row that names a waiting cid with another body or
  // on (a person pasting one, say), or holds the block among other text, is
  // not that comment.
  test("a row with the sent cid but another body or on, or with other text, does not make it delivered", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    const others: string[] = [
      commentBlockText({
        comment: a.cid,
        on: { kind: "msg_start_with", value: "この関数は" },
        body: "別の本文",
      }),
      commentBlockText({ comment: a.cid, on: { kind: "comment", value: "c0000" }, body: "a" }),
      commentBlockText({ comment: a.cid, body: "a" }),
    ];
    // The block sent, but among a person's own text: not a prompt of
    // comments (the Timeline does not draw it as one either, §12).
    others.push(`ついでに\n${f.sent[0] ?? ""}`);
    for (const [i, text] of others.entries()) f.land(`row-x${String(i)}`, text);
    f.store.rowsPushed(SID);
    await f.store.settled();
    expect(await statusOf(f.store, a.cid)).toBe("sent");
    f.land("row-9", f.sent[0] ?? "");
    f.store.rowsPushed(SID);
    await f.store.settled();
    expect((await f.store.list(SID)).find((r) => r.cid === a.cid)).toMatchObject({
      status: "delivered",
      row_uuid: "row-9",
    });
  });

  test("a turn that began after the send and ended without its block makes it unconfirmed", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    const turnBegan = f.now();
    f.tick();
    await f.store.turnEnded(SID, Date.parse(turnBegan));
    expect(await statusOf(f.store, a.cid)).toBe("unconfirmed");
  });

  test("a turn that began before the send does not make it unconfirmed when it ends", async () => {
    const f = fixture(tmp("comments-"));
    const turnBegan = f.now();
    f.tick();
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    await f.store.turnEnded(SID, Date.parse(turnBegan));
    expect(await statusOf(f.store, a.cid)).toBe("sent");
  });

  test("the transcript is looked at before a turn's end makes anything unconfirmed", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    const turnBegan = f.now();
    f.land("row-3", `  ${f.sent[0] ?? ""}\n`);
    await f.store.turnEnded(SID, Date.parse(turnBegan));
    expect(await statusOf(f.store, a.cid)).toBe("delivered");
  });

  test("an unconfirmed comment is made a draft again or taken as sent by the person", async () => {
    const f = fixture(tmp("comments-"), { outcome: async () => ({ outcome: "unconfirmed" }) });
    const a = await added(f.store, "a");
    const b = await added(f.store, "b");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    await f.store.send(SID, [{ kind: "comment", cid: b.cid, seen_updated_at: b.updated_at }]);
    const versions = new Map((await f.store.list(SID)).map((r) => [r.cid, r.updated_at]));
    const back = await f.store.settle(SID, {
      cid: a.cid,
      action: "back_to_draft",
      seenUpdatedAt: versions.get(a.cid) ?? "",
    });
    expect(back).toMatchObject({ ok: true, value: { status: "draft" } });
    if (back.ok) expect(back.value).not.toHaveProperty("sent");
    const marked = await f.store.settle(SID, {
      cid: b.cid,
      action: "mark_sent",
      seenUpdatedAt: versions.get(b.cid) ?? "",
    });
    expect(marked).toMatchObject({ ok: true, value: { status: "sent" } });
    const notUnconfirmed = await f.store.settle(SID, {
      cid: a.cid,
      action: "mark_sent",
      seenUpdatedAt: back.ok ? back.value.updated_at : "",
    });
    expect(notUnconfirmed).toMatchObject({ ok: false, code: "invalid_args" });
  });

  test("one taken as sent by the person after its turn ended stays sent when later turns end", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    // The first turn after the send ends without its block: unconfirmed.
    f.tick();
    const firstBegan = f.now();
    f.tick();
    await f.store.turnEnded(SID, Date.parse(firstBegan));
    const unconfirmed = (await f.store.list(SID)).find((r) => r.cid === a.cid);
    expect(unconfirmed).toMatchObject({ status: "unconfirmed" });
    f.tick();
    const marked = await f.store.settle(SID, {
      cid: a.cid,
      action: "mark_sent",
      seenUpdatedAt: unconfirmed?.updated_at ?? "",
    });
    expect(marked).toMatchObject({ ok: true, value: { status: "sent" } });
    for (let turn = 0; turn < 3; turn += 1) {
      f.tick();
      const began = f.now();
      f.tick();
      await f.store.turnEnded(SID, Date.parse(began));
      expect({ turn, status: await statusOf(f.store, a.cid) }).toEqual({ turn, status: "sent" });
    }
  });

  test("one sent during a turn is unconfirmed at the end of the turn after it, and only then", async () => {
    const f = fixture(tmp("comments-"));
    const duringBegan = f.now();
    f.tick();
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    f.tick();
    await f.store.turnEnded(SID, Date.parse(duringBegan));
    expect(await statusOf(f.store, a.cid)).toBe("sent");
    f.tick();
    const nextBegan = f.now();
    f.tick();
    await f.store.turnEnded(SID, Date.parse(nextBegan));
    expect(await statusOf(f.store, a.cid)).toBe("unconfirmed");
  });

  test("one left unconfirmed before its turn in line came is still looked for in the transcript", async () => {
    const dir = tmp("comments-");
    const gate = deferred<PromptOutcome>();
    const f = fixture(dir, { outcome: () => gate.promise });
    const a = await added(f.store, "a");
    const b = await added(f.store, "b");
    void f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    void f.store.send(SID, [{ kind: "comment", cid: b.cid, seen_updated_at: b.updated_at }]);
    await f.firstSend;
    await f.store.written();
    // The daemon stops while b waits in line behind a: b was never put in.
    const g = fixture(dir);
    const read = (await g.store.list(SID)).find((r) => r.cid === b.cid);
    expect(read).toMatchObject({ status: "unconfirmed" });
    expect(read).not.toHaveProperty("sent");
    // a, which was sent, is made a draft again: b is the only one looked for.
    const readA = (await g.store.list(SID)).find((r) => r.cid === a.cid);
    const back = await g.store.settle(SID, {
      cid: a.cid,
      action: "back_to_draft",
      seenUpdatedAt: readA?.updated_at ?? "",
    });
    expect(back).toMatchObject({ ok: true });
    // Its block lands after all (another tab sent it again by hand, say).
    g.tick(5000);
    g.land(
      "row-b",
      commentBlockText({
        comment: b.cid,
        on: { kind: "msg_start_with", value: "この関数は" },
        body: "b",
      }),
    );
    g.store.rowsPushed(SID);
    await g.store.settled();
    expect(await statusOf(g.store, b.cid)).toBe("delivered");
    gate.resolve({ outcome: "accepted" });
  });
});

describe("threads", () => {
  /** A store with one comment sent: the first of a thread. */
  async function sentThread(dir: string) {
    const f = fixture(dir);
    const root = await added(f.store, "始まり");
    await f.store.send(SID, [{ kind: "comment", cid: root.cid, seen_updated_at: root.updated_at }]);
    return { f, root };
  }

  test("a thread is resolved at the last record the person saw, and refused past it", async () => {
    const { f, root } = await sentThread(tmp("comments-"));
    const resolved = await f.store.resolve(SID, {
      cid: root.cid,
      resolved: true,
      seenCid: root.cid,
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: { kind: "thread", root: root.cid, seen_cid: root.cid },
    });
    if (resolved.ok) expect(resolved.value.resolved_at).toBeDefined();
    const unresolved = await f.store.resolve(SID, {
      cid: root.cid,
      resolved: false,
      seenCid: root.cid,
    });
    expect(unresolved.ok).toBe(true);
    if (unresolved.ok) expect(unresolved.value.resolved_at).toBeUndefined();
    const reply = await added(f.store, "返信", { kind: "comment", cid: root.cid });
    await f.store.send(SID, [
      { kind: "comment", cid: reply.cid, seen_updated_at: reply.updated_at },
    ]);
    const stale = await f.store.resolve(SID, { cid: root.cid, resolved: true, seenCid: root.cid });
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
  });

  test("a thread with an unsent comment, or whose first comment is unsent, is not resolved", async () => {
    const { f, root } = await sentThread(tmp("comments-"));
    const draftReply = await added(f.store, "未送信の返信", { kind: "comment", cid: root.cid });
    expect(
      await f.store.resolve(SID, { cid: root.cid, resolved: true, seenCid: draftReply.cid }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
    const draftRoot = await added(f.store, "未送信の始まり");
    expect(
      await f.store.resolve(SID, { cid: draftRoot.cid, resolved: true, seenCid: draftRoot.cid }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });

  test("a reply added to a resolved thread takes the mark off", async () => {
    const { f, root } = await sentThread(tmp("comments-"));
    await f.store.resolve(SID, { cid: root.cid, resolved: true, seenCid: root.cid });
    await added(f.store, "やっぱり", { kind: "comment", cid: root.cid });
    const [thread] = await f.store.threads(SID);
    expect(thread?.resolved_at).toBeUndefined();
  });

  // 何を保証するか (DR-0062 §6、kawaz 2026-11-24): どの吹き出しの解決のボタンから押しても、
  // 印はスレッドの最初の人のコメントの cid (root) に付く。返信の返信が続くスレッドでも。
  test("pressed on a reply of a reply, the mark goes on the thread's first comment", async () => {
    const { f, root } = await sentThread(tmp("comments-"));
    const agentReply = await f.store.reply(SID, { cid: root.cid, body: "答え", toolUseId: "t1" });
    if (!agentReply.ok) throw new Error(agentReply.msg);
    const reply = await added(f.store, "返信の返信", {
      kind: "comment",
      cid: agentReply.value.cid,
    });
    await f.store.send(SID, [
      { kind: "comment", cid: reply.cid, seen_updated_at: reply.updated_at },
    ]);
    const resolved = await f.store.resolve(SID, {
      cid: reply.cid,
      resolved: true,
      seenCid: reply.cid,
    });
    expect(resolved).toMatchObject({ ok: true, value: { root: root.cid } });
    expect((await f.store.threads(SID)).map((t) => t.root)).toEqual([root.cid]);
  });

  test("pressed on a btw's answer, the mark goes on the btw's question", async () => {
    const dir = tmp("comments-");
    const file = commentsFile(dir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = { at: "2026-11-22T00:00:00.000Z" };
    const lines = [
      {
        kind: "comment",
        author: "user",
        cid: "cbtwq",
        session_id: SID,
        anchor: { kind: "timing" },
        body: "q",
        written: at,
        sent: at,
        updated_at: at.at,
        btw: true,
        status: "sent",
      },
      {
        kind: "comment",
        author: "btw",
        cid: "cbtwa",
        session_id: SID,
        anchor: { kind: "comment", cid: "cbtwq" },
        body: "答え",
        written: at,
        updated_at: at.at,
        status: "done",
      },
    ];
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const f = fixture(dir);
    const resolved = await f.store.resolve(SID, { cid: "cbtwa", resolved: true, seenCid: "cbtwa" });
    expect(resolved).toMatchObject({ ok: true, value: { root: "cbtwq" } });
  });
});

describe("the file and the tabs", () => {
  test("the records read back from the file, and one left being sent reads as unconfirmed", async () => {
    const dir = tmp("comments-");
    const gate = deferred<PromptOutcome>();
    const f = fixture(dir, { outcome: () => gate.promise });
    const a = await added(f.store, "a");
    void f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    await f.firstSend;
    await f.store.written();
    // Another daemon reads the file while the first still waits on its answer.
    const g = fixture(dir);
    expect(await statusOf(g.store, a.cid)).toBe("unconfirmed");
    await g.store.written();
    const onDisk = await readCommentsFile(commentsFile(dir, SID), () => {});
    expect(onDisk.records.get(a.cid)).toMatchObject({ status: "unconfirmed" });
    gate.resolve({ outcome: "accepted" });
  });

  test("a tab gets every change as one comment", async () => {
    const f = fixture(tmp("comments-"));
    const lines: string[] = [];
    await f.store.watch(SID, { write: (line) => lines.push(line) });
    const a = await added(f.store, "a");
    const events = lines
      .slice(1)
      .map((line) => parseWith(jsonText(CommentStreamEventSchema), line))
      .flatMap((read) => (read.ok ? [read.value.comment] : []));
    expect(events.map((c) => c.cid)).toEqual([a.cid]);
    f.store.unwatchAll({ write: () => {} });
  });

  test("a line of the file that does not read is passed over", async () => {
    const dir = tmp("comments-");
    const file = commentsFile(dir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json\n");
    const warned: string[] = [];
    const read = await readCommentsFile(file, (msg) => warned.push(msg));
    expect(read.records.size).toBe(0);
    expect(warned.length).toBe(1);
  });
});

describe("the records' line and the sends' line (DR-0062 §7, §9, §11)", () => {
  test("an op that reads, waits and writes is not cut into by another op on the session", async () => {
    const f = fixture(tmp("comments-"));
    const parent = await added(f.store, "親");
    await f.store.send(SID, [
      { kind: "comment", cid: parent.cid, seen_updated_at: parent.updated_at },
    ]);
    f.tick();
    const turnBegan = f.now();
    f.tick();
    await f.store.turnEnded(SID, Date.parse(turnBegan));
    const unconfirmed = (await f.store.list(SID)).find((r) => r.cid === parent.cid);
    // The reply's add waits on the transcript (where the conversation stands)
    // between its look at the parent and its write.
    const hold = deferred<void>();
    f.holdLastRow(hold.promise);
    const order: string[] = [];
    const reply = f.store
      .add(SID, {
        anchor: { kind: "comment", cid: parent.cid },
        body: "返信",
        btw: false,
        sendNow: false,
      })
      .then((r) => {
        order.push("reply");
        return r;
      });
    const back = f.store
      .settle(SID, {
        cid: parent.cid,
        action: "back_to_draft",
        seenUpdatedAt: unconfirmed?.updated_at ?? "",
      })
      .then((r) => {
        order.push("back");
        return r;
      });
    hold.resolve();
    expect(await reply).toMatchObject({ ok: true });
    expect(await back).toMatchObject({ ok: true });
    expect(order).toEqual(["reply", "back"]);
  });

  test("a reply whose parent went back to a draft is not sent, and nothing goes in", async () => {
    const f = fixture(tmp("comments-"), { outcome: async () => ({ outcome: "unconfirmed" }) });
    const parent = await added(f.store, "親");
    await f.store.send(SID, [
      { kind: "comment", cid: parent.cid, seen_updated_at: parent.updated_at },
    ]);
    const reply = await added(f.store, "返信", { kind: "comment", cid: parent.cid });
    const unconfirmed = (await f.store.list(SID)).find((r) => r.cid === parent.cid);
    await f.store.settle(SID, {
      cid: parent.cid,
      action: "back_to_draft",
      seenUpdatedAt: unconfirmed?.updated_at ?? "",
    });
    f.sent.length = 0;
    const sent = await f.store.send(SID, [
      { kind: "comment", cid: reply.cid, seen_updated_at: reply.updated_at },
    ]);
    expect(sent).toEqual({
      ok: true,
      value: [{ kind: "comment", id: reply.cid, outcome: "refused", reason: "not_found" }],
    });
    expect(f.sent).toEqual([]);
    expect(await statusOf(f.store, reply.cid)).toBe("draft");
  });

  test("a reply whose parent went back to a draft while it waited in line is not sent", async () => {
    const gate = deferred<void>();
    let calls = 0;
    const f = fixture(tmp("comments-"), {
      outcome: async () => {
        calls += 1;
        // The parent goes in unconfirmed; the next send holds the line.
        if (calls === 1) return { outcome: "unconfirmed" };
        if (calls === 2) await gate.promise;
        return { outcome: "accepted" };
      },
    });
    const parent = await added(f.store, "親");
    await f.store.send(SID, [
      { kind: "comment", cid: parent.cid, seen_updated_at: parent.updated_at },
    ]);
    const other = await added(f.store, "別");
    const reply = await added(f.store, "返信", { kind: "comment", cid: parent.cid });
    const holding = f.store.send(SID, [
      { kind: "comment", cid: other.cid, seen_updated_at: other.updated_at },
    ]);
    const waiting = f.store.send(SID, [
      { kind: "comment", cid: reply.cid, seen_updated_at: reply.updated_at },
    ]);
    // While the reply waits in line, the parent is made a draft again.
    const unconfirmed = (await f.store.list(SID)).find((r) => r.cid === parent.cid);
    expect(
      await f.store.settle(SID, {
        cid: parent.cid,
        action: "back_to_draft",
        seenUpdatedAt: unconfirmed?.updated_at ?? "",
      }),
    ).toMatchObject({ ok: true });
    gate.resolve();
    await holding;
    expect(await waiting).toEqual({
      ok: true,
      value: [{ kind: "comment", id: reply.cid, outcome: "refused", reason: "not_found" }],
    });
    expect(f.sent.length).toBe(2);
    expect(f.sent.some((text) => text.includes(reply.cid))).toBe(false);
    const back = (await f.store.list(SID)).find((r) => r.cid === reply.cid);
    expect(back).toMatchObject({ status: "draft" });
    expect(back).not.toHaveProperty("sent");
  });

  test("changing or deleting a comment another tab sent first is a conflict", async () => {
    const f = fixture(tmp("comments-"));
    const a = await added(f.store, "a");
    f.tick();
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    // The person saw the draft version.
    expect(
      await f.store.update(SID, { cid: a.cid, seenUpdatedAt: a.updated_at, body: "x" }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(await f.store.delete(SID, { cid: a.cid, seenUpdatedAt: a.updated_at })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  test("a prompt of the FAB's waits in the sends' line behind a comment's answer", async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    const f = fixture(tmp("comments-"), {
      outcome: async () => {
        order.push("comment put");
        await gate.promise;
        order.push("comment answered");
        return { outcome: "accepted" };
      },
    });
    const a = await added(f.store, "a");
    const sending = f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: a.updated_at },
    ]);
    await f.firstSend;
    const direct = f.store.inSendLine(SID, async () => {
      order.push("fab put");
    });
    gate.resolve();
    await sending;
    await direct;
    expect(order).toEqual(["comment put", "comment answered", "fab put"]);
  });

  test("a change, a delete and a resolve answer while a send waits for its answer", async () => {
    const gate = deferred<PromptOutcome>();
    const f = fixture(tmp("comments-"), { outcome: () => gate.promise });
    const a = await added(f.store, "a");
    const b = await added(f.store, "b");
    const sending = f.store.send(SID, [
      { kind: "comment", cid: a.cid, seen_updated_at: a.updated_at },
    ]);
    await f.firstSend;
    expect(
      await f.store.update(SID, { cid: b.cid, seenUpdatedAt: b.updated_at, body: "直した" }),
    ).toMatchObject({ ok: true });
    gate.resolve({ outcome: "accepted" });
    await sending;
  });
});

describe("what is kept on disk (DR-0062 §8)", () => {
  test("an op whose line cannot be written answers so, and keeps and tells nothing", async () => {
    const dir = tmp("comments-");
    // The sessions directory cannot be made: a file is in its place.
    fs.writeFileSync(path.join(dir, "sessions"), "");
    const f = fixture(dir);
    const lines: string[] = [];
    await f.store.watch(SID, { write: (line) => lines.push(line) });
    const result = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "x",
      btw: false,
      sendNow: false,
    });
    expect(result).toMatchObject({ ok: false, code: "state_not_writable" });
    expect(await f.store.list(SID)).toEqual([]);
    expect(lines.length).toBe(1);
  });

  test("a comment sent and not seen is looked for in the transcript as its file is read", async () => {
    const dir = tmp("comments-");
    const f = fixture(dir);
    const a = await added(f.store, "a");
    await f.store.send(SID, [{ kind: "comment", cid: a.cid, seen_updated_at: a.updated_at }]);
    await f.store.settled();
    // The next daemon: the block landed while none was there to see it.
    const g = fixture(dir);
    g.tick();
    g.land("row-7", f.sent[0] ?? "");
    await g.store.watch(SID, { write() {} });
    await g.store.settled();
    const record = (await g.store.list(SID)).find((r) => r.cid === a.cid);
    expect(record).toMatchObject({ status: "delivered", row_uuid: "row-7" });
  });
});

describe("promptTextOfLine: the person's prompt a transcript line holds", () => {
  test("a user row's text, string or blocks, and a queued command's prompt", () => {
    expect(promptTextOfLine(jsonl(userContentRow("やあ")))).toBe("やあ");
    expect(promptTextOfLine(jsonl(userContentRow([textBlock("a"), textBlock("b")])))).toBe("a\nb");
    expect(
      promptTextOfLine(
        jsonl(
          attachmentRow({
            type: "queued_command",
            prompt: "待ちの文",
            commandMode: "prompt",
            origin: { kind: "human" },
          }),
        ),
      ),
    ).toBe("待ちの文");
  });

  test("any other line is none", () => {
    expect(promptTextOfLine(JSON.stringify({ type: "assistant", uuid: "u" }))).toBeNull();
    expect(promptTextOfLine("not json")).toBeNull();
  });

  test("a user row the Timeline does not draw as the person's prompt is none (DR-0062 §11)", () => {
    const block = commentBlockText({
      comment: "c0000",
      on: { kind: "msg_start_with", value: "q" },
      body: "b",
    });
    // A ccmsg message relayed in, a harness injection, a compaction's summary.
    const notThePerson = [
      userContentRow(block, { promptSource: "system", origin: { kind: "peer" } }),
      userContentRow(block, { isMeta: true }),
      userContentRow(block, { isCompactSummary: true }),
    ];
    for (const row of notThePerson) expect(promptTextOfLine(jsonl(row))).toBeNull();
    // Typed, and queued during a turn.
    expect(promptTextOfLine(jsonl(userContentRow(block, { promptSource: "typed" })))).toBe(block);
    expect(promptTextOfLine(jsonl(userContentRow(block, { promptSource: "queued" })))).toBe(block);
  });
});

describe("the agent's reply (comment_reply, DR-0062 §5)", () => {
  /** A store with one comment sent to the session. */
  async function sentComment(dir: string) {
    const f = fixture(dir);
    const comment = await added(f.store, "ここは undefined を返すのでは？");
    await f.store.send(SID, [
      { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
    ]);
    return { f, comment };
  }

  test("a reply to a comment sent is kept with a cid of its own, and says what it answers", async () => {
    const dir = tmp("comments-");
    const { f, comment } = await sentComment(dir);
    const lines: string[] = [];
    await f.store.watch(SID, { write: (line) => lines.push(line) });
    f.tick();
    const body = "そう、呼び出し側が null を返す時は\n  undefined になる";
    const replied = await f.store.reply(SID, { cid: comment.cid, body, toolUseId: "toolu_1" });
    if (!replied.ok) throw new Error(replied.msg);
    expect(replied.value.quote).toBe("ここは undefined を返すのでは？");
    expect(replied.value.cid).not.toBe(comment.cid);
    expect(replied.value.cid).toMatch(/^c[a-z0-9]{4}$/);
    const record = (await f.store.list(SID)).find((r) => r.cid === replied.value.cid);
    expect(record).toEqual({
      kind: "comment",
      author: "agent",
      cid: replied.value.cid,
      session_id: SID,
      anchor: { kind: "comment", cid: comment.cid },
      body_start: "そう、呼び出し側が null を返す時は undefined…",
      written: { at: f.now(), after_uuid: "u-1" },
      updated_at: f.now(),
      tool_use_id: "toolu_1",
    });
    // The body is the transcript's (the call's row), not the record's.
    expect(record !== undefined && "body" in record).toBe(false);
    const pushed = lines
      .slice(1)
      .map((line) => parseWith(jsonText(CommentStreamEventSchema), line))
      .flatMap((read) => (read.ok ? [read.value.comment.cid] : []));
    expect(pushed).toEqual([replied.value.cid]);
    const onDisk = await readCommentsFile(commentsFile(dir, SID), () => {});
    expect(onDisk.records.get(replied.value.cid)).toEqual(record);
    // Nothing is put into the session.
    expect(f.sent.length).toBe(1);
  });

  test("the same call asked twice is kept once", async () => {
    const { f, comment } = await sentComment(tmp("comments-"));
    const first = await f.store.reply(SID, { cid: comment.cid, body: "a", toolUseId: "toolu_1" });
    const again = await f.store.reply(SID, { cid: comment.cid, body: "a", toolUseId: "toolu_1" });
    expect(again).toEqual(first);
    const other = await f.store.reply(SID, { cid: comment.cid, body: "b", toolUseId: "toolu_2" });
    expect(other.ok && first.ok && other.value.cid !== first.value.cid).toBe(true);
    const agents = (await f.store.list(SID)).filter((r) => r.author === "agent");
    expect(agents.length).toBe(2);
  });

  test("a reply answers a reply of the agent's own, quoting it", async () => {
    const { f, comment } = await sentComment(tmp("comments-"));
    const first = await f.store.reply(SID, {
      cid: comment.cid,
      body: "最初の返信の本文",
      toolUseId: "toolu_1",
    });
    if (!first.ok) throw new Error(first.msg);
    const second = await f.store.reply(SID, {
      cid: first.value.cid,
      body: "補足",
      toolUseId: "toolu_2",
    });
    expect(second).toMatchObject({ ok: true, value: { quote: "最初の返信の本文" } });
  });

  test("a comment not given to the session's conversation is not answered, and nothing is kept", async () => {
    const dir = tmp("comments-");
    const file = commentsFile(dir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = { at: "2026-11-22T00:00:00.000Z" };
    const user = (cid: string, patch: Partial<UserComment>): UserComment => ({
      kind: "comment",
      author: "user",
      cid,
      session_id: SID,
      anchor: ON_RESPONSE,
      body: "b",
      written: at,
      updated_at: at.at,
      btw: false,
      status: "sent",
      ...patch,
    });
    const lines = [
      user("cdraf", { status: "draft" }),
      user("cdele", { status: "deleted" }),
      user("cbtwq", { btw: true }),
      {
        kind: "comment",
        author: "btw",
        cid: "cbtwa",
        session_id: SID,
        anchor: { kind: "comment", cid: "cbtwq" },
        body: "答え",
        written: at,
        updated_at: at.at,
        status: "done",
      },
    ];
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const f = fixture(dir);
    for (const cid of ["cdraf", "cdele", "cbtwq", "cbtwa", "cnone"]) {
      const refused = await f.store.reply(SID, { cid, body: "x", toolUseId: `toolu_${cid}` });
      expect(refused).toMatchObject({ ok: false, code: "not_found" });
    }
    expect((await f.store.list(SID)).filter((r) => r.author === "agent")).toEqual([]);
  });

  test("a comment the session may not have seen yet (sent, unconfirmed, delivered) is answered", async () => {
    const { f, comment } = await sentComment(tmp("comments-"));
    expect(await statusOf(f.store, comment.cid)).toBe("sent");
    expect((await f.store.reply(SID, { cid: comment.cid, body: "x", toolUseId: "t1" })).ok).toBe(
      true,
    );
    await f.store.turnEnded(SID, Date.parse(f.now()) + 1);
    expect(await statusOf(f.store, comment.cid)).toBe("unconfirmed");
    expect((await f.store.reply(SID, { cid: comment.cid, body: "y", toolUseId: "t2" })).ok).toBe(
      true,
    );
  });

  test("a reply added to a resolved thread takes the mark off", async () => {
    const { f, comment } = await sentComment(tmp("comments-"));
    await f.store.resolve(SID, { cid: comment.cid, resolved: true, seenCid: comment.cid });
    await f.store.reply(SID, { cid: comment.cid, body: "x", toolUseId: "toolu_1" });
    const [thread] = await f.store.threads(SID);
    expect(thread?.resolved_at).toBeUndefined();
  });

  test("a reply whose line is not written is refused, and nothing changes", async () => {
    const dir = tmp("comments-");
    const { f, comment } = await sentComment(dir);
    const before = await f.store.list(SID);
    const sessions = path.join(dir, "sessions");
    fs.rmSync(sessions, { recursive: true, force: true });
    fs.writeFileSync(sessions, "not a directory");
    const refused = await f.store.reply(SID, { cid: comment.cid, body: "x", toolUseId: "t" });
    expect(refused).toMatchObject({ ok: false, code: "state_not_writable" });
    expect(await f.store.list(SID)).toEqual(before);
  });
});
