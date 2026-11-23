// A comment's attachments (DR-0062 §7, §11, §15): the files a person attaches
// to a comment, kept and numbered as a FAB's draft's are. The session is
// fakes, as in prompt-queue.test.ts: the prompts the store puts in are
// recorded, and the transcript's prompts are what the test says they are.
// 何を保証するか:
//   - 添付つきの comment_add は、添付を state dir の下 (<sid>.att-<uuid><ext>) に移し、
//     セッションの続きの番号を振り、本文の [FILE<n>] を同じ対応で書き換える
//   - 番号は FAB の下書きと 1 本の列で続き、コメントと下書きの [FILE<n>] は重ならない
//     (daemon を起こし直して読み戻しても続きから振る)
//   - 直した時、記録に既にある添付 (パスで見分ける) の番号は変わらず、新しい添付だけが
//     続きの番号を取る。添付を省いた直しは今の添付を保つ
//   - アップロードの置き場のファイルでない添付は invalid_args で断り、何も保存しない
//   - 添付が無くなったコメントは送らず draft のまま残り (attachment_missing)、同じ送信の
//     他のコメントは送る
//   - 送るブロックの body は [FILE<n>] を [FILE<n>:<name>](<path>) に置き換えた形で、
//     届いたの確定もその形で一致させる (置き換える前の形の行では届いたにしない)
//   - 「今すぐ送る」のコメントも、添付を移してから置き換えた形で送る
//   - 添付のファイルはコメントを消しても送っても消えない
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  commentsPromptText,
  type CommentAnchor,
  type PromptDraftAttachment,
  type UserComment,
} from "@ccmsg/protocol";
import { CommentStore, type LandedPrompt, type PromptOutcome } from "../src/comments.ts";

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

/** A store over fakes in `dir`: a clock the test moves, counted ids, the
 * prompts put in, the transcript's prompts, and an upload directory as POST
 * /attachment fills it. A second fixture over the same `dir` is the daemon
 * started again (its state dir read back). */
function fixture(dir: string) {
  let clock = Date.parse("2026-11-23T00:00:00.000Z");
  let ids = 0;
  let cids = 0;
  const sent: string[] = [];
  const landed: { uuid: string; text: string; at: number }[] = [];
  const uploadDir = path.join(dir, "upload");
  fs.mkdirSync(uploadDir, { recursive: true });
  const deps = {
    stateDir: path.join(dir, "state"),
    now: () => new Date(clock),
    newCid: () => `c${String(cids++).padStart(4, "0")}`,
    newDraftId: () => `00000000-0000-4000-8000-${String(ids++).padStart(12, "0")}`,
    uploadDir,
    log: { info() {}, warn() {} },
    lastRowUuid: async () => "u-1",
    sendPrompt: async (_sid: string, text: string): Promise<PromptOutcome> => {
      sent.push(text);
      return { outcome: "accepted" };
    },
    landedPrompts: async (_sid: string, since: number): Promise<LandedPrompt[]> =>
      landed
        .filter((p) => p.at >= since)
        .map(({ uuid, text, at }) => ({ uuid, text, at: new Date(at).toISOString() })),
  };
  const store = new CommentStore(deps);
  stores.push(store);
  return {
    deps,
    store,
    sent,
    tick: (ms = 1000) => {
      clock += ms;
    },
    /** The transcript gets a person's prompt of `text` now. */
    land: (uuid: string, text: string) => landed.push({ uuid, text, at: clock }),
    /** A file uploaded as POST /attachment keeps it: `<uuid><ext>`. The
     * uuids differ across fixtures of one `dir` by `tag`. */
    upload: (() => {
      let uploads = 0;
      return (ext = ".png", tag = "1"): string => {
        const file = path.join(
          uploadDir,
          `${tag.repeat(8)}-1111-4111-8111-${String(uploads++).padStart(12, "0")}${ext}`,
        );
        fs.writeFileSync(file, "bytes");
        return file;
      };
    })(),
  };
}

async function commented(
  store: CommentStore,
  body: string,
  attachments: PromptDraftAttachment[],
): Promise<UserComment> {
  const result = await store.add(SID, { anchor: ON_RESPONSE, body, attachments, sendNow: false });
  if (!result.ok) throw new Error(result.msg);
  return result.value.comment;
}

function commentItem(comment: UserComment) {
  return { kind: "comment" as const, cid: comment.cid, seen_updated_at: comment.updated_at };
}

