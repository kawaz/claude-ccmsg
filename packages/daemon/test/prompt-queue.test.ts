// The FAB's queue (DR-0062 §11, §15): the person's prompts kept in the daemon
// to send later. The session is fakes, as in comments.test.ts: the prompts the
// store puts in are recorded, and the transcript's prompts are what the test
// says they are.
// 何を保証するか:
//   - キューに置いた下書きはエージェントに何も送らない。送る時は 1 件ずつ別のプロンプトで入り
//     (空行で連結しない)、添付は [FILE<n>:<name>](<path>) に置き換えた文で入る
//   - 全部送る (コメントと下書きを 1 つの queue_send で送る) はコメントが先
//   - queued でない下書き・見ていた版の違う下書き・知らない id は送らずに項目ごとに断る
//   - 入らなかった (not_delivered) 下書きがあれば残りを送らず、理由付きで queued に戻す
//   - 添付はキューに置いた時に state dir の下に移り、番号はセッションの中で 1 から続く。直して
//     も既にある添付の番号は変わらず、記録が消えてファイルが書き直された後も番号は戻らない
//   - 添付が無くなった下書きは送らずに queued のまま残る (attachment_missing)
//   - 送った下書きは transcript の人の行に同じ文を見るまで sent / unconfirmed で残り、見たら
//     記録が消える (添付のファイルは残る)。購読の始まりの drafts に sent は入らない
//   - 送った後の最初の turn の終わりまでに見えなければ unconfirmed に落ち、下書きに戻す
//     (queued) か送った扱いにする (記録が消える) ことができる
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CommentsStreamEventSchema,
  jsonText,
  parseWith,
  QueueFileLineSchema,
  type CommentAnchor,
  type PromptDraftRecord,
} from "@ccmsg/protocol";
import { BtwSlots } from "../src/btw.ts";
import {
  CommentStore,
  type BtwStart,
  type LandedPrompt,
  type PromptOutcome,
} from "../src/comments.ts";
import { queueFile } from "../src/prompt-queue.ts";

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

/** A store over fakes: a clock the test moves, counted ids, the prompts put
 * in, the transcript's prompts, and an upload directory as POST /attachment
 * fills it. `outcomes` answers the sends in turn (accepted past its end). */
function fixture(dir: string, outcomes: PromptOutcome[] = []) {
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
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
      return outcomes.shift() ?? { outcome: "accepted" };
    },
    landedPrompts: async (_sid: string, since: number): Promise<LandedPrompt[]> =>
      landed
        .filter((p) => p.at >= since)
        .map(({ uuid, text, at }) => ({
          uuid,
          text,
          at: new Date(at).toISOString(),
        })),
    btwSlots: new BtwSlots(),
    startBtw: async (): Promise<BtwStart> => ({
      ok: false,
      reason: "btw_launch_unavailable",
      msg: "no btw is asked in this test",
    }),
    afterPushInterval: () => ({ cancel() {} }),
  };
  const store = new CommentStore(deps);
  stores.push(store);
  let uploads = 0;
  return {
    deps,
    store,
    sent,
    tick: (ms = 1000) => {
      clock += ms;
    },
    now: () => new Date(clock).toISOString(),
    /** The transcript gets a person's prompt of `text` now. */
    land: (uuid: string, text: string) => landed.push({ uuid, text, at: clock }),
    /** A file uploaded as POST /attachment keeps it: `<uuid><ext>`. */
    upload: (ext = ".png"): string => {
      const file = path.join(
        uploadDir,
        `11111111-1111-4111-8111-${String(uploads++).padStart(12, "0")}${ext}`,
      );
      fs.writeFileSync(file, "bytes");
      return file;
    },
  };
}

async function queued(
  store: CommentStore,
  text: string,
  attachments: { n: number; name: string; path: string }[] = [],
): Promise<PromptDraftRecord> {
  const result = await store.queueAdd(SID, { text, attachments });
  if (!result.ok) throw new Error(result.msg);
  return result.value;
}

