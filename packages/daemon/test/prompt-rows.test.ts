// The rows of a session's transcript that may be the person's prompts, for
// the webui's 👤 filter (prompt_rows, DR-0058 §11).
// 何を保証するか:
//   - transcript の順で、uuid を持ち tool の結果を持たない type:"user" の行を
//     その行だけで返す (どれが発言かは webui が決める)。assistant の行、tool の
//     結果の行、uuid の無い行、読めない行は返さない
//   - 読んだ所 (最後の完全な行の終わり) を覚え、次は足された行だけを読む。
//     書きかけの最後の行は次に読む
//   - transcript が別のファイルに替わった (path か inode が違う) 時と、覚えた所
//     より短くなった時は先頭から読み直し、古いファイルの行を返さない
//   - 覚える行は合計の大きさで上限を持ち、超えたら最も前に聞かれたセッションから
//     落とす。落ちたセッションは次に聞かれた時に先頭から読み直す
//   - 同じセッションへの要求が重なっても、同じ行を 2 回足さない
//   - since を付けると、timestamp がその時刻以降の行だけを返す (時刻の無い行・
//     読めない行は返さない)。読みと保持は付けない時と同じで、後の since 無しの
//     要求は全部の行を返す (入力欄の未確認の送信の照合、DR-0035 §5)
//   - op は user role だけで、session role は断る
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  imageBlock,
  line,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import {
  createPromptRowsStore,
  promptRows,
  type TranscriptFile,
  type TranscriptScanFrom,
} from "../src/prompt-rows.ts";
import { scanTranscriptLines } from "../src/transcript.ts";
import { sessionConn, startInProcessDaemon, stopInProcessDaemon, userConn } from "./helpers.ts";

const A = "c0000000-0000-4000-8000-00000000000a";
const B = "c0000000-0000-4000-8000-00000000000b";
const tmpDir = perTestTmpDir();

function uuid(n: number): string {
  return `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A prompt (1), an answer calling Bash (2), its result (3), an image
 * prompt (4), a `! <command>` (5), an answer (6). */
function transcript(): string[] {
  return [
    line(userContentRow("hi", { uuid: uuid(1) })),
    line(
      assistantContentRow([toolUseBlock("Bash", { command: "ls" }, "toolu_ls")], { uuid: uuid(2) }),
    ),
    line(
      userContentRow([toolResultBlock("a.txt", { tool_use_id: "toolu_ls" })], { uuid: uuid(3) }),
    ),
    line(userContentRow([textBlock("look"), imageBlock()], { uuid: uuid(4) })),
    line(userContentRow("<bash-input>git status</bash-input>", { uuid: uuid(5) })),
    line(assistantContentRow([textBlock("done")], { uuid: uuid(6) })),
  ];
}

function nth(lines: readonly string[], i: number): string {
  const found = lines[i];
  if (found === undefined) throw new Error(`no line ${String(i)}`);
  return found;
}

/** A transcript file the test writes, and the scan of it the server uses. */
function fileOf(dir: string, name: string, lines: readonly string[], tail = "") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join("\n")}\n${tail}`);
  const starts: number[] = [];
  const scan: TranscriptScanFrom = (start, take) => {
    starts.push(start);
    return scanTranscriptLines(file, undefined, take, { start });
  };
  const now = (): TranscriptFile => {
    const stat = fs.statSync(file);
    return { path: file, dev: stat.dev, ino: stat.ino, size: stat.size };
  };
  return { file, scan, now, starts };
}

