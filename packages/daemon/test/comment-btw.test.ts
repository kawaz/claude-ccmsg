// The btw comments (DR-0062 §14): a comment with the btw flag is not put
// into the session but asked of a fork of it (the session's module's
// `$.model.fork`), one fork per comment, each at once. Its answer is a record
// of its own, a reply to the question, running until the fork's whole answer
// comes, and asked again when it failed or was canceled. The fork is a fake
// the test ends.
import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  btwPrompt,
  parseCommentBlocks,
  type CommentAnchor,
  type CommentBlock,
  type CommentRecord,
  type LaunchEffort,
  type UserComment,
} from "@ccmsg/protocol";
import type { BtwForkEnd } from "../src/btw-fork.ts";
import {
  CommentStore,
  commentsFile,
  type BtwStart,
  type LandedPrompt,
  type PromptOutcome,
} from "../src/comments.ts";

const stores: CommentStore[] = [];
const forks: FakeFork[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const fork of forks.splice(0)) fork.answer("");
  for (const store of stores.splice(0)) {
    await store.btwsSettled();
    await store.settled();
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-btw-"));
  dirs.push(dir);
  return dir;
}
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const ON_RESPONSE: CommentAnchor = { kind: "message", uuid: "u-1", msg_start_with: "この関数は" };

/** What a fork was asked: the question's block, and the effort given. */
interface Asked {
  question: string;
  effort: LaunchEffort | undefined;
}
const USAGE = {
  input_tokens: 3,
  output_tokens: 8,
  cache_read_input_tokens: 74_452,
  cache_creation_input_tokens: 0,
};

/** A fork asked of the session's module: what it was asked, and the end the
 * test gives it. */
class FakeFork {
  readonly input: Asked;
  readonly #ended = Promise.withResolvers<BtwForkEnd>();
  readonly ended = this.#ended.promise;
  constructor(input: Asked) {
    this.input = input;
  }
  answer(text: string, effort?: string): void {
    this.#ended.resolve({
      status: "done",
      text,
      usage: USAGE,
      ...(effort !== undefined ? { effort } : {}),
    });
  }
  fail(reason: string, error: string): void {
    this.#ended.resolve({ status: "failed", reason, error });
  }
}

function fixture(dir: string, options: { start?: (asked: Asked) => BtwStart | null } = {}) {
  let clock = Date.parse("2026-11-23T00:00:00.000Z");
  let counter = 0;
  const prompts: string[] = [];
  const asked: FakeFork[] = [];
  const pushes: string[] = [];
  const store = new CommentStore({
    stateDir: dir,
    now: () => new Date((clock += 1000)),
    newCid: () => `c${String(counter++).padStart(4, "0")}`,
    newDraftId: () => crypto.randomUUID(),
    uploadDir: path.join(dir, "upload"),
    log: { info() {}, warn() {} },
    lastRowUuid: async () => "u-9",
    sendPrompt: async (_sid, text): Promise<PromptOutcome> => {
      prompts.push(text);
      return { outcome: "accepted" };
    },
    landedPrompts: async (): Promise<LandedPrompt[]> => [],
    startBtw: async (_sid, question, effort): Promise<BtwStart> => {
      const given = { question, effort };
      const refused = options.start?.(given) ?? null;
      if (refused !== null) return refused;
      const fork = new FakeFork(given);
      asked.push(fork);
      forks.push(fork);
      return { ok: true, fork: fork.ended, model: "claude-opus-5-5[1m]", effort: effort ?? "high" };
    },
  });
  stores.push(store);
  void store.watch(SID, { write: (l) => pushes.push(l) });
  return { store, prompts, asked, pushes };
}

async function addBtw(
  store: CommentStore,
  body: string,
  options: { anchor?: CommentAnchor; effort?: LaunchEffort; sendNow?: boolean } = {},
): Promise<{ comment: UserComment; outcome: string | undefined }> {
  const result = await store.add(SID, {
    anchor: options.anchor ?? { kind: "timing" },
    body,
    btw: true,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    sendNow: options.sendNow ?? true,
  });
  if (!result.ok) throw new Error(result.msg);
  return { comment: result.value.comment, outcome: result.value.outcome?.outcome };
}

async function record(store: CommentStore, cid: string): Promise<CommentRecord | undefined> {
  return (await store.list(SID)).find((r) => r.cid === cid);
}

