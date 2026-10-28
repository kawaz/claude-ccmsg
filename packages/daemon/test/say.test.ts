// The say tool's effects on the daemon (DR-0045 §6 / §7): the daemon speaks
// the `say` tool calls it finds in the rows a session's module pushes, and
// holds which of the main thread's says the person has not read.
//
// 何を保証するか (各 test の doc comment 参照):
//   - push で受けた say の tool_use を、tool_use の id ごとに 1 度だけ、読み上げ
//     辞書を当てて `[CCMSG_SAY_BIN, "--", 本文]` で発声する。発声は直列
//   - 追いつきでファイルから読んだ行と、読み済みの行の push (compaction の
//     再 push) では発声しない
//   - subagent の say も発声する。入力が tool の形に合わない呼び出しは発声しない
//   - 未読は live のセッションの main thread の say。ev:"say_unread" で user role
//     に全件届き、say_read で既読になって全タブに更新が届く。二度押しは無変化、
//     知らない id は全部断る。既読はファイルに書いてから答える
//   - session が live でなくなると、その say は未読から消える
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject } from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { assistantContentRow, line, toolUseBlock } from "../../protocol/test/transcript-rows.ts";
import { loadSayUnreadStore, markSaysRead, unreadSays } from "../src/say-unread.ts";
import {
  fixtureDir,
  liveSessionConn,
  sessionConn,
  stampRows,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";

const SAY = "mcp__ccmsg-v1__say";
const A = "5a900000-0000-4000-8000-000000000001";
const B = "5a900000-0000-4000-8000-000000000002";

const tmpDir = perTestTmpDir();

/** A speech binary that writes each argv to `file`. */
const recordArgv = (file: string): string =>
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(file)}\n`;

/** A daemon in this process that speaks through the binary `script` makes,
 * and what was spoken once its speeches ended. */
async function withSpeakingDaemon(
  run: (ctx: InProcessDaemon, spoken: () => Promise<string>, dir: string) => Promise<void>,
  script: (file: string) => string = recordArgv,
): Promise<void> {
  const work = tmpDir("ccmsg-say-");
  const spokenFile = path.join(work, "spoken");
  const speech = writeMockBin(path.join(work, "say"), script(spokenFile));
  const ctx = await startInProcessDaemon({ env: { CCMSG_SAY_BIN: speech } });
  const dir = fixtureDir("say");
  try {
    await run(
      ctx,
      async () => {
        await ctx.daemon.speaker.idle();
        return fs.existsSync(spokenFile) ? fs.readFileSync(spokenFile, "utf8") : "";
      },
      dir,
    );
  } finally {
    await stopInProcessDaemon(ctx);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Push one row of `session`'s conversation, an assistant turn that calls
 * say, as its module does (`e.message`). */
async function pushSay(
  session: TestClient,
  input: JsonObject,
  id: string,
  fields: { uuid?: string; agent_id?: string } = {},
): Promise<void> {
  await session.requestOk({
    op: "transcript_push",
    rows: [
      {
        uuid: fields.uuid ?? crypto.randomUUID(),
        door: "response",
        ...(fields.agent_id !== undefined ? { agent_id: fields.agent_id } : {}),
        message: { type: "assistant", role: "assistant", content: [toolUseBlock(SAY, input, id)] },
      },
    ],
  });
}

/** The transcript line of an assistant turn that calls say, written now. */
function sayLine(text: string, id: string, fields: JsonObject = {}): string {
  return `${line(
    assistantContentRow([toolUseBlock(SAY, { text }, id)], {
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  )}\n`;
}

/** A say written to the session's file and pushed, as Claude Code and the
 * module do; resolves once the daemon has read it. */
async function writeAndPushSay(
  session: TestClient,
  file: string,
  text: string,
  id: string,
): Promise<void> {
  const row = stampRows(sayLine(text, id));
  fs.appendFileSync(file, row.text);
  await pushSay(session, { text }, id, { uuid: row.uuids[0] ?? "" });
}

describe("say: the daemon speaks the pushed say calls", () => {
  // 何を保証するか: push の行の say の tool_use を、辞書を当てて `--` の後に
  // 渡して発声する。同じ id の二度目の push (書かれる前の二重 push) では
  // 発声し直さない。`-` で始まる本文も say の option にならない。
  test("speaks each call once, through the reading dictionary, after --", async () => {
    await withSpeakingDaemon(async (ctx, spoken, dir) => {
      fs.mkdirSync(ctx.daemon.paths.configDir, { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.sayDictionary, "push\tプッシュ\n");
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      await pushSay(session, { text: "daemon に push した" }, "toolu_a");
      await pushSay(session, { text: "daemon に push した" }, "toolu_a");
      await pushSay(session, { text: "-v です" }, "toolu_b");
      expect(await spoken()).toBe("-- デーモン に プッシュ した\n-- -v です\n");
    });
  });

  // 何を保証するか: 発声は直列。2 つの say が続けて来ても、前の発声が終わって
  // から次が始まる (声が重ならない)。
  test("speaks one call after another", async () => {
    await withSpeakingDaemon(
      async (ctx, spoken) => {
        const session = await sessionConn(ctx, A);
        await pushSay(session, { text: "one" }, "toolu_1");
        await pushSay(session, { text: "two" }, "toolu_2");
        expect(await spoken()).toBe("start -- one\nend\nstart -- two\nend\n");
      },
      // The pause stands for a speech that takes a while; it is the speech,
      // not a wait for something to happen.
      (file) =>
        `#!/bin/sh\nprintf 'start %s\\n' "$*" >> ${JSON.stringify(file)}\nsleep 0.2\necho end >> ${JSON.stringify(file)}\n`,
    );
  });

  // 何を保証するか: 追いつき (live になった時のファイルの頭からの読み) で見た
  // say は古い行なので発声しない。同じ行が compaction で同じ uuid のまま
  // もう一度 push されても、読み済みなので発声しない。
  test("speaks no call the catch-up read, nor a row pushed again after it was read", async () => {
    await withSpeakingDaemon(async (ctx, spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      const old = stampRows(sayLine("昔の say", "toolu_old"));
      fs.writeFileSync(file, old.text);
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      await pushSay(session, { text: "昔の say" }, "toolu_old", { uuid: old.uuids[0] ?? "" });
      await writeAndPushSay(session, file, "新しい say", "toolu_new");
      expect(await spoken()).toBe("-- 新しい say\n");
    });
  });

  // 何を保証するか: subagent / teammate の say も発声する (§6)。入力が tool の
  // 形に合わない呼び出しは、module が断ったのと同じく何も起こさない。
  test("speaks a subagent's call, and no call whose input is not the tool's", async () => {
    await withSpeakingDaemon(async (ctx, spoken) => {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "subagent から" }, "toolu_sub", { agent_id: "a1" });
      await pushSay(session, {}, "toolu_bad");
      await pushSay(session, { text: 3 }, "toolu_bad2");
      expect(await spoken()).toBe("-- subagent から\n");
    });
  });

  // 何を保証するか: 辞書ファイルの読めない行はその行だけ飛ばし、daemon.log に
  // 1 行書く。発声は残りの行で続く。
  test("a line of the dictionary that does not read is skipped and logged", async () => {
    await withSpeakingDaemon(async (ctx, spoken) => {
      fs.mkdirSync(ctx.daemon.paths.configDir, { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.sayDictionary, "broken line\npush\tプッシュ\n");
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "push" }, "toolu_1");
      expect(await spoken()).toBe("-- プッシュ\n");
      expect(fs.readFileSync(ctx.daemon.paths.log, "utf8")).toContain(
        "say-dictionary.tsv:1: an entry is `word<TAB>reading`",
      );
    });
  });
});