/** The record of `cid` as the store holds it. */
async function recordOf(store: CommentStore, cid: string): Promise<UserComment> {
  const record = (await store.list(SID)).find((r) => r.cid === cid);
  if (record?.author !== "user") throw new Error(`no comment ${cid}`);
  return record;
}

describe("a comment's attachments are kept as a FAB's draft's", () => {
  // 添付は置いた時点で state dir の下に移る: アップロードの置き場は OS の TMPDIR で、OS が
  // 消しうるため。webui は入力欄ごとに 1 から番号を振るが、daemon がセッションの番号に
  // 振り直し、本文の [FILE<n>] も同じ対応で書き換える。
  test("comment_add moves the attachments under the state dir and numbers them, the body with them", async () => {
    const f = fixture(tmp("comment-att-"));
    const a = f.upload();
    const comment = await commented(f.store, "[FILE1] と [FILE2] を見て", [
      { n: 1, name: "a.png", path: a },
      { n: 2, name: "b.txt", path: f.upload(".txt") },
    ]);
    expect(comment.body).toBe("[FILE1] と [FILE2] を見て");
    expect(comment.attachments?.map((x) => [x.n, x.name])).toEqual([
      [1, "a.png"],
      [2, "b.txt"],
    ]);
    const moved = comment.attachments?.[0]?.path ?? "";
    expect(path.dirname(moved)).toBe(path.join(f.deps.stateDir, "sessions"));
    expect(path.basename(moved)).toBe(`${SID}.att-${path.basename(a)}`);
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(a)).toBe(false);
    expect(f.sent).toEqual([]);
  });

  // コメントと FAB の下書きは同じ会話に [FILE<n>] を並べるので、番号は 1 本の列で続く
  // (コメントも下書きも <sid>.queue.jsonl の file_seq を使う)。別々に 1 から数えると、
  // 同じ番号のリンクが別のファイルを指して会話に並ぶ。daemon を起こし直しても続きから振る。
  test("the comments and the FAB's drafts are numbered in one line, read back too", async () => {
    const dir = tmp("comment-att-");
    const f = fixture(dir);
    const draft = await f.store.queueAdd(SID, {
      text: "[FILE1] [FILE2]",
      attachments: [
        { n: 1, name: "a.png", path: f.upload() },
        { n: 2, name: "b.png", path: f.upload() },
      ],
    });
    if (!draft.ok) throw new Error(draft.msg);
    const comment = await commented(f.store, "これ [FILE1]", [
      { n: 1, name: "c.png", path: f.upload() },
    ]);
    expect(comment.body).toBe("これ [FILE3]");
    const next = await f.store.queueAdd(SID, {
      text: "[FILE1]",
      attachments: [{ n: 1, name: "d.png", path: f.upload() }],
    });
    if (!next.ok) throw new Error(next.msg);
    expect(next.value.text).toBe("[FILE4]");
    await f.store.settled();
    // The daemon started again reads the line of numbers back.
    const again = fixture(dir);
    const later = await commented(again.store, "[FILE1]", [
      { n: 1, name: "e.png", path: again.upload(".png", "2") },
    ]);
    expect(later.body).toBe("[FILE5]");
  });

  // 番号の続きが queue の file_seq に無くても (file_seq を書く前に作られたコメントの記録
  // 等)、コメントが持つ番号は二度と振らない: 読み戻しの時にコメントの添付の番号の次から
  // 振る。
  test("a number a comment holds is not given again when the queue file does not say so", async () => {
    const dir = tmp("comment-att-");
    const f = fixture(dir);
    await commented(f.store, "[FILE1] [FILE2]", [
      { n: 1, name: "a.png", path: f.upload() },
      { n: 2, name: "b.png", path: f.upload() },
    ]);
    await f.store.settled();
    fs.rmSync(path.join(f.deps.stateDir, "sessions", `${SID}.queue.jsonl`));
    const again = fixture(dir);
    const later = await commented(again.store, "[FILE1]", [
      { n: 1, name: "c.png", path: again.upload(".png", "2") },
    ]);
    expect(later.body).toBe("[FILE3]");
  });

  // 新しい添付として受けるのは POST /attachment が置いたファイル (アップロードの置き場の
  // <uuid><ext>) だけ: 任意のパスを daemon に移させない。断った時はコメントを作らない。
  test("an attachment that is not an uploaded file is refused and nothing is kept", async () => {
    const f = fixture(tmp("comment-att-"));
    const elsewhere = path.join(tmp("comment-att-other-"), "secret.txt");
    fs.writeFileSync(elsewhere, "x");
    const refused = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "[FILE1]",
      attachments: [{ n: 1, name: "secret.txt", path: elsewhere }],
      sendNow: false,
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_args" });
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(await f.store.list(SID)).toEqual([]);
  });
});