async function answersOf(store: CommentStore, cid: string): Promise<CommentRecord[]> {
  return (await store.list(SID)).filter(
    (r) => r.author === "btw" && r.anchor.kind === "comment" && r.anchor.cid === cid,
  );
}

describe("asking", () => {
  // btw のコメントは本体のプロンプトに入らず、fork に前置きの後のブロックで聞かれる。
  test("a btw is asked of a fork with its block, not put into the session", async () => {
    const f = fixture(tmp());
    const { comment, outcome } = await addBtw(f.store, "これは何?", {
      anchor: ON_RESPONSE,
      effort: "low",
    });
    expect(outcome).toBe("btw_started");
    expect(f.prompts).toEqual([]);
    expect(f.asked).toHaveLength(1);
    const [fork] = f.asked;
    expect(parseCommentBlocks(fork?.input.question ?? "")).toEqual([
      {
        comment: comment.cid,
        on: { kind: "msg_start_with", value: "この関数は" },
        body: "これは何?",
      },
    ]);
    expect(fork?.input.effort).toBe("low");
    const question = await record(f.store, comment.cid);
    expect(question).toMatchObject({ status: "sent", sent: { after_uuid: "u-9" } });
    const [answer] = await answersOf(f.store, comment.cid);
    expect(answer).toMatchObject({
      author: "btw",
      anchor: { kind: "comment", cid: comment.cid },
      status: "running",
      body: "",
      model: "claude-opus-5-5[1m]",
      effort: "low",
    });
  });

  // 時点のコメント (FAB の btw) のブロックは comment と body だけ。
  test("a btw at a moment of the conversation is its cid and its text alone", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "今どこ?");
    expect(f.asked[0]?.input.question).toBe(
      JSON.stringify({ comment: comment.cid, body: "今どこ?" }),
    );
    // The prefix is the caller's (the daemon's startCommentBtw puts it
    // before).
    expect(btwPrompt("x").endsWith("x")).toBe(true);
  });

  // 答えは fork が終わった時に全文で来る (逐次の表示は無い)。usage と走った effort も持つ。
  test("the answer comes whole as the fork ends, with its usage and the effort it ran at, and is kept", async () => {
    const dir = tmp();
    const f = fixture(dir);
    const { comment } = await addBtw(f.store, "q");
    const [answer] = await answersOf(f.store, comment.cid);
    const cid = answer?.cid ?? "";
    expect(await record(f.store, cid)).toMatchObject({ body: "", status: "running" });
    f.asked[0]?.answer("こたえ", "medium");
    await f.store.btwsSettled();
    expect(await record(f.store, cid)).toMatchObject({
      body: "こたえ",
      status: "done",
      usage: USAGE,
      effort: "medium",
    });
    expect(fs.readFileSync(commentsFile(dir, SID), "utf8")).toContain("こたえ");
  });

  // fork は同時に幾つも走れるので、何件送っても待たずにすぐ聞く。
  test("many btws are each started at once, none waits", async () => {
    const f = fixture(tmp());
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < 6; i += 1) outcomes.push((await addBtw(f.store, String(i))).outcome);
    expect(outcomes).toEqual(Array.from({ length: 6 }, () => "btw_started"));
    expect(f.asked).toHaveLength(6);
  });

  // 答えが無い fork (本体がまだ応答していない等) は、その文を error に持って failed になる。
  test("a fork with no answer fails with its words", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    f.asked[0]?.fail("nothing-to-fork", "本体がまだ 1 回も応答していないので聞けない");
    await f.store.btwsSettled();
    const [answer] = await answersOf(f.store, comment.cid);
    expect(answer).toMatchObject({
      status: "failed",
      body: "",
      error: "本体がまだ 1 回も応答していないので聞けない",
    });
  });

  // まとめて送っても 1 件ずつ別の fork になる。
  test("btws sent together are each asked of a fork of its own", async () => {
    const f = fixture(tmp());
    const a = await addBtw(f.store, "a", { sendNow: false });
    const b = await addBtw(f.store, "b", { sendNow: false });
    const sent = await f.store.send(SID, [
      { kind: "comment", cid: a.comment.cid, seen_updated_at: a.comment.updated_at },
      { kind: "comment", cid: b.comment.cid, seen_updated_at: b.comment.updated_at },
    ]);
    expect(sent.ok && sent.value.map((r) => r.outcome)).toEqual(["btw_started", "btw_started"]);
    expect(f.asked.map((fork) => parseCommentBlocks(fork.input.question)[0]?.body)).toEqual([
      "a",
      "b",
    ]);
    expect(f.prompts).toEqual([]);
  });

  // fork を起こせなければ未送信に戻り、理由を持つ。
  test("a fork not started puts the question back unsent, with why", async () => {
    const f = fixture(tmp(), {
      start: () => ({ ok: false, reason: "session_not_found", msg: "no cwd" }),
    });
    const { comment, outcome } = await addBtw(f.store, "q");
    expect(outcome).toBe("not_delivered");
    expect(await record(f.store, comment.cid)).toMatchObject({
      status: "draft",
      send_error: "session_not_found",
    });
    expect(await answersOf(f.store, comment.cid)).toEqual([]);
  });

  // FAB の btw (アンカーがタイミング) も同じ記録になり、effort と添付を保つ。添付は送る時に
  // [FILE<n>:<name>](<path>) に置き換えて fork に渡る。
  test("a btw at the moment keeps its effort and attachments, the files linked as it is asked", async () => {
    const dir = tmp();
    const f = fixture(dir);
    const upload = path.join(dir, "upload", `${crypto.randomUUID()}.png`);
    fs.mkdirSync(path.dirname(upload), { recursive: true });
    fs.writeFileSync(upload, "png");
    const result = await f.store.add(SID, {
      anchor: { kind: "timing" },
      body: "これ [FILE1] は?",
      btw: true,
      effort: "max",
      attachments: [{ n: 1, name: "shot.png", path: upload }],
      sendNow: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { comment } = result.value;
    expect(comment).toMatchObject({ anchor: { kind: "timing" }, btw: true, effort: "max" });
    const [kept] = comment.attachments ?? [];
    expect(kept?.name).toBe("shot.png");
    expect(fs.existsSync(kept?.path ?? "")).toBe(true);
    expect(f.asked[0]?.input.effort).toBe("max");
    expect(parseCommentBlocks(f.asked[0]?.input.question ?? "")[0]?.body).toBe(
      `これ [FILE1:shot.png](${kept?.path ?? ""}) は?`,
    );
  });

  test("only a btw has an effort", async () => {
    const f = fixture(tmp());
    const result = await f.store.add(SID, {
      anchor: ON_RESPONSE,
      body: "x",
      btw: false,
      effort: "low",
      sendNow: false,
    });
    expect(result.ok ? null : result.code).toBe("invalid_args");
  });
});