describe("say: what the person has not read", () => {
  // 何を保証するか: live のセッションの main thread の say が未読として
  // ev:"say_unread" で届く (購読時は空でも届く)。sidechain の行の say は
  // 未読に入らない。
  test("the main thread's says of a live session are unread", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      const first = await user.readEventUntil("say_unread", () => true);
      expect(first.ev.says).toEqual([]);

      const sidechain = stampRows(sayLine("横から", "toolu_side", { isSidechain: true }));
      fs.appendFileSync(file, sidechain.text);
      await writeAndPushSay(session, file, "終わりました", "toolu_1");
      const { ev } = await user.readEventUntil("say_unread", (e) => e.says.length > 0);
      expect(ev.says).toMatchObject([{ session_id: A, tool_use_id: "toolu_1" }]);
      expect(unreadSays(ctx.daemon.sayUnread).map((s) => s.tool_use_id)).toEqual(["toolu_1"]);
    });
  });

  // 何を保証するか: say_read は tool_use の id で既読にし、ファイルに書いてから
  // 答え、全タブに更新を送る。二度押しは成功して何も変えない。未読でも既読でも
  // ない id が混ざると、どれも既読にせず invalid_args で断る。session role は断る。
  test("say_read marks by tool_use id, writes the file first, and refuses an unknown id", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const reader = await userConn(ctx);
      const other = await userConn(ctx);
      await other.requestOk({ op: "subscribe" });
      await writeAndPushSay(session, file, "one", "toolu_1");
      await writeAndPushSay(session, file, "two", "toolu_2");
      await other.readEventUntil("say_unread", (e) => e.says.length === 2);

      expect(await reader.request({ op: "say_read", ids: ["toolu_1", "toolu_x"] })).toEqual({
        ok: false,
        error: { code: "invalid_args", msg: "no say with id toolu_x" },
      });
      expect(unreadSays(ctx.daemon.sayUnread)).toHaveLength(2);

      expect(await reader.requestOk({ op: "say_read", ids: ["toolu_1"] })).toEqual({
        ok: true,
        ids: ["toolu_1"],
      });
      expect(fs.readFileSync(ctx.daemon.paths.sayRead, "utf8")).toContain('"read":["toolu_1"]');
      const { ev } = await other.readEventUntil("say_unread", (e) => e.says.length === 1);
      expect(ev.says.map((s) => s.tool_use_id)).toEqual(["toolu_2"]);

      expect(await reader.requestOk({ op: "say_read", ids: ["toolu_1"] })).toEqual({
        ok: true,
        ids: ["toolu_1"],
      });
      expect(await session.request({ op: "say_read", ids: ["toolu_2"] })).toEqual({
        ok: false,
        error: { code: "bad_request", msg: "op 'say_read' requires user role" },
      });
    });
  });

  // 何を保証するか: セッションが live でなくなると (module の run が去る)、その
  // say は未読から消える。live のままの別セッションの say は残る。
  test("a session no longer live takes its says out of the unread", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const fileA = path.join(dir, `${A}.jsonl`);
      const fileB = path.join(dir, `${B}.jsonl`);
      fs.writeFileSync(fileA, "");
      fs.writeFileSync(fileB, "");
      const a = await liveSessionConn(ctx, A, { transcript_path: fileA });
      const b = await liveSessionConn(ctx, B, { transcript_path: fileB });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      await writeAndPushSay(a, fileA, "a", "toolu_a");
      await writeAndPushSay(b, fileB, "b", "toolu_b");
      await user.readEventUntil("say_unread", (e) => e.says.length === 2);
      await a.end();
      const { ev } = await user.readEventUntil("say_unread", (e) => e.says.length === 1);
      expect(ev.says.map((s) => s.tool_use_id)).toEqual(["toolu_b"]);
    });
  });
});

