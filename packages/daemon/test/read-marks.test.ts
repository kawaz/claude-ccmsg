// The person's read marks on the agent's responses (DR-0068 §4): kept as
// lines of the session's comments file, set by the op read_mark_set (the
// person's only), told to the tabs that look at the session.
// 何を保証するか:
//   - read_mark_set は user role だけ。session role は bad_request で断り、何も保存しない。
//     uuid が UUID の形でなければ invalid_args、daemon が transcript を見つけられない
//     セッションは session_not_found で、どちらも何も保存しない
//   - 既読の付け外しは 1 行ずつ追記し、同じ uuid の後の行が勝つ (read が false の行が前の
//     既読に勝つ)。同じ状態への設定は行を書かず、何も送らない。行が書けなければ
//     state_not_writable で断り、メモリも配りも変えない。daemon.log に op ごとに 1 行
//   - 購読の始まりの ev:"comments" が既読の記録 (read が true のもの) を持ち、変わるたびに
//     ev:"read_mark" がそのセッションを購読している全ての接続 (別のデバイスのタブも) に届く。
//     購読していない接続・購読をやめた接続には届かない (Files / Status / Timeline のどのタブも
//     同じ session_status_subscribe なので、購読の有無だけを見る)
//   - daemon を起こし直しても、ファイルから読んだ既読が配られる
//   - 既読の付け外しは、セッションに何も送らず (module の接続に何も届かない)、transcript を
//     書かない。say の未読を変えず、say_read は応答の既読を変えない
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CCMSG_TOOLS,
  CommentsStreamEventSchema,
  ErrorCode,
  jsonText,
  parseWith,
  ReadMarkStreamEventSchema,
  type ReadMark,
} from "@ccmsg/protocol";
import { assistantContentRow, line, toolUseBlock } from "../../protocol/test/transcript-rows.ts";
import { CommentStore, commentsFile, readCommentsFile } from "../src/comments.ts";
import type { Conn } from "../src/server.ts";
import { unreadSays } from "../src/say-unread.ts";
import { unreadPermits } from "../src/permit-state.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";
import {
  liveSessionConn,
  stampRows,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = { role: "session", sid: SID, cwd: "" };
const MESSAGE = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000003";

/** The marks an ev:"comments" line holds, null for another line. */
function marksOf(line: string | undefined): ReadMark[] | null {
  const read = parseWith(jsonText(CommentsStreamEventSchema), line ?? "");
  return read.ok ? [...read.value.read_marks] : null;
}

/** The mark an ev:"read_mark" line tells, null for another line. */
function toldOf(line: string): ReadMark | null {
  const read = parseWith(jsonText(ReadMarkStreamEventSchema), line);
  return read.ok ? read.value.mark : null;
}

const mark = (uuid: string, read: boolean): ReadMark => ({
  kind: "read",
  session_id: SID,
  uuid,
  read,
});

/** A transcript of session SID under `home`'s config dir, where the daemon
 * finds a session that is not connected. */
function transcriptUnder(home: string): string {
  const file = path.join(home, ".claude-x", "projects", "p", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-22T00:00:00.000Z" })}\n`,
  );
  return file;
}

describe("read_mark_set over the wire", () => {
  test("a session's agent may not mark a response read, and nothing is kept", async () => {
    const base = tmp("read-marks-");
    transcriptUnder(path.join(base, "home"));
    const daemon = stubDaemon({}, base);
    const refused = await requestError(daemon, SESSION, {
      op: "read_mark_set",
      request_id: "r1",
      session_id: SID,
      uuid: MESSAGE,
      read: true,
    });
    expect(refused.error.code).toBe(ErrorCode.bad_request);
    expect(fs.existsSync(commentsFile(daemon.paths.stateDir, SID))).toBe(false);
    await daemon.comments.settled();
  });

  test("a uuid not of a UUID's shape is invalid_args, and nothing is kept", async () => {
    const base = tmp("read-marks-");
    transcriptUnder(path.join(base, "home"));
    const daemon = stubDaemon({}, base);
    const refused = await requestError(daemon, USER, {
      op: "read_mark_set",
      request_id: "r1",
      session_id: SID,
      uuid: "u-1",
      read: true,
    });
    expect(refused.error.code).toBe(ErrorCode.invalid_args);
    expect(fs.existsSync(commentsFile(daemon.paths.stateDir, SID))).toBe(false);
    await daemon.comments.settled();
  });

  test("a session the daemon finds no transcript of is session_not_found", async () => {
    const daemon = stubDaemon({}, tmp("read-marks-"));
    const refused = await requestError(daemon, USER, {
      op: "read_mark_set",
      request_id: "r1",
      session_id: SID,
      uuid: MESSAGE,
      read: true,
    });
    expect(refused.error.code).toBe(ErrorCode.session_not_found);
    expect(fs.existsSync(commentsFile(daemon.paths.stateDir, SID))).toBe(false);
    await daemon.comments.settled();
  });

  test("the person marks a response read and takes the mark off, one line each", async () => {
    const base = tmp("read-marks-");
    transcriptUnder(path.join(base, "home"));
    const daemon = stubDaemon({}, base);
    const set = (read: boolean, n: number) =>
      requestOk(daemon, USER, {
        op: "read_mark_set",
        request_id: `r${String(n)}`,
        session_id: SID,
        uuid: MESSAGE,
        read,
      });
    expect(await set(true, 1)).toEqual({ ok: true });
    expect(await set(true, 2)).toEqual({ ok: true });
    expect(await set(false, 3)).toEqual({ ok: true });
    await daemon.comments.settled();
    const file = commentsFile(daemon.paths.stateDir, SID);
    expect(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual([JSON.stringify(mark(MESSAGE, true)), JSON.stringify(mark(MESSAGE, false))]);
    expect((await readCommentsFile(file, () => {})).readMarks.size).toBe(0);
  });
});

describe("the store (DR-0068 §4)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A store whose session sends nothing: a mark goes nowhere near it. */
  function storeIn(dir: string, logged: string[] = []): { store: CommentStore; sent: string[] } {
    const sent: string[] = [];
    const store = new CommentStore({
      stateDir: dir,
      now: () => new Date("2026-11-28T00:00:00.000Z"),
      newCid: () => "c0000",
      newDraftId: () => crypto.randomUUID(),
      uploadDir: path.join(dir, "upload"),
      log: { info: (msg) => logged.push(msg), warn() {} },
      lastRowUuid: async () => undefined,
      sendPrompt: async (_sid, text) => {
        sent.push(text);
        return { outcome: "accepted" };
      },
      landedPrompts: async () => [],
      startBtw: async () => ({ ok: false, reason: "btw_launch_unavailable", msg: "none" }),
    });
    return { store, sent };
  }
  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-marks-"));
    dirs.push(dir);
    return dir;
  }

  test("a later line of the same uuid wins as the file is read, a mark of false over a read one", async () => {
    const dir = tmpDir();
    const file = commentsFile(dir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [mark(MESSAGE, true), mark(OTHER, true), mark(MESSAGE, false)]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );
    const { store } = storeIn(dir);
    const lines: string[] = [];
    await store.watch(SID, { write: (line) => lines.push(line) });
    expect(lines.map(marksOf)).toEqual([[mark(OTHER, true)]]);
    await store.settled();
  });

  test("a mark already as asked writes and tells nothing; a change tells every tab looking", async () => {
    const dir = tmpDir();
    const logged: string[] = [];
    const { store, sent } = storeIn(dir, logged);
    const a: string[] = [];
    const b: string[] = [];
    await store.watch(SID, { write: (line) => a.push(line) });
    await store.watch(SID, { write: (line) => b.push(line) });
    expect(await store.setReadMark(SID, { uuid: MESSAGE, read: false })).toEqual({
      ok: true,
      value: null,
    });
    expect(fs.existsSync(commentsFile(dir, SID))).toBe(false);
    expect(await store.setReadMark(SID, { uuid: MESSAGE, read: true })).toMatchObject({ ok: true });
    expect(await store.setReadMark(SID, { uuid: MESSAGE, read: true })).toMatchObject({ ok: true });
    for (const tab of [a, b]) {
      expect(tab.slice(1).map(toldOf)).toEqual([mark(MESSAGE, true)]);
    }
    expect(logged).toEqual([`read_mark_set: session_id=${SID} uuid=${MESSAGE} read=true`]);
    // Nothing goes to the session, and no comment is made.
    expect(sent).toEqual([]);
    expect(await store.list(SID)).toEqual([]);
    await store.settled();
  });

  test("a mark whose line cannot be written is state_not_writable, and nothing is kept or told", async () => {
    const dir = tmpDir();
    // The sessions directory cannot be made: a file is in its place.
    fs.writeFileSync(path.join(dir, "sessions"), "");
    const { store } = storeIn(dir);
    const lines: string[] = [];
    await store.watch(SID, { write: (line) => lines.push(line) });
    expect(await store.setReadMark(SID, { uuid: MESSAGE, read: true })).toMatchObject({
      ok: false,
      code: "state_not_writable",
    });
    expect(lines.length).toBe(1);
    const again: string[] = [];
    await store.watch(SID, { write: (line) => again.push(line) });
    expect(marksOf(again[0])).toEqual([]);
    await store.settled();
  });
});