describe("cancel and ask again", () => {
  // module の側に fork を止める口は無いので、ここで canceled にし、後から来た答えは捨てる。
  test("a cancel ends the answer canceled at once, and an answer that comes later is dropped", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    const [answer] = await answersOf(f.store, comment.cid);
    const canceled = await f.store.btwCancel(SID, answer?.cid ?? "");
    expect(canceled.ok).toBe(true);
    await f.store.btwsSettled();
    f.asked[0]?.answer("late");
    await f.store.btwsSettled();
    expect(await record(f.store, answer?.cid ?? "")).toMatchObject({
      status: "canceled",
      error: "取り消した",
      body: "",
    });
    // One that ended is left as it is; a cid of no answer is not found.
    expect((await f.store.btwCancel(SID, answer?.cid ?? "")).ok).toBe(true);
    const missing = await f.store.btwCancel(SID, comment.cid);
    expect(missing.ok ? null : missing.code).toBe("not_found");
  });

  // もう一度聞くと、同じ質問から新しい答えの記録ができ、送った時点が今になる。前の答えは残る。
  test("a btw whose answer failed is asked again: a new answer, the question's send moved", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    const sentBefore = (await record(f.store, comment.cid))?.written.at;
    f.asked[0]?.fail("api-error", "overloaded");
    await f.store.btwsSettled();
    const [failed] = await answersOf(f.store, comment.cid);
    expect(failed).toMatchObject({ status: "failed", error: "overloaded" });
    const firstSent = await record(f.store, comment.cid);
    const again = await f.store.btwRetry(SID, comment.cid);
    expect(again.ok).toBe(true);
    expect(f.asked).toHaveLength(2);
    const answers = await answersOf(f.store, comment.cid);
    expect(answers.map((a) => (a.author === "btw" ? a.status : null))).toEqual([
      "failed",
      "running",
    ]);
    const asked = await record(f.store, comment.cid);
    expect(asked?.author === "user" && firstSent?.author === "user").toBe(true);
    if (asked?.author === "user" && firstSent?.author === "user") {
      expect(asked.status).toBe("sent");
      expect(Date.parse(asked.sent?.at ?? "")).toBeGreaterThan(
        Date.parse(firstSent.sent?.at ?? ""),
      );
    }
    expect(sentBefore).toBeDefined();
  });

  test("a btw whose last answer is done or running is not asked again", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    const running = await f.store.btwRetry(SID, comment.cid);
    expect(running.ok ? null : running.code).toBe("invalid_args");
    f.asked[0]?.answer("a");
    await f.store.btwsSettled();
    const done = await f.store.btwRetry(SID, comment.cid);
    expect(done.ok ? null : done.code).toBe("invalid_args");
  });
});