function draftItem(draft: PromptDraftRecord) {
  return { kind: "draft" as const, id: draft.id, seen_updated_at: draft.updated_at };
}

async function draftsOf(store: CommentStore): Promise<PromptDraftRecord[]> {
  const lines: string[] = [];
  await store.watch(SID, { write: (line) => lines.push(line) });
  // The whole set: a change the read back made (a draft that was being sent
  // made unconfirmed) may be told before it.
  for (const line of lines) {
    const read = parseWith(jsonText(CommentsStreamEventSchema), line);
    if (read.ok) return [...read.value.drafts];
  }
  throw new Error("no ev:comments");
}

describe("putting a prompt in the queue", () => {
  // キューに置くのは「送る時機を後ろにずらす」だけで、置いた時点ではエージェントに何も
  // 届かない (§15)。記録は queued で、id は daemon が振る UUID。
  test("a queued draft sends nothing and is kept as queued", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "あとで見て");
    expect(draft).toMatchObject({ kind: "draft", status: "queued", text: "あとで見て" });
    expect(f.sent).toEqual([]);
    expect((await draftsOf(f.store)).map((d) => d.id)).toEqual([draft.id]);
  });

  // 添付はキューに置いた時点で state dir の下 (<sid>.att-<uuid><ext>) に移る: OS の
  // TMPDIR は OS が消しうるため (P29)。本文の [FILE<n>] はセッションの番号に振り直る。
  // 番号はセッションの中で 1 から続き、下書きごとに数え直さない (§15、P12)。
  test("attachments move under the state dir and take the session's next numbers", async () => {
    const f = fixture(tmp("queue-"));
    const a = f.upload();
    const first = await queued(f.store, "[FILE1] と [FILE2]", [
      { n: 1, name: "a.png", path: a },
      { n: 2, name: "b.png", path: f.upload() },
    ]);
    // The webui numbers each draft from 1: the daemon makes it the session's.
    const second = await queued(f.store, "これも [FILE1]", [
      { n: 1, name: "c.png", path: f.upload() },
    ]);
    expect(first.text).toBe("[FILE1] と [FILE2]");
    expect(second.text).toBe("これも [FILE3]");
    expect(second.attachments.map((x) => x.n)).toEqual([3]);
    const moved = first.attachments[0]?.path ?? "";
    expect(path.dirname(moved)).toBe(path.join(f.deps.stateDir, "sessions"));
    expect(path.basename(moved)).toBe(`${SID}.att-${path.basename(a)}`);
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(a)).toBe(false);
  });

  // 振り直しは 1 回の置き換えで行う: 1→3 と 3→5 が続けて当たって 1 が 5 になる、という
  // ことを起こさない。本文にある添付の無い [FILE<n>] (古い残り) の番号は新しい添付に振らない
  // (同じ番号のリンクが 2 つできて両方が同じファイルに置き換わるのを防ぐ)。
  test("renumbering is one pass and skips a number the text holds without an attachment", async () => {
    const f = fixture(tmp("queue-"));
    await queued(f.store, "[FILE1]", [{ n: 1, name: "a.png", path: f.upload() }]);
    const draft = await queued(f.store, "[FILE2] [FILE1] [FILE3]", [
      { n: 1, name: "b.png", path: f.upload() },
      { n: 3, name: "c.png", path: f.upload() },
    ]);
    // Next is 2, but the text holds a bare [FILE2]: 1 → 3, 3 → 4.
    expect(draft.text).toBe("[FILE2] [FILE3] [FILE4]");
  });

  // 新しい添付として受けるのは POST /attachment が置いたファイル (アップロードの置き場の
  // <uuid><ext>) だけ: 任意のパスを daemon に移させない。
  test("an attachment that is not an uploaded file is refused and nothing is kept", async () => {
    const f = fixture(tmp("queue-"));
    const elsewhere = path.join(tmp("queue-other-"), "secret.txt");
    fs.writeFileSync(elsewhere, "x");
    const refused = await f.store.queueAdd(SID, {
      text: "[FILE1]",
      attachments: [{ n: 1, name: "secret.txt", path: elsewhere }],
    });
    expect(refused).toMatchObject({ ok: false, code: "invalid_args" });
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(await draftsOf(f.store)).toEqual([]);
  });
});

