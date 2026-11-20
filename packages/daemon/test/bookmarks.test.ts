// The person's bookmarks of Timeline items (DR-0058).
// 何を保証するか:
//   - bookmark_set はセッションごとの uuid の列を付けた順に持ち、ファイルに書いて
//     から答え、変わった時だけ全タブ (user role の購読者) に ev:"bookmarks" を送る。
//     session role は断る。購読の時は空でも送る
//   - bookmarks.json は読み戻せ、読めないファイルは空から始めてログに出す
//   - bookmark_rows はそのセッションのブックマークの行を transcript の順で返す。
//     行の後に、次の行と、その行の tool の呼び出しの結果の行を付ける。transcript
//     に無い uuid は返さない。全部が揃った行は覚えて読み直さない。結果がまだ無い
//     行はあるところまで返し、次に読み直す
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CCMSG_TOOLS } from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { bookmarkRows, loadBookmarkStore, setBookmark } from "../src/bookmarks.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
} from "./helpers.ts";

const A = "b0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const tmpDir = perTestTmpDir();

async function withDaemon(run: (ctx: InProcessDaemon) => Promise<void>): Promise<void> {
  const ctx = await startInProcessDaemon();
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

function uuid(n: number): string {
  return `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A transcript: a prompt (1), an answer that calls Bash (2), an unrelated
 * prompt (3), the Bash result (4), an answer (5). */
function transcript(): string[] {
  return [
    line(userContentRow("hi", { uuid: uuid(1) })),
    line(
      assistantContentRow([toolUseBlock("Bash", { command: "ls" }, "toolu_ls")], { uuid: uuid(2) }),
    ),
    line(userContentRow("meanwhile", { uuid: uuid(3) })),
    line(
      userContentRow([toolResultBlock("a.txt", { tool_use_id: "toolu_ls" })], { uuid: uuid(4) }),
    ),
    line(
      assistantContentRow(
        [{ type: "tool_use", id: "toolu_say", name: CCMSG_TOOLS.say, input: { text: "x" } }],
        {
          uuid: uuid(5),
        },
      ),
    ),
  ];
}

/** The `i`th of `lines`, which the test wrote. */
function nth(lines: readonly string[], i: number): string {
  const found = lines[i];
  if (found === undefined) throw new Error(`no line ${String(i)}`);
  return found;
}

/** A scan of `lines` that counts its reads. */
function scanOf(lines: () => readonly string[]): {
  scan: (take: (line: string) => void) => Promise<void>;
  reads: () => number;
} {
  let reads = 0;
  return {
    scan: async (take) => {
      reads += 1;
      for (const l of lines()) take(l);
    },
    reads: () => reads,
  };
}

describe("bookmark_set", () => {
  test("keeps each session's uuids in the order set, writes the file first, and tells every tab of a change", async () => {
    await withDaemon(async (ctx) => {
      const setter = await userConn(ctx);
      const other = await userConn(ctx);
      await other.requestOk({ op: "subscribe" });
      const first = await other.readEventUntil("bookmarks");
      expect(first.ev.sessions).toEqual([]);

      expect(await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u2", on: true })).toEqual({
        ok: true,
      });
      await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u1", on: true });
      await setter.requestOk({ op: "bookmark_set", sid: B, uuid: "u9", on: true });
      expect(JSON.parse(fs.readFileSync(ctx.daemon.paths.bookmarks, "utf8"))).toEqual({
        [A]: ["u2", "u1"],
        [B]: ["u9"],
      });
      const told = await other.readEventUntil("bookmarks", (e) => e.sessions.length === 2);
      expect(told.ev.sessions).toEqual([
        { session_id: A, uuids: ["u2", "u1"] },
        { session_id: B, uuids: ["u9"] },
      ]);

      await setter.requestOk({ op: "bookmark_set", sid: B, uuid: "u9", on: false });
      const off = await other.readEventUntil("bookmarks", (e) => e.sessions.length === 1);
      expect(off.ev.sessions).toEqual([{ session_id: A, uuids: ["u2", "u1"] }]);
      expect(JSON.parse(fs.readFileSync(ctx.daemon.paths.bookmarks, "utf8"))).toEqual({
        [A]: ["u2", "u1"],
      });
    });
  });

  test("setting what is set already changes nothing and tells no tab", async () => {
    await withDaemon(async (ctx) => {
      const setter = await userConn(ctx);
      await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u1", on: true });
      const other = await userConn(ctx);
      await other.requestOk({ op: "subscribe" });
      await other.readEventUntil("bookmarks");
      await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u1", on: true });
      await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u7", on: false });
      // The next push is the one of the next change: the two above sent none.
      await setter.requestOk({ op: "bookmark_set", sid: A, uuid: "u2", on: true });
      const { seen } = await other.readEventUntil("bookmarks");
      expect(seen.filter((ev) => "ev" in ev && ev.ev === "bookmarks")).toEqual([
        { ev: "bookmarks", sessions: [{ session_id: A, uuids: ["u1", "u2"] }] },
      ]);
    });
  });

  test("a session is refused: a bookmark is the person's", async () => {
    await withDaemon(async (ctx) => {
      const session = await sessionConn(ctx, A);
      expect(await session.request({ op: "bookmark_set", sid: A, uuid: "u1", on: true })).toEqual({
        ok: false,
        error: { code: "bad_request", msg: "op 'bookmark_set' requires user role" },
      });
      expect(await session.request({ op: "bookmark_rows", sid: A })).toEqual({
        ok: false,
        error: { code: "bad_request", msg: "op 'bookmark_rows' requires user role" },
      });
    });
  });
});

describe("bookmarks.json", () => {
  test("reads back, and a file that does not read starts empty, said in the log", async () => {
    const dir = tmpDir("ccmsg-bookmarks-");
    const file = path.join(dir, "bookmarks.json");
    const warned: string[] = [];
    const log = { warn: (msg: string) => warned.push(msg) };
    const store = loadBookmarkStore(file, log);
    expect(store.sessions.size).toBe(0);
    expect(warned).toEqual([]);
    await setBookmark(store, A, "u1", true);
    await setBookmark(store, A, "u2", true);
    expect([...loadBookmarkStore(file, log).sessions]).toEqual([[A, ["u1", "u2"]]]);

    fs.writeFileSync(file, "{not json");
    expect(loadBookmarkStore(file, log).sessions.size).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("starting empty");
  });
});

describe("bookmark_rows", () => {
  test("hands each row with its next line and its calls' results, in file order", async () => {
    const store = loadBookmarkStore(path.join(tmpDir("ccmsg-bookmarks-"), "b.json"), {
      warn() {},
    });
    const lines = transcript();
    await setBookmark(store, A, uuid(5), true);
    await setBookmark(store, A, uuid(2), true);
    await setBookmark(store, A, uuid(1), true);
    await setBookmark(store, A, "b0000000-0000-4000-8000-0000000000ff", true);
    const { scan, reads } = scanOf(() => lines);
    const rows = await bookmarkRows(store, A, scan);
    expect(rows.map((row) => row.uuid)).toEqual([uuid(1), uuid(2), uuid(5)]);
    expect(rows[0]?.lines).toEqual([nth(lines, 0), nth(lines, 1)]);
    // The Bash call's row: the next line, then the result's line further on.
    expect(rows[1]?.lines).toEqual([nth(lines, 1), nth(lines, 2), nth(lines, 3)]);
    expect(reads()).toBe(1);
  });

  test("keeps the rows read whole and reads only for the others", async () => {
    const store = loadBookmarkStore(path.join(tmpDir("ccmsg-bookmarks-"), "b.json"), {
      warn() {},
    });
    const lines = transcript();
    await setBookmark(store, A, uuid(1), true);
    const { scan, reads } = scanOf(() => lines);
    await bookmarkRows(store, A, scan);
    await bookmarkRows(store, A, scan);
    expect(reads()).toBe(1);
    await setBookmark(store, A, uuid(3), true);
    const rows = await bookmarkRows(store, A, scan);
    expect(rows.map((row) => row.uuid)).toEqual([uuid(1), uuid(3)]);
    expect(reads()).toBe(2);
  });

  test("a row still waiting for its result at the end of the file is answered as it is, and read again", async () => {
    const store = loadBookmarkStore(path.join(tmpDir("ccmsg-bookmarks-"), "b.json"), {
      warn() {},
    });
    const lines = transcript().slice(0, 3);
    await setBookmark(store, A, uuid(2), true);
    const { scan, reads } = scanOf(() => lines);
    expect((await bookmarkRows(store, A, scan))[0]?.lines).toEqual([nth(lines, 1), nth(lines, 2)]);
    lines.push(...transcript().slice(3));
    expect((await bookmarkRows(store, A, scan))[0]?.lines).toHaveLength(3);
    expect(reads()).toBe(2);
    await bookmarkRows(store, A, scan);
    expect(reads()).toBe(2);
  });

  test("over the wire: the session's transcript, for the person", async () => {
    await withDaemon(async (ctx) => {
      const dir = tmpDir("ccmsg-bookmarks-");
      const file = path.join(dir, `${A}.jsonl`);
      const lines = transcript();
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "bookmark_set", sid: A, uuid: uuid(3), on: true });
      expect(await user.requestOk({ op: "bookmark_rows", sid: A })).toEqual({
        ok: true,
        sid: A,
        rows: [{ uuid: uuid(3), lines: [nth(lines, 2), nth(lines, 3)] }],
      });
      // A session whose transcript the daemon does not find is refused.
      const unknown = await user.request({ op: "bookmark_rows", sid: B });
      expect(unknown.ok).toBe(false);
    });
  });
});