describe("threads and replies", () => {
  // comment_reply は btw の質問と答えの cid を断る (本体の context に無い)。
  test("comment_reply refuses a btw's question and its answer", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    const [answer] = await answersOf(f.store, comment.cid);
    for (const cid of [comment.cid, answer?.cid ?? ""]) {
      const replied = await f.store.reply(SID, { cid, body: "x", toolUseId: `t-${cid}` });
      expect(replied.ok ? null : replied.code).toBe("not_found");
    }
  });

  // btw の答えへの返信は btw:<答えの cid> と質問と答えの全文を持って本体に届く。
  // btw を入れた返信は同じブロックで新しい fork に渡る。
  test("a reply to a btw's answer carries the question and the whole answer", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "xx て何?");
    const [answer] = await answersOf(f.store, comment.cid);
    const answerCid = answer?.cid ?? "";
    f.asked[0]?.answer("<答え>");
    await f.store.btwsSettled();
    const reply = await f.store.add(SID, {
      anchor: { kind: "comment", cid: answerCid },
      body: "続きの質問",
      btw: false,
      sendNow: true,
    });
    expect(reply.ok).toBe(true);
    const block: CommentBlock = {
      comment: reply.ok ? reply.value.comment.cid : "",
      on: { kind: "btw", value: answerCid },
      btw_req: "xx て何?",
      btw_res: "<答え>",
      body: "続きの質問",
    };
    expect(f.prompts.map(parseCommentBlocks)).toEqual([[block]]);
    const btwReply = await addBtw(f.store, "btw で続き", {
      anchor: { kind: "comment", cid: answerCid },
    });
    expect(parseCommentBlocks(f.asked[1]?.input.question ?? "")).toEqual([
      { ...block, comment: btwReply.comment.cid, body: "btw で続き" },
    ]);
  });

  // 走っている間に解決にしたスレッドは、答えが終わった時に解決を外す。
  test("a thread resolved while its answer runs is opened again as it ends", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    const [answer] = await answersOf(f.store, comment.cid);
    const resolved = await f.store.resolve(SID, {
      cid: comment.cid,
      resolved: true,
      seenCid: answer?.cid ?? "",
    });
    expect(resolved.ok && resolved.value.resolved_at !== undefined).toBe(true);
    f.asked[0]?.answer("a");
    await f.store.btwsSettled();
    const [thread] = await f.store.threads(SID);
    expect(thread?.resolved_at).toBeUndefined();
  });

  // btw の質問は本体に届くものではないので、届いたの照合も turn の終わりの未確認もしない。
  test("a btw sent is never made unconfirmed at a turn's end", async () => {
    const f = fixture(tmp());
    const { comment } = await addBtw(f.store, "q");
    await f.store.turnEnded(SID, Date.now() + 60_000);
    await f.store.turnEnded(SID, Date.now() + 120_000);
    expect(await record(f.store, comment.cid)).toMatchObject({ status: "sent" });
  });
});

describe("a daemon that stops", () => {
  // 起動の後に running のまま残った答えは failed になる。
  test("an answer left running is failed", async () => {
    const dir = tmp();
    const f = fixture(dir);
    const running = await addBtw(f.store, "1");
    await f.store.written();
    const [answer] = await answersOf(f.store, running.comment.cid);
    const next = fixture(dir);
    expect(await record(next.store, answer?.cid ?? "")).toMatchObject({
      status: "failed",
      error: "daemon が止まった",
    });
    expect(await record(next.store, running.comment.cid)).toMatchObject({ status: "sent" });
  });

  test("stopping the btws ends the running ones with the daemon", async () => {
    const f = fixture(tmp());
    const running = await addBtw(f.store, "1");
    await f.store.stopBtws();
    const [answer] = await answersOf(f.store, running.comment.cid);
    expect(answer).toMatchObject({ status: "canceled", error: "daemon が止まった" });
  });
});