/** A daemon in this process, with SID's transcript under its HOME. */
async function withDaemon(
  run: (ctx: InProcessDaemon, transcript: string) => Promise<void>,
  options: { base?: string; keepBase?: boolean } = {},
) {
  const ctx = await startInProcessDaemon(options.base !== undefined ? { base: options.base } : {});
  try {
    const transcript = transcriptUnder(path.join(ctx.base, "d", "home"));
    await run(ctx, transcript);
  } finally {
    await stopInProcessDaemon(ctx, options.keepBase === true ? { keepBase: true } : {});
  }
}

describe("the wiring (DR-0068 §4)", () => {
  test("the tabs looking at the session are told, from any device; one not looking, or no more, is not", async () => {
    await withDaemon(async (ctx) => {
      const a = await userConn(ctx);
      const b = await userConn(ctx);
      for (const tab of [a, b]) {
        await tab.requestOk({ op: "session_status_subscribe", sid: SID });
        const first = await tab.readEventUntil("comments");
        expect(first.ev.read_marks).toEqual([]);
      }
      // Another tab (another device), looking at nothing, marks it.
      const marker = await userConn(ctx);
      await marker.requestOk({ op: "read_mark_set", session_id: SID, uuid: MESSAGE, read: true });
      for (const tab of [a, b]) {
        const told = await tab.readEventUntil("read_mark");
        expect(told.ev.mark).toEqual(mark(MESSAGE, true));
      }
      // The same again tells nothing: the next told is the mark taken off.
      await marker.requestOk({ op: "read_mark_set", session_id: SID, uuid: MESSAGE, read: true });
      await b.requestOk({ op: "session_status_unsubscribe", sid: SID });
      await marker.requestOk({ op: "read_mark_set", session_id: SID, uuid: MESSAGE, read: false });
      const off = await a.readEventUntil("read_mark");
      expect(off.ev.mark).toEqual(mark(MESSAGE, false));
      expect((await marker.pendingEvents()).filter((ev) => "ev" in ev)).toEqual([]);
      expect((await b.pendingEvents()).filter((ev) => "ev" in ev && ev.ev === "read_mark")).toEqual(
        [],
      );
    });
  });

  test("a daemon started again tells the marks its file holds", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-t-"));
    try {
      await withDaemon(
        async (ctx) => {
          const tab = await userConn(ctx);
          await tab.requestOk({ op: "read_mark_set", session_id: SID, uuid: MESSAGE, read: true });
          await tab.requestOk({ op: "read_mark_set", session_id: SID, uuid: OTHER, read: true });
          await tab.requestOk({ op: "read_mark_set", session_id: SID, uuid: OTHER, read: false });
        },
        { base, keepBase: true },
      );
      await withDaemon(
        async (ctx) => {
          const tab = await userConn(ctx);
          await tab.requestOk({ op: "session_status_subscribe", sid: SID });
          const first = await tab.readEventUntil("comments");
          expect(first.ev.read_marks).toEqual([mark(MESSAGE, true)]);
        },
        { base },
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("a mark sends nothing to the session nor writes its transcript, and leaves the unread says as they are", async () => {
    await withDaemon(async (ctx, transcript) => {
      const module = await liveSessionConn(ctx, SID, { transcript_path: transcript });
      const watcher = await userConn(ctx);
      await watcher.requestOk({ op: "subscribe" });
      // A say of the session's, unread: its row in the transcript, pushed.
      const content = [toolUseBlock(CCMSG_TOOLS.say, { text: "終わりました" }, "toolu_say")];
      const row = stampRows(
        `${line(assistantContentRow(content, { timestamp: new Date().toISOString() }))}\n`,
      );
      fs.appendFileSync(transcript, row.text);
      const sayUuid = row.uuids[0] ?? "";
      await module.requestOk({
        op: "transcript_push",
        rows: [
          {
            uuid: sayUuid,
            door: "response",
            message: { type: "assistant", role: "assistant", content },
          },
        ],
      });
      await watcher.readEventUntil("say_unread", (ev) => ev.says.length > 0);
      expect(unreadSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual(["toolu_say"]);
      const permitsBefore = unreadPermits(ctx.daemon.permits);
      const before = fs.readFileSync(transcript, "utf8");
      await module.pendingEvents();
      const tab = await userConn(ctx);
      await tab.requestOk({ op: "read_mark_set", session_id: SID, uuid: MESSAGE, read: true });
      await tab.requestOk({ op: "read_mark_set", session_id: SID, uuid: sayUuid, read: true });
      expect(await module.pendingEvents()).toEqual([]);
      expect(fs.readFileSync(transcript, "utf8")).toBe(before);
      expect(unreadSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual(["toolu_say"]);
      expect(unreadPermits(ctx.daemon.permits)).toEqual(permitsBefore);
      // And the say read leaves the responses' marks.
      await tab.requestOk({ op: "say_read", ids: ["toolu_say"] });
      const tabLooking = await userConn(ctx);
      await tabLooking.requestOk({ op: "session_status_subscribe", sid: SID });
      const first = await tabLooking.readEventUntil("comments");
      expect(first.ev.read_marks).toEqual([mark(MESSAGE, true), mark(sayUuid, true)]);
    });
  });
});