describe("changing and taking back a draft", () => {
  // 直した時、記録に既にある添付 (パスで見分ける) は番号を変えず、まだ無い添付だけに
  // セッションの続きの番号を振る (§15)。人が読む番号が直すたびに変わらないため。
  test("an attachment the draft holds keeps its number; a new one gets the next", async () => {
    const f = fixture(tmp("queue-"));
    await queued(f.store, "[FILE1]", [{ n: 1, name: "a.png", path: f.upload() }]);
    const draft = await queued(f.store, "[FILE1] だけ", [
      { n: 1, name: "b.png", path: f.upload() },
    ]);
    expect(draft.text).toBe("[FILE2] だけ");
    const held = draft.attachments[0];
    if (held === undefined) throw new Error("no attachment");
    f.tick();
    const changed = await f.store.queueUpdate(SID, {
      id: draft.id,
      seenUpdatedAt: draft.updated_at,
      text: "[FILE2] と [FILE3]",
      attachments: [held, { n: 3, name: "c.png", path: f.upload() }],
    });
    if (!changed.ok) throw new Error(changed.msg);
    // 3 was the webui's number for the new one; the session's next is 3 too.
    expect(changed.value.attachments.map((a) => [a.n, a.name])).toEqual([
      [2, "b.png"],
      [3, "c.png"],
    ]);
    expect(changed.value.text).toBe("[FILE2] と [FILE3]");
  });

  // 直す・消すは queued の下書きだけで、見ていた版 (updated_at) が違えば conflict (別の
  // デバイスで先に直された・送られた)。版を先に見る。
  test("a change or a delete at another version is a conflict", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "x");
    f.tick();
    const changed = await f.store.queueUpdate(SID, {
      id: draft.id,
      seenUpdatedAt: draft.updated_at,
      text: "y",
      attachments: [],
    });
    expect(changed.ok).toBe(true);
    expect(
      await f.store.queueUpdate(SID, {
        id: draft.id,
        seenUpdatedAt: draft.updated_at,
        text: "z",
        attachments: [],
      }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(
      await f.store.queueDelete(SID, { id: draft.id, seenUpdatedAt: draft.updated_at }),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  // 消すのは記録だけで、添付のファイルは残す: 送った本文がそのパスを指していることがあり、
  // 掃除は state dir の 30 日の掃除に任せる (§15)。
  test("taking a draft back removes its record and leaves its files", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "[FILE1]", [{ n: 1, name: "a.png", path: f.upload() }]);
    const removed = await f.store.queueDelete(SID, {
      id: draft.id,
      seenUpdatedAt: draft.updated_at,
    });
    expect(removed.ok).toBe(true);
    expect(await draftsOf(f.store)).toEqual([]);
    expect(fs.existsSync(draft.attachments[0]?.path ?? "")).toBe(true);
  });
});

describe("sending drafts", () => {
  // 下書きは 1 件ずつ別のプロンプトとして送る (空行で連結しない、§11): 連結すると短い
  // プロンプト同士が別の意味になり、transcript の人の行と 1 対 1 で照合できなくなる。
  // 添付は [FILE<n>:<name>](<path>) に置き換えた文で入る。
  test("each draft goes as a prompt of its own, attachments put in", async () => {
    const f = fixture(tmp("queue-"));
    const a = await queued(f.store, "一つ目");
    const b = await queued(f.store, "[FILE1] を見て", [{ n: 1, name: "a.png", path: f.upload() }]);
    const result = await f.store.send(SID, [draftItem(a), draftItem(b)]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value).toEqual([
      { kind: "draft", id: a.id, outcome: "sent" },
      { kind: "draft", id: b.id, outcome: "sent" },
    ]);
    expect(f.sent).toEqual(["一つ目", `[FILE1:a.png](${b.attachments[0]?.path ?? ""}) を見て`]);
  });

  // 全部送るはコメントを先、FAB の下書きを後に送る (§11)。渡す順に下書きが先にあっても
  // コメントが先に入る。結果は渡した項目の順で返る。
  test("sending everything puts the comments in first, the drafts after", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "下書き");
    const added = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "コメント",
      btw: false,
      sendNow: false,
    });
    if (!added.ok) throw new Error(added.msg);
    const comment = added.value.comment;
    const result = await f.store.send(SID, [
      draftItem(draft),
      { kind: "comment", cid: comment.cid, seen_updated_at: comment.updated_at },
    ]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value.map((r) => [r.kind, r.outcome])).toEqual([
      ["draft", "sent"],
      ["comment", "sent"],
    ]);
    expect(f.sent.length).toBe(2);
    expect(f.sent[0]).toContain(`"comment":"${comment.cid}"`);
    expect(f.sent[1]).toBe("下書き");
  });

  // 送るのは queued の下書きだけ。送り中・送った下書き、見ていた版の違う下書き、知らない
  // id は送らずに項目ごとに断る (not_sendable は今の状態を添える)。
  test("a draft not queued, at another version or unknown is refused item by item", async () => {
    const f = fixture(tmp("queue-"));
    const sentOne = await queued(f.store, "送った");
    const first = await f.store.send(SID, [draftItem(sentOne)]);
    expect(first.ok).toBe(true);
    const stale = await queued(f.store, "古い版");
    f.tick();
    const changed = await f.store.queueUpdate(SID, {
      id: stale.id,
      seenUpdatedAt: stale.updated_at,
      text: "新しい版",
      attachments: [],
    });
    expect(changed.ok).toBe(true);
    const unknown = "00000000-0000-4000-8000-999999999999";
    const result = await f.store.send(SID, [
      { kind: "draft", id: sentOne.id, seen_updated_at: sentOne.updated_at },
      draftItem(stale),
      { kind: "draft", id: unknown, seen_updated_at: "x" },
    ]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value).toEqual([
      { kind: "draft", id: sentOne.id, outcome: "refused", reason: "not_sendable", status: "sent" },
      { kind: "draft", id: stale.id, outcome: "refused", reason: "conflict" },
      { kind: "draft", id: unknown, outcome: "refused", reason: "not_found" },
    ]);
    expect(f.sent).toEqual(["送った"]);
  });

  // not_delivered が出たら残りを送らない (P7): 順序を保ち、届かない理由 (ダイアログ中等) の
  // 間に後ろの件が先に入るのを避ける。入らなかった下書きも、試さなかった残りも、理由を
  // send_error に持って queued に戻る。
  test("after a draft is not put in, the rest are not tried and stay queued", async () => {
    const f = fixture(tmp("queue-"), [
      { outcome: "accepted" },
      { outcome: "not_delivered", reason: "dialog" },
    ]);
    const a = await queued(f.store, "a");
    const b = await queued(f.store, "b");
    const c = await queued(f.store, "c");
    const result = await f.store.send(SID, [draftItem(a), draftItem(b), draftItem(c)]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value.map((r) => r.outcome)).toEqual(["sent", "not_delivered", "not_delivered"]);
    expect(f.sent).toEqual(["a", "b"]);
    const drafts = await draftsOf(f.store);
    // a is sent (left out of the drafts listed until it is seen).
    expect(drafts.map((d) => [d.text, d.status, d.send_error])).toEqual([
      ["b", "queued", "dialog"],
      ["c", "queued", "dialog"],
    ]);
  });

  // 送る前に添付が在るかを確かめ、無ければ送らずに attachment_missing を返し、下書きは
  // queued のまま残す (§15)。他の下書きは送る。
  test("a draft whose attachment is gone is not sent and stays queued", async () => {
    const f = fixture(tmp("queue-"));
    const broken = await queued(f.store, "[FILE1]", [{ n: 1, name: "a.png", path: f.upload() }]);
    const fine = await queued(f.store, "ok");
    fs.rmSync(broken.attachments[0]?.path ?? "");
    const result = await f.store.send(SID, [draftItem(broken), draftItem(fine)]);
    if (!result.ok) throw new Error(result.msg);
    expect(result.value).toEqual([
      { kind: "draft", id: broken.id, outcome: "refused", reason: "attachment_missing" },
      { kind: "draft", id: fine.id, outcome: "sent" },
    ]);
    expect(f.sent).toEqual(["ok"]);
    expect((await draftsOf(f.store)).find((d) => d.id === broken.id)?.status).toBe("queued");
  });
});