describe("prompt_rows", () => {
  test("the user rows with no tool result, each alone, in file order", async () => {
    const lines = transcript();
    const { scan, now } = fileOf(tmpDir("ccmsg-prompt-rows-"), "a.jsonl", lines);
    const rows = await promptRows(createPromptRowsStore(), A, now(), scan);
    expect(rows).toEqual([
      { uuid: uuid(1), lines: [nth(lines, 0)] },
      { uuid: uuid(4), lines: [nth(lines, 3)] },
      { uuid: uuid(5), lines: [nth(lines, 4)] },
    ]);
  });

  test("reads only what was added since, the half-written last line next time", async () => {
    const lines = transcript();
    const added = line(userContentRow("next", { uuid: uuid(7) }));
    const { file, scan, now, starts } = fileOf(
      tmpDir("ccmsg-prompt-rows-"),
      "a.jsonl",
      lines,
      added.slice(0, 20),
    );
    const store = createPromptRowsStore();
    expect(await promptRows(store, A, now(), scan)).toHaveLength(3);
    const firstEnd = fs.statSync(file).size - 20;
    fs.appendFileSync(file, `${added.slice(20)}\n`);
    const rows = await promptRows(store, A, now(), scan);
    expect(rows.map((row) => row.uuid)).toEqual([uuid(1), uuid(4), uuid(5), uuid(7)]);
    expect(rows.at(-1)?.lines).toEqual([added]);
    expect(starts).toEqual([0, firstEnd]);
    // Nothing added: reads from the end, and answers the same.
    expect(await promptRows(store, A, now(), scan)).toEqual(rows);
    expect(starts.at(-1)).toBe(fs.statSync(file).size);
  });

  test("another file for the session is read from its start, without the old rows", async () => {
    const dir = tmpDir("ccmsg-prompt-rows-");
    const store = createPromptRowsStore();
    const old = fileOf(dir, "old.jsonl", transcript());
    await promptRows(store, A, old.now(), old.scan);
    const other = [line(userContentRow("after compact", { uuid: uuid(9) }))];
    const now = fileOf(dir, "new.jsonl", other);
    const rows = await promptRows(store, A, now.now(), now.scan);
    expect(rows).toEqual([{ uuid: uuid(9), lines: [nth(other, 0)] }]);
    expect(now.starts).toEqual([0]);
  });

  test("the same path made anew (another inode) or shorter is read from its start", async () => {
    const dir = tmpDir("ccmsg-prompt-rows-");
    const store = createPromptRowsStore();
    const first = fileOf(dir, "a.jsonl", transcript());
    await promptRows(store, A, first.now(), first.scan);
    // Replaced by another file at the same path (a rename over it).
    const replacement = [line(userContentRow("replaced", { uuid: uuid(8) }))];
    const tmp = path.join(dir, "a.jsonl.tmp");
    fs.writeFileSync(tmp, `${replacement.join("\n")}\n`);
    fs.renameSync(tmp, first.file);
    expect(await promptRows(store, A, first.now(), first.scan)).toEqual([
      { uuid: uuid(8), lines: [nth(replacement, 0)] },
    ]);
    // Rewritten in place, shorter than what was read.
    const shorter = [line(userContentRow("s", { uuid: uuid(10) }))];
    const held = store.sessions.get(A);
    fs.writeFileSync(first.file, `${shorter.join("\n")}\n`);
    expect(fs.statSync(first.file).size).toBeLessThan(held?.end ?? 0);
    expect(await promptRows(store, A, first.now(), first.scan)).toEqual([
      { uuid: uuid(10), lines: [nth(shorter, 0)] },
    ]);
    expect(first.starts).toEqual([0, 0, 0]);
  });

  test("past the size bound the least recently asked session is dropped, and read anew", async () => {
    const dir = tmpDir("ccmsg-prompt-rows-");
    const a = fileOf(dir, "a.jsonl", transcript());
    const b = fileOf(dir, "b.jsonl", transcript());
    const rowsBytes = (await promptRows(createPromptRowsStore(), A, a.now(), a.scan)).reduce(
      (sum, row) => sum + Buffer.byteLength(nth(row.lines, 0)),
      0,
    );
    a.starts.length = 0;
    // Room for one session's rows, not two.
    const store = createPromptRowsStore(rowsBytes + rowsBytes / 2);
    await promptRows(store, A, a.now(), a.scan);
    await promptRows(store, B, b.now(), b.scan);
    expect([...store.sessions.keys()]).toEqual([B]);
    expect(store.bytes).toBe(rowsBytes);
    expect(await promptRows(store, A, a.now(), a.scan)).toHaveLength(3);
    expect(a.starts).toEqual([0, 0]);
    expect([...store.sessions.keys()]).toEqual([A]);
    // One session larger than the bound is still answered and kept.
    const tight = createPromptRowsStore(1);
    expect(await promptRows(tight, A, a.now(), a.scan)).toHaveLength(3);
    expect([...tight.sessions.keys()]).toEqual([A]);
  });

  test("requests at once for one session add each row once", async () => {
    const lines = transcript();
    const { scan, now } = fileOf(tmpDir("ccmsg-prompt-rows-"), "a.jsonl", lines);
    const store = createPromptRowsStore();
    const [first, second] = await Promise.all([
      promptRows(store, A, now(), scan),
      promptRows(store, A, now(), scan),
    ]);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
    // The second read took up where the first ended: the size is counted once.
    expect(store.bytes).toBe(store.sessions.get(A)?.bytes ?? -1);
    expect(store.reading.size).toBe(0);
  });

  test("since: the rows written at or after it, none without a time; the rest stay kept", async () => {
    const { timestamp: _dropped, ...noTime } = userContentRow("no time", { uuid: uuid(3) });
    const lines = [
      line(userContentRow("before", { uuid: uuid(1), timestamp: "2026-11-22T01:00:00.000Z" })),
      line(userContentRow("at", { uuid: uuid(2), timestamp: "2026-11-22T01:00:05.000Z" })),
      line(noTime),
      line(userContentRow("bad time", { uuid: uuid(4), timestamp: "not a time" })),
      line(userContentRow("after", { uuid: uuid(5), timestamp: "2026-11-22T01:00:09.000Z" })),
    ];
    const { scan, now, starts } = fileOf(tmpDir("ccmsg-prompt-rows-"), "a.jsonl", lines);
    const store = createPromptRowsStore();
    const since = Date.parse("2026-11-22T01:00:05.000Z");
    expect(await promptRows(store, A, now(), scan, since)).toEqual([
      { uuid: uuid(2), lines: [nth(lines, 1)] },
      { uuid: uuid(5), lines: [nth(lines, 4)] },
    ]);
    // A row whose time does not read is still a candidate for the 👤 filter.
    expect((await promptRows(store, A, now(), scan)).map((row) => row.uuid)).toEqual([
      uuid(1),
      uuid(2),
      uuid(3),
      uuid(4),
      uuid(5),
    ]);
    expect(starts).toEqual([0, fs.statSync(now().path).size]);
  });

  test("over the wire: the session's transcript, for the person only", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const dir = tmpDir("ccmsg-prompt-rows-");
      const file = path.join(dir, `${A}.jsonl`);
      const lines = transcript();
      fs.writeFileSync(file, `${lines.join("\n")}\n`);
      const session = await sessionConn(ctx, A, { transcript_path: file });
      expect(await session.request({ op: "prompt_rows", sid: A })).toEqual({
        ok: false,
        error: { code: "bad_request", msg: "op 'prompt_rows' requires user role" },
      });
      const user = await userConn(ctx);
      const reply = await user.requestOk({ op: "prompt_rows", sid: A });
      expect(reply.rows.map((row) => row.uuid)).toEqual([uuid(1), uuid(4), uuid(5)]);
      // Every row of transcript() carries the same time: one after it leaves none.
      const later = await user.requestOk({
        op: "prompt_rows",
        sid: A,
        since: "2999-01-01T00:00:00.000Z",
      });
      expect(later.rows).toEqual([]);
      const unknown = await user.request({ op: "prompt_rows", sid: B });
      expect(unknown.ok).toBe(false);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