describe("say-read.json", () => {
  // 何を保証するか: 既読と since はファイルから読み戻せる (daemon の再起動で
  // 既読が失われない)。since より前の say は既読とみなす。
  test("the read ids and since read back, and a say before since is read", async () => {
    const file = path.join(tmpDir("ccmsg-say-read-"), "say-read.json");
    const log = { warn: (): void => {} };
    const store = loadSayUnreadStore(file, log, () => new Date("2026-10-28T00:00:00.000Z"));
    const says = new Map([
      ["toolu_old", "2026-10-27T23:59:59.000Z"],
      ["toolu_1", "2026-10-28T00:00:01.000Z"],
      ["toolu_2", "2026-10-28T00:00:02.000Z"],
    ]);
    store.says.set(A, says);
    expect(unreadSays(store).map((s) => s.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    expect(await markSaysRead(store, ["toolu_old", "toolu_1"])).toEqual({ kind: "read" });

    const again = loadSayUnreadStore(file, log, () => new Date("2026-10-29T00:00:00.000Z"));
    expect(again.since).toBe("2026-10-28T00:00:00.000Z");
    again.says.set(A, says);
    expect(unreadSays(again).map((s) => s.tool_use_id)).toEqual(["toolu_2"]);
  });

  // 何を保証するか: 読めないファイルは今を since にして始め直し、log に書く
  // (古い say で 🔔 が溢れない)。
  test("a file that does not read starts over from now, said in the log", () => {
    const file = path.join(tmpDir("ccmsg-say-read-"), "say-read.json");
    fs.writeFileSync(file, "{ not json");
    const warned: string[] = [];
    const store = loadSayUnreadStore(
      file,
      { warn: (m) => warned.push(m) },
      () => new Date("2026-10-28T00:00:00.000Z"),
    );
    expect({ since: store.since, read: [...store.read] }).toEqual({
      since: "2026-10-28T00:00:00.000Z",
      read: [],
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("starting over");
  });
});