describe("a sent draft until it is seen", () => {
  // 送った下書きは transcript の人の行に同じ文 (両端の空白を落として比べる) を見るまで
  // sent で残り、見たら記録ごと消える (裁定 3)。添付のファイルは消えない (エージェントが
  // 後から読む)。購読の始まりの drafts に sent は入らない (§10)。
  test("a sent draft stays until its row is seen, then its record goes and its files stay", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "[FILE1] を見て", [
      { n: 1, name: "a.png", path: f.upload() },
    ]);
    const frames: string[] = [];
    await f.store.watch(SID, { write: (line) => frames.push(line) });
    await f.store.send(SID, [draftItem(draft)]);
    await f.store.settled();
    expect(await draftsOf(f.store)).toEqual([]);
    expect(frames.some((line) => line.includes('"status":"sent"'))).toBe(true);
    // A row of another text is not it.
    f.tick();
    f.land("u-other", "ほかの話");
    f.store.rowsPushed(SID);
    await f.store.settled();
    expect(frames.some((line) => line.includes('"ev":"prompt_draft_removed"'))).toBe(false);
    f.land("u-2", `  ${f.sent[0] ?? ""}\n`);
    f.store.rowsPushed(SID);
    await f.store.settled();
    expect(frames.at(-1)).toContain('"ev":"prompt_draft_removed"');
    expect(fs.existsSync(draft.attachments[0]?.path ?? "")).toBe(true);
    const lines = fs.readFileSync(queueFile(f.deps.stateDir, SID), "utf8");
    expect(lines).toContain(`{"kind":"draft_removed","id":"${draft.id}"}`);
  });

  // 同じ文の下書きを 2 つ送ると、人の行 1 つは 1 つの下書きしか消さない (古い方から)。
  test("one row lands one draft of the same text", async () => {
    const f = fixture(tmp("queue-"));
    const a = await queued(f.store, "同じ");
    const b = await queued(f.store, "同じ");
    await f.store.send(SID, [draftItem(a), draftItem(b)]);
    f.tick();
    f.land("u-2", "同じ");
    f.store.rowsPushed(SID);
    await f.store.settled();
    const frames: string[] = [];
    await f.store.watch(SID, { write: (line) => frames.push(line) });
    const all = parseWith(jsonText(CommentsStreamEventSchema), frames[0] ?? "");
    if (!all.ok) throw new Error(all.failure.summary);
    // b is sent and not seen: left out of the drafts listed, held still.
    expect(all.value.drafts).toEqual([]);
    f.land("u-3", "同じ");
    f.store.rowsPushed(SID);
    await f.store.settled();
    expect(frames.filter((line) => line.includes('"ev":"prompt_draft_removed"')).length).toBe(1);
  });

  // 送った後に始まった最初の turn が終わっても見えなければ unconfirmed に落ち、購読の
  // drafts に出る (P35)。そこから「下書きに戻す」で queued に、「送った扱いにする」で記録が
  // 消える。
  test("one not seen by the end of the first turn after it is unconfirmed, and settles", async () => {
    const f = fixture(tmp("queue-"));
    const a = await queued(f.store, "a");
    const b = await queued(f.store, "b");
    await f.store.send(SID, [draftItem(a), draftItem(b)]);
    f.tick();
    await f.store.turnEnded(SID, Date.parse(f.now()));
    const drafts = await draftsOf(f.store);
    expect(drafts.map((d) => d.status)).toEqual(["unconfirmed", "unconfirmed"]);
    const [da, db] = drafts;
    if (da === undefined || db === undefined) throw new Error("no drafts");
    const back = await f.store.settleDraft(SID, {
      id: da.id,
      action: "back_to_draft",
      seenUpdatedAt: da.updated_at,
    });
    expect(back.ok).toBe(true);
    const marked = await f.store.settleDraft(SID, {
      id: db.id,
      action: "mark_sent",
      seenUpdatedAt: db.updated_at,
    });
    expect(marked.ok).toBe(true);
    const after = await draftsOf(f.store);
    expect(after.map((d) => [d.id, d.status, d.sent])).toEqual([[a.id, "queued", undefined]]);
  });

  // 未確認の扱いは unconfirmed の下書きだけ。版が違えば conflict、版が同じで unconfirmed
  // でなければ invalid_args。
  test("settling a draft that is not unconfirmed is refused", async () => {
    const f = fixture(tmp("queue-"));
    const draft = await queued(f.store, "a");
    expect(
      await f.store.settleDraft(SID, {
        id: draft.id,
        action: "mark_sent",
        seenUpdatedAt: "other",
      }),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(
      await f.store.settleDraft(SID, {
        id: draft.id,
        action: "mark_sent",
        seenUpdatedAt: draft.updated_at,
      }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("the queue file", () => {
  // 読み戻し: 別の daemon (同じ state dir) が読むと、下書きは最新の版で戻り、送っている途中
  // (sending) のものは unconfirmed として読まれる。ファイルは読み戻しの時に、消えた下書きと
  // 古い版の行を捨てて書き直される (P34)。番号の続き (file_seq) は書き直しても残り、記録が
  // 全部消えた後も番号は 1 に戻らない (P12)。
  test("read back, the file is rewritten to what is there and numbers go on", async () => {
    const dir = tmp("queue-");
    const f = fixture(dir);
    const a = await queued(f.store, "[FILE1]", [{ n: 1, name: "a.png", path: f.upload() }]);
    f.tick();
    await f.store.queueUpdate(SID, {
      id: a.id,
      seenUpdatedAt: a.updated_at,
      text: "[FILE1] 直した",
      attachments: [...a.attachments],
    });
    const b = await queued(f.store, "[FILE1] [FILE2]", [
      { n: 1, name: "b.png", path: f.upload() },
      { n: 2, name: "c.png", path: f.upload() },
    ]);
    await f.store.queueDelete(SID, { id: b.id, seenUpdatedAt: b.updated_at });
    await f.store.settled();
    const before = fs.readFileSync(queueFile(f.deps.stateDir, SID), "utf8").trim().split("\n");
    expect(before.length).toBeGreaterThan(2);

    const g = fixture(dir);
    const drafts = await draftsOf(g.store);
    expect(drafts.map((d) => [d.id, d.text])).toEqual([[a.id, "[FILE1] 直した"]]);
    const after = fs.readFileSync(queueFile(g.deps.stateDir, SID), "utf8").trim().split("\n");
    expect(
      after.map((line) => {
        const read = parseWith(QueueFileLineSchema, line);
        return read.ok ? read.value.kind : "unread";
      }),
    ).toEqual(["file_seq", "draft"]);
    const next = await queued(g.store, "[FILE1]", [{ n: 1, name: "d.png", path: g.upload() }]);
    expect(next.text).toBe("[FILE4]");
  });

  test("a draft being sent when the daemon stopped is read back unconfirmed", async () => {
    const dir = tmp("queue-");
    const f = fixture(dir);
    const draft = await queued(f.store, "a");
    await f.store.settled();
    fs.appendFileSync(
      queueFile(f.deps.stateDir, SID),
      `${JSON.stringify({ ...draft, status: "sending", sent: { at: f.now() } })}\n`,
    );
    const g = fixture(dir);
    expect((await draftsOf(g.store)).map((d) => d.status)).toEqual(["unconfirmed"]);
  });
});