describe("changing a comment's attachments", () => {
  // 直した時、記録に既にある添付 (パスで見分ける) は番号を変えず、まだ無い添付だけに
  // セッションの続きの番号を振る。人が読む番号が直すたびに変わらないため。外した添付の
  // ファイルは消さない (30 日の掃除に任せる)。
  test("an attachment it holds keeps its number; a new one gets the next; one taken off stays on disk", async () => {
    const f = fixture(tmp("comment-att-"));
    const comment = await commented(f.store, "[FILE1] [FILE2]", [
      { n: 1, name: "a.png", path: f.upload() },
      { n: 2, name: "b.png", path: f.upload() },
    ]);
    const [first, second] = comment.attachments ?? [];
    if (first === undefined || second === undefined) throw new Error("no attachments");
    f.tick();
    // The webui numbers the new one after what the box holds: 3.
    const changed = await f.store.update(SID, {
      cid: comment.cid,
      seenUpdatedAt: comment.updated_at,
      body: "[FILE2] と [FILE3]",
      attachments: [second, { n: 3, name: "c.png", path: f.upload() }],
    });
    if (!changed.ok) throw new Error(changed.msg);
    expect(changed.value.attachments?.map((a) => [a.n, a.name])).toEqual([
      [2, "b.png"],
      [3, "c.png"],
    ]);
    expect(changed.value.body).toBe("[FILE2] と [FILE3]");
    expect(fs.existsSync(first.path)).toBe(true);
  });

  // 添付の番号は直した時もセッションの続き: 間に他の添付が振られていれば、新しい添付は
  // その後ろの番号を取り、本文もそれに書き換わる。
  test("a new attachment of a change gets the session's next number, past what was given meanwhile", async () => {
    const f = fixture(tmp("comment-att-"));
    const comment = await commented(f.store, "[FILE1]", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    await commented(f.store, "[FILE1]", [{ n: 1, name: "b.png", path: f.upload() }]);
    const held = comment.attachments?.[0];
    if (held === undefined) throw new Error("no attachment");
    f.tick();
    const changed = await f.store.update(SID, {
      cid: comment.cid,
      seenUpdatedAt: comment.updated_at,
      body: "[FILE1] [FILE2]",
      attachments: [held, { n: 2, name: "c.png", path: f.upload() }],
    });
    if (!changed.ok) throw new Error(changed.msg);
    expect(changed.value.body).toBe("[FILE1] [FILE3]");
  });

  // comment_update の attachments は省ける: 省いた直しは本文だけを変え、今の添付を保つ。
  test("a change without attachments keeps the ones it holds", async () => {
    const f = fixture(tmp("comment-att-"));
    const comment = await commented(f.store, "[FILE1]", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    f.tick();
    const changed = await f.store.update(SID, {
      cid: comment.cid,
      seenUpdatedAt: comment.updated_at,
      body: "やっぱり [FILE1]",
    });
    if (!changed.ok) throw new Error(changed.msg);
    expect(changed.value.attachments).toEqual(comment.attachments);
    expect(changed.value.body).toBe("やっぱり [FILE1]");
  });
});

describe("sending a comment with attachments", () => {
  // エージェントに届くのは添付を置き換えた本文: ブロックのキーは増やさず (添付は body の
  // 中の文として届く)、[FILE<n>] を [FILE<n>:<name>](<path>) にする (FAB の下書きと同じ
  // 置き換え)。エージェントはパスを Read できる。
  test("the block's body has each [FILE<n>] put in as its link, and no key of its own", async () => {
    const f = fixture(tmp("comment-att-"));
    const comment = await commented(f.store, "[FILE1] を見て", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    const moved = comment.attachments?.[0]?.path ?? "";
    const result = await f.store.send(SID, [commentItem(comment)]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value).toEqual([{ kind: "comment", id: comment.cid, outcome: "sent" }]);
    expect(f.sent).toEqual([
      JSON.stringify({
        comment: comment.cid,
        on: "msg_start_with:この関数は",
        body: `[FILE1:a.png](${moved}) を見て`,
      }),
    ]);
  });

  // 届いたの確定は、送ったブロックと全部のキーが一致した時: 比べるのは置き換えた後の
  // body。置き換える前の形 ([FILE1] のまま) の行は送ったものと違う文なので届いたにしない。
  test("delivered is seen by the block as sent, links put in; the placeholder form is not it", async () => {
    const f = fixture(tmp("comment-att-"));
    const comment = await commented(f.store, "[FILE1] を見て", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    const result = await f.store.send(SID, [commentItem(comment)]);
    if (!result.ok) throw new Error(result.msg);
    const [prompt] = f.sent;
    if (prompt === undefined) throw new Error("nothing sent");
    f.tick();
    f.land(
      "row-raw",
      commentsPromptText([
        { comment: comment.cid, on: { kind: "msg_start_with", value: "この関数は" }, body: comment.body },
      ]),
    );
    await f.store.confirm(SID);
    expect((await recordOf(f.store, comment.cid)).status).toBe("sent");
    f.land("row-sent", prompt);
    await f.store.confirm(SID);
    const record = await recordOf(f.store, comment.cid);
    expect([record.status, record.row_uuid]).toEqual(["delivered", "row-sent"]);
  });

  // 送る時 (送信の列で順番が来た時) に添付が在るかを確かめる: 無ければそのコメントは送らず
  // draft のまま残し (attachment_missing)、人が直してから送れる。同じ送信の他のコメントは
  // それ抜きで送る (FAB の下書きと同じ扱い)。
  test("a comment whose attachment is gone is not sent and stays a draft; the others go", async () => {
    const f = fixture(tmp("comment-att-"));
    const broken = await commented(f.store, "[FILE1]", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    const fine = await commented(f.store, "こちらは文だけ", []);
    fs.rmSync(broken.attachments?.[0]?.path ?? "");
    const result = await f.store.send(SID, [commentItem(broken), commentItem(fine)]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value).toEqual([
      { kind: "comment", id: broken.cid, outcome: "refused", reason: "attachment_missing" },
      { kind: "comment", id: fine.cid, outcome: "sent" },
    ]);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0]).toContain(`"comment":"${fine.cid}"`);
    expect(f.sent[0]).not.toContain(broken.cid);
    expect((await recordOf(f.store, broken.cid)).status).toBe("draft");
  });

  // 「今すぐ送る」のコメントも同じ: 添付を移して番号を振ってから、置き換えた形で送る。
  test("send_now moves the attachments first and sends the body with their links", async () => {
    const f = fixture(tmp("comment-att-"));
    const result = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "[FILE1]",
      attachments: [{ n: 1, name: "a.png", path: f.upload() }],
      sendNow: true,
    });
    if (!result.ok) throw new Error(result.msg);
    const moved = result.value.comment.attachments?.[0]?.path ?? "";
    expect(path.dirname(moved)).toBe(path.join(f.deps.stateDir, "sessions"));
    expect(result.value.outcome).toEqual({
      kind: "comment",
      id: result.value.comment.cid,
      outcome: "sent",
    });
    expect(f.sent).toEqual([
      JSON.stringify({
        comment: result.value.comment.cid,
        on: "msg_start_with:この関数は",
        body: `[FILE1:a.png](${moved})`,
      }),
    ]);
  });

  // 添付のファイルは、コメントを消しても送っても消さない: 送った本文のリンクが添付の
  // パスを指していて、エージェントが後から読むため。<stateDir>/sessions/ の 30 日の
  // 掃除に任せる。
  test("the files stay when the comment is sent or taken back", async () => {
    const f = fixture(tmp("comment-att-"));
    const sentOne = await commented(f.store, "[FILE1]", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    const deleted = await commented(f.store, "[FILE1]", [
      { n: 1, name: "b.png", path: f.upload() },
    ]);
    const result = await f.store.send(SID, [commentItem(sentOne)]);
    expect(result.ok).toBe(true);
    const removed = await f.store.delete(SID, {
      cid: deleted.cid,
      seenUpdatedAt: deleted.updated_at,
    });
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(sentOne.attachments?.[0]?.path ?? "")).toBe(true);
    expect(fs.existsSync(deleted.attachments?.[0]?.path ?? "")).toBe(true);
  });
});
