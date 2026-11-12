// The say tool's effects on the daemon (DR-0045 §6 / §7): the daemon speaks
// the `say` tool calls it finds in the rows a session's module pushes, and
// holds which of the main thread's says the person has not read.
//
// 何を保証するか (各 test の doc comment 参照):
//   - push で受けた say の tool_use を、tool_use の id ごとに 1 度だけ発声する。
//     発声は config の say_command に JSON (kind / session_id / 元の文 text /
//     読み上げ辞書を当てた spoken) を stdin で渡す。発声は直列
//   - 追いつきでファイルから読んだ行と、読み済みの行の push (compaction の
//     再 push) では発声しない
//   - subagent の say も発声する。入力が tool の形に合わない呼び出しは発声しない
//   - daemon に webui の URL があれば、発声コマンドにその say のバブルを開く
//     URL を渡す (main の say はその行の位置、subagent / teammate の say は 🔔 の
//     フィルタ)
//   - 未読は live のセッションの main thread の say。ev:"say_unread" で user role
//     に全件届き、say_read で既読になって全タブに更新が届く。二度押しは無変化、
//     知らない id は全部断る。既読はファイルに書いてから答える
//   - session が live でなくなると、その say は未読から消える
//   - live でないセッションの say は、そのセッションの status の一回読み (TL を
//     開いた時) で数え、未読に入り、say_read で既読にできる。live に
//     なったら fold に引き継ぎ、二重に数えない
//   - notification_list はそのセッションの全 say (main と agent の transcript の、既読も
//     含む) を時刻順に返す。初回だけ全部読み、以後は fold の行と push の差分で
//     増える (読み直さない)。見つけた say は未読と agent_says に合流し、同じ id
//     を二重に数えない
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  jsonText,
  parseWith,
  SayCommandInputSchema,
  type JsonObject,
  type SayCommandInput,
} from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { assistantContentRow, line, toolUseBlock } from "../../protocol/test/transcript-rows.ts";
import {
  agentSays,
  loadSayUnreadStore,
  markSaysRead,
  sayScan,
  unreadSays,
} from "../src/say-unread.ts";
import { relaysCaughtUp } from "../src/transcript-relay.ts";
import { recordedSpeeches, sayRecorderScript } from "./say-recorder.ts";
import {
  fixtureDir,
  isKind,
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

/** A daemon in this process whose say command records each speech (a say
 * recorder), and the speeches once they ended. */
async function withSpeakingDaemon(
  run: (
    ctx: InProcessDaemon,
    speeches: () => Promise<SayCommandInput[]>,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const work = tmpDir("ccmsg-say-");
  const spokenFile = path.join(work, "spoken");
  const speech = writeMockBin(path.join(work, "say"), sayRecorderScript(spokenFile));
  const ctx = await startInProcessDaemon({ config: { say_command: [speech] } });
  const dir = fixtureDir("say");
  try {
    await run(
      ctx,
      async () => {
        await ctx.daemon.speaker.idle();
        return recordedSpeeches(spokenFile);
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

/** The transcript line of a subagent's or teammate's assistant turn that
 * calls say, as its own transcript holds it, made at `ts`. */
function agentSayLine(text: string, id: string, agentId: string, ts: string): string {
  return sayLine(text, id, { timestamp: ts, isSidechain: true, agentId });
}

/** A row's time `secs` seconds into a day before the test ran (sinceLongAgo
 * makes it unread), apart enough to order by. */
const at = (secs: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, secs)).toISOString();

/** Count the says of `at`'s day as unread: the store's `since` is the
 * daemon's start otherwise. */
function sinceLongAgo(ctx: InProcessDaemon): void {
  ctx.daemon.sayUnread.since = "2026-01-01T00:00:00.000Z";
}

/** A session's transcript where the daemon finds its agents' beside it:
 * `<dir>/projects/p/<sid>.jsonl`, with `agents` (agent id → its lines) in
 * `<sid>/subagents/agent-<id>.jsonl`. */
function sessionTree(
  dir: string,
  sid: string,
  main: string,
  agents: Record<string, string> = {},
): { file: string; agentFile: (agentId: string) => string } {
  const project = path.join(dir, "projects", "p");
  const subagents = path.join(project, sid, "subagents");
  fs.mkdirSync(subagents, { recursive: true });
  const file = path.join(project, `${sid}.jsonl`);
  fs.writeFileSync(file, main);
  const agentFile = (agentId: string): string => path.join(subagents, `agent-${agentId}.jsonl`);
  for (const [agentId, lines] of Object.entries(agents))
    fs.writeFileSync(agentFile(agentId), lines);
  return { file, agentFile };
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
  // 何を保証するか: push の行の say の tool_use ごとに say_command を 1 回起こし、
  // stdin に JSON を 1 つ渡す: kind は "say"、session_id は push したセッション、
  // text は書かれた文、spoken は読み上げ辞書を当てた文、session はそのセッション
  // の peers の行 (sid と cwd がそのセッションのもの)。同じ id の二度目の push
  // (書かれる前の二重 push) では発声し直さない。
  test("runs the say command once per call, with the text, the text through the dictionary and the session", async () => {
    await withSpeakingDaemon(async (ctx, speeches, dir) => {
      fs.mkdirSync(ctx.daemon.paths.configDir, { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.sayDictionary, "push\tプッシュ\n");
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file, cwd: dir });
      await sessionConn(ctx, B, { cwd: "/" });
      await pushSay(session, { text: "daemon に push した" }, "toolu_a");
      await pushSay(session, { text: "daemon に push した" }, "toolu_a");
      await pushSay(session, { text: "-v です" }, "toolu_b");
      const spoken = await speeches();
      expect(spoken.map(({ session: _session, ...speech }) => speech)).toEqual([
        {
          kind: "say",
          session_id: A,
          text: "daemon に push した",
          spoken: "デーモン に プッシュ した",
        },
        { kind: "say", session_id: A, text: "-v です", spoken: "-v です" },
      ]);
      expect(spoken.map((speech) => [speech.session?.sid, speech.session?.cwd])).toEqual([
        [A, fs.realpathSync(dir)],
        [A, fs.realpathSync(dir)],
      ]);
    });
  });

  // 何を保証するか: テストの run の lifeline の下でも、say_command を書いた
  // daemon はそのコマンドを起こす (lifeline で黙るのは say_command が無い時だけ)。
  // say_command が無い daemon は起こさず、daemon.log に発声ごとに 1 行書く。
  test("under a test run's lifeline, the say_command runs, and none is said in the log", async () => {
    expect(process.env.CCMSG_TEST_LIFELINE).toBeTruthy();
    await withSpeakingDaemon(async (ctx, speeches) => {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "one" }, "toolu_1");
      expect((await speeches()).map((s) => s.text)).toEqual(["one"]);
    });
    const silent = await startInProcessDaemon();
    try {
      const session = await sessionConn(silent, A);
      await pushSay(session, { text: "one" }, "toolu_1");
      await pushSay(session, { text: "two" }, "toolu_2");
      await silent.daemon.speaker.idle();
      const notSpoken = fs
        .readFileSync(silent.daemon.paths.log, "utf8")
        .split("\n")
        .filter((l) =>
          l.includes(
            `say: not spoken (a test's daemon with no say_command): kind=say session=${A}`,
          ),
        );
      expect(notSpoken).toHaveLength(2);
    } finally {
      await stopInProcessDaemon(silent);
    }
  });

  // 何を保証するか: 発声は直列。2 つの say が続けて来ても、前の発声 (say_command
  // の 1 回) が終わってから次が始まる (声が重ならない)。
  test("speaks one call after another", async () => {
    const work = tmpDir("ccmsg-say-");
    const file = path.join(work, "spoken");
    const to = JSON.stringify(file);
    // The pause stands for a speech that takes a while; it is the speech, not
    // a wait for something to happen.
    const speech = writeMockBin(
      path.join(work, "say"),
      `#!/bin/sh\nprintf 'start ' >> ${to}\ncat >> ${to}\nprintf '\\n' >> ${to}\nsleep 0.2\necho end >> ${to}\n`,
    );
    const ctx = await startInProcessDaemon({ config: { say_command: [speech] } });
    try {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "one" }, "toolu_1");
      await pushSay(session, { text: "two" }, "toolu_2");
      await ctx.daemon.speaker.idle();
      // Each speech's start, its input, then its end, before the next starts.
      const lines = fs.readFileSync(file, "utf8").split("\n");
      expect(lines.map((l) => (l.startsWith("start ") ? "start" : l))).toEqual([
        "start",
        "end",
        "start",
        "end",
        "",
      ]);
      const texts = [lines[0], lines[2]].map((l) => {
        const read = parseWith(jsonText(SayCommandInputSchema), (l ?? "").slice("start ".length));
        return read.ok ? read.value.text : read.failure.summary;
      });
      expect(texts).toEqual(["one", "two"]);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: say_command が 0 以外で終わると、daemon.log にコマンドと
  // 終了コードと stderr の最初の行を 1 行書く。次の発声は続く。
  test("a say command that exits non-zero is logged, and the next speech goes on", async () => {
    const work = tmpDir("ccmsg-say-");
    const file = path.join(work, "spoken");
    const speech = writeMockBin(
      path.join(work, "say"),
      `#!/bin/sh\ncat >> ${JSON.stringify(file)}\nprintf '\\n' >> ${JSON.stringify(file)}\necho 'no voice here' >&2\nexit 3\n`,
    );
    const ctx = await startInProcessDaemon({ config: { say_command: [speech] } });
    try {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "one" }, "toolu_1");
      await pushSay(session, { text: "two" }, "toolu_2");
      await ctx.daemon.speaker.idle();
      expect(recordedSpeeches(file).map((s) => s.text)).toEqual(["one", "two"]);
      const exited = fs
        .readFileSync(ctx.daemon.paths.log, "utf8")
        .split("\n")
        .filter((line) => line.includes(`say: ${speech} exited 3: no voice here`));
      expect(exited).toHaveLength(2);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 追いつき (live になった時のファイルの頭からの読み) で見た
  // say は古い行なので発声しない。同じ行が compaction で同じ uuid のまま
  // もう一度 push されても、読み済みなので発声しない。
  test("speaks no call the catch-up read, nor a row pushed again after it was read", async () => {
    await withSpeakingDaemon(async (ctx, speeches, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      const old = stampRows(sayLine("昔の say", "toolu_old"));
      fs.writeFileSync(file, old.text);
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      await pushSay(session, { text: "昔の say" }, "toolu_old", { uuid: old.uuids[0] ?? "" });
      await writeAndPushSay(session, file, "新しい say", "toolu_new");
      expect((await speeches()).map((s) => s.spoken)).toEqual(["新しい say"]);
    });
  });

  // 何を保証するか: subagent / teammate の say も発声する (§6)。session_id は
  // push したセッション。入力が tool の形に合わない呼び出しは、module が断った
  // のと同じく何も起こさない。
  test("speaks a subagent's call, and no call whose input is not the tool's", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "subagent から" }, "toolu_sub", { agent_id: "a1" });
      await pushSay(session, {}, "toolu_bad");
      await pushSay(session, { text: 3 }, "toolu_bad2");
      expect((await speeches()).map(({ session, ...speech }) => [speech, session?.sid])).toEqual([
        [{ kind: "say", session_id: A, text: "subagent から", spoken: "subagent から" }, A],
      ]);
    });
  });

  // 何を保証するか: 発声コマンドの入力の url は webui の URL の先頭 (ping の
  // webui_url) に続けて、main の say はその呼び出しの行の uuid の位置
  // (`/s/<sid>/timeline/<uuid>`、TL がその行の say のバブルを選ぶ位置)、
  // subagent / teammate の say は 🔔 のフィルタ (`/s/<sid>/timeline/head?filter=say`。
  // そのバブルは親の TL に時刻の位置で合流し、位置を持たない、DR-0050 §10)。
  // daemon に webui の URL が無ければ url は無い。
  test("hands the say command the URL that opens the say's bubble, when the daemon has a webui URL", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "no url" }, "toolu_n");
      ctx.daemon.webuiUrls = async () => ["https://ccmsg.example.ts.net"];
      const row = crypto.randomUUID();
      await pushSay(session, { text: "main" }, "toolu_m", { uuid: row });
      await pushSay(session, { text: "sub" }, "toolu_s", { agent_id: "a1" });
      expect((await speeches()).map((s) => [s.text, s.url])).toEqual([
        ["no url", undefined],
        ["main", `https://ccmsg.example.ts.net/s/${A}/timeline/${row}`],
        ["sub", `https://ccmsg.example.ts.net/s/${A}/timeline/head?filter=say`],
      ]);
    });
  });

  // 何を保証するか: 辞書ファイルの読めない行はその行だけ飛ばし、daemon.log に
  // 1 行書く。発声は残りの行で続く。
  test("a line of the dictionary that does not read is skipped and logged", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      fs.mkdirSync(ctx.daemon.paths.configDir, { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.sayDictionary, "broken line\npush\tプッシュ\n");
      const session = await sessionConn(ctx, A);
      await pushSay(session, { text: "push" }, "toolu_1");
      expect((await speeches()).map((s) => s.spoken)).toEqual(["プッシュ"]);
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

  // 何を保証するか: subagent / teammate の say も親セッションの未読に数え
  // (agent_id 付き)、本文は ev:"agent_says" で届く (DR-0050 §10)。既読は main の
  // say と同じ say_read で付き、既読になっても agent_says には残る。
  test("a subagent's say is unread under its session, and its text is in agent_says", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      const first = await user.readEventUntil("agent_says", () => true);
      expect(first.ev.says).toEqual([]);

      await pushSay(session, { text: "worker から" }, "toolu_sub", { agent_id: "a1" });
      const unread = await user.readEventUntil("say_unread", (e) => e.says.length > 0);
      expect(unread.ev.says).toMatchObject([
        { session_id: A, tool_use_id: "toolu_sub", agent_id: "a1" },
      ]);
      const told = await user.readEventUntil("agent_says", (e) => e.says.length > 0);
      expect(told.ev.says).toMatchObject([
        { session_id: A, agent_id: "a1", tool_use_id: "toolu_sub", text: "worker から" },
      ]);

      await user.requestOk({ op: "say_read", ids: ["toolu_sub"] });
      expect(unreadSays(ctx.daemon.sayUnread)).toEqual([]);
      expect(agentSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual(["toolu_sub"]);
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
      expect(fs.readFileSync(ctx.daemon.paths.sayRead, "utf8")).toContain(
        `"read":{"${A}":["toolu_1"]}`,
      );
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

describe("say: a session that is not live", () => {
  // 何を保証するか: module の繋がっていないセッションでも、TL を開いた時の
  // status の一回読み (session_status_subscribe) が transcript の say を数え、
  // ev:"say_unread" の未読に出す。その say は say_read で既読にできる。
  test("its says are counted on the read that answers its status, and read like a live one's", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, sayLine("one", "toolu_1") + sayLine("two", "toolu_2"));
      const session = await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      const first = await user.readEventUntil("say_unread", () => true);
      expect(first.ev.says).toEqual([]);

      await user.requestOk({ op: "session_status_subscribe", sid: A });
      const counted = await user.readEventUntil("say_unread", (e) => e.says.length === 2);
      expect(counted.ev.says.map((say) => [say.session_id, say.tool_use_id])).toEqual([
        [A, "toolu_1"],
        [A, "toolu_2"],
      ]);

      await user.requestOk({ op: "say_read", ids: ["toolu_1"] });
      const read = await user.readEventUntil("say_unread", (e) => e.says.length === 1);
      expect(read.ev.says.map((say) => say.tool_use_id)).toEqual(["toolu_2"]);
      session.close();
    });
  });

  // 何を保証するか: 一回読みで数えたセッションが live になると、追いつきの fold
  // が引き継ぎ、同じ say を二重に数えない (未読は 2 のまま)。
  test("a session that becomes live is handed to its fold, its says not counted twice", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, sayLine("one", "toolu_1") + sayLine("two", "toolu_2"));
      const user = await userConn(ctx);
      await sessionConn(ctx, A, { transcript_path: file });
      await user.requestOk({ op: "session_status", sid: A });
      expect(ctx.daemon.sayUnread.scanned.get(A)?.size).toBe(2);

      await liveSessionConn(ctx, A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      expect(ctx.daemon.sayUnread.scanned.has(A)).toBe(false);
      expect(unreadSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual([
        "toolu_1",
        "toolu_2",
      ]);
    });
  });

  // 何を保証するか: 一回読みは、その時に live (fold を持つ) のセッションの say を
  // 置き換えない。数えた say が前と同じなら知らせず、変われば知らせる。since
  // より前の say は既読とみなす。
  test("the read leaves a live session's says, tells only a change, and counts a say before since as read", () => {
    const file = path.join(tmpDir("ccmsg-say-read-"), "say-read.json");
    const store = loadSayUnreadStore(
      file,
      { warn: (): void => {} },
      () => new Date("2026-10-28T00:00:00.000Z"),
    );
    const old = sayLine("old", "toolu_old", { timestamp: "2026-10-27T00:00:00.000Z" });
    const fresh = sayLine("new", "toolu_new", { timestamp: "2026-10-28T00:00:01.000Z" });
    let told = 0;
    const read = (sid: string, lines: string[]): void => {
      const reader = sayScan(store, sid, () => void (told += 1));
      for (const l of lines) reader.take(l.trimEnd());
      reader.done();
    };

    read(A, [old, fresh]);
    expect(told).toBe(1);
    expect(unreadSays(store).map((say) => say.tool_use_id)).toEqual(["toolu_new"]);
    read(A, [old, fresh]);
    expect(told).toBe(1);
    read(B, []);
    expect(told).toBe(1);

    store.says.set(B, new Map([["toolu_live", "2026-10-28T00:00:02.000Z"]]));
    read(B, [fresh]);
    expect(told).toBe(1);
    // Not replaced by what the read found: B's earlier read (none) stays,
    // and the live fold is what counts.
    expect(store.scanned.get(B)?.size).toBe(0);
    expect(unreadSays(store).map((say) => [say.session_id, say.tool_use_id])).toEqual([
      [A, "toolu_new"],
      [B, "toolu_live"],
    ]);
  });
});

describe("say: a daemon that shuts down", () => {
  // 何を保証するか: 終了の時に fold を閉じても、空の未読をタブに配らない
  // (タブは次の daemon が自分の未読を送るまで、空を 🔕 として見せてしまう)。
  test("sends no emptied unread on its way down", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("say");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      await writeAndPushSay(session, file, "one", "toolu_1");
      await user.readEventUntil("say_unread", (e) => e.says.length === 1);
      // The relays close before every connection is told it is restarting.
      const stopped = stopInProcessDaemon(ctx);
      const { seen } = await user.readEventUntil("restarting");
      await stopped;
      expect(seen.filter(isKind("say_unread"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    // Each read id under the session that has it, so that it can go with the
    // session (pruneNotificationState).
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      since: "2026-10-28T00:00:00.000Z",
      read: { [A]: ["toolu_1"] },
    });
  });

  // 何を保証するか: セッションの分からない既読の id (read が一覧のファイル) は
  // 読み戻しで捨てて log に書き、since は残してセッションごとの形で書き直す。
  test("read ids without their session are dropped on reading, and the file written again", async () => {
    const file = path.join(tmpDir("ccmsg-say-read-"), "say-read.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ since: "2026-10-28T00:00:00.000Z", read: ["toolu_plain"] }),
    );
    const warned: string[] = [];
    const store = loadSayUnreadStore(file, { warn: (m) => warned.push(m) }, () => new Date());
    expect(store.read.has("toolu_plain")).toBe(false);
    expect(store.since).toBe("2026-10-28T00:00:00.000Z");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("read ids without their session dropped");
    await store.written;
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      since: "2026-10-28T00:00:00.000Z",
      read: {},
    });
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
    expect({ since: store.since, read: store.read.ids() }).toEqual({
      since: "2026-10-28T00:00:00.000Z",
      read: [],
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("starting over");
  });
});

describe("say: every say of a session (notification_list)", () => {
  const WORKER = "a1234567";

  // 何を保証するか: notification_list は main の transcript と subagent / teammate /
  // workflow agent の transcript の say を全部 (既読も) 本文付きで時刻順に返す。
  // live でないセッションでも返す。agent の say には agent_id が付く。見つけた
  // agent の say は未読 (agent_id 付き) と ev:"agent_says" に出て、タブに届く。
  test("reads the main and agent transcripts whole, and the says found join the unread", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      sinceLongAgo(ctx);
      const { file } = sessionTree(
        dir,
        A,
        sayLine("main 1", "toolu_m1", { timestamp: at(1) }) +
          sayLine("main 2", "toolu_m2", { timestamp: at(3) }),
        { [WORKER]: agentSayLine("worker 1", "toolu_w1", WORKER, at(2)) },
      );
      const run = path.join(path.dirname(file), A, "subagents", "workflows", "wf_01234567-abc");
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(
        path.join(run, "agent-a7654321.jsonl"),
        agentSayLine("workflow 1", "toolu_f1", "a7654321", at(4)),
      );
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      await user.readEventUntil("agent_says", () => true);

      const listed = await user.requestOk({ op: "notification_list", sid: A });
      expect(listed.says.map((say) => [say.tool_use_id, say.text, say.agent_id])).toEqual([
        ["toolu_m1", "main 1", undefined],
        ["toolu_w1", "worker 1", WORKER],
        ["toolu_m2", "main 2", undefined],
        ["toolu_f1", "workflow 1", "a7654321"],
      ]);
      const unread = await user.readEventUntil("say_unread", (e) => e.says.length === 4);
      expect(unread.ev.says.map((say) => [say.tool_use_id, say.agent_id])).toEqual([
        ["toolu_m1", undefined],
        ["toolu_w1", WORKER],
        ["toolu_m2", undefined],
        ["toolu_f1", "a7654321"],
      ]);
      const told = await user.readEventUntil("agent_says", (e) => e.says.length === 2);
      expect(told.ev.says.map((say) => [say.tool_use_id, say.text])).toEqual([
        ["toolu_w1", "worker 1"],
        ["toolu_f1", "workflow 1"],
      ]);
    });
  });

  // 何を保証するか: 既読の say も返す (既読かどうかは say_unread が持つ)。
  test("a read say is listed too", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      sinceLongAgo(ctx);
      const { file } = sessionTree(
        dir,
        A,
        sayLine("one", "toolu_1", { timestamp: at(1) }) +
          sayLine("two", "toolu_2", { timestamp: at(2) }),
      );
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "notification_list", sid: A });
      await user.requestOk({ op: "say_read", ids: ["toolu_1"] });
      const listed = await user.requestOk({ op: "notification_list", sid: A });
      expect(listed.says.map((say) => say.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
      expect(unreadSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual(["toolu_2"]);
    });
  });

  // 何を保証するか: 2 回目の notification_list は読み直さない (ファイルに直接足した行は
  // 出ない)。以後は push の差分で増える: main の say は fold が読んだ行から、
  // agent の say は push の行から。同じ say を fold・push・一覧で重ねて持っても、
  // 未読は 1 件ずつ。セッションが live でなくなっても一覧は残る。
  test("a later ask reads nothing again, and the pushes add to it", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      sinceLongAgo(ctx);
      const { file, agentFile } = sessionTree(
        dir,
        A,
        sayLine("main 1", "toolu_m1", { timestamp: at(1) }),
        { [WORKER]: agentSayLine("worker 1", "toolu_w1", WORKER, at(2)) },
      );
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const user = await userConn(ctx);
      const first = await user.requestOk({ op: "notification_list", sid: A });
      expect(first.says.map((say) => say.tool_use_id)).toEqual(["toolu_m1", "toolu_w1"]);

      // Written without a push: only a read of the file would find them.
      fs.appendFileSync(agentFile(WORKER), agentSayLine("unpushed", "toolu_w0", WORKER, at(3)));
      const again = await user.requestOk({ op: "notification_list", sid: A });
      expect(again.says.map((say) => say.tool_use_id)).toEqual(["toolu_m1", "toolu_w1"]);

      await writeAndPushSay(session, file, "main 2", "toolu_m2");
      await pushSay(session, { text: "worker 2" }, "toolu_w2", { agent_id: WORKER });
      const grown = await user.requestOk({ op: "notification_list", sid: A });
      expect(grown.says.map((say) => [say.tool_use_id, say.text])).toEqual([
        ["toolu_m1", "main 1"],
        ["toolu_w1", "worker 1"],
        ["toolu_m2", "main 2"],
        ["toolu_w2", "worker 2"],
      ]);
      expect(unreadSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual([
        "toolu_m1",
        "toolu_w1",
        "toolu_m2",
        "toolu_w2",
      ]);
      expect(agentSays(ctx.daemon.sayUnread).map((say) => say.tool_use_id)).toEqual([
        "toolu_w1",
        "toolu_w2",
      ]);

      await session.end();
      const kept = await user.requestOk({ op: "notification_list", sid: A });
      expect(kept.says.map((say) => say.tool_use_id)).toEqual([
        "toolu_m1",
        "toolu_w1",
        "toolu_m2",
        "toolu_w2",
      ]);
      expect(unreadSays(ctx.daemon.sayUnread)).toHaveLength(4);
    });
  });

  // 何を保証するか: 一覧より先に push で受けた agent の say は、一覧でも push を
  // 受けた時刻のまま (agent_says と同じ時刻) で、二重に出ない。
  test("an agent's say pushed before the first ask keeps its pushed time", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      sinceLongAgo(ctx);
      const { file, agentFile } = sessionTree(dir, A, "");
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      await pushSay(session, { text: "worker" }, "toolu_w", { agent_id: WORKER });
      const pushed = agentSays(ctx.daemon.sayUnread)[0]?.ts;
      fs.writeFileSync(agentFile(WORKER), agentSayLine("worker", "toolu_w", WORKER, at(60)));
      const user = await userConn(ctx);
      const listed = await user.requestOk({ op: "notification_list", sid: A });
      expect(listed.says).toEqual([
        { tool_use_id: "toolu_w", ts: pushed ?? "", text: "worker", agent_id: WORKER },
      ]);
      expect(unreadSays(ctx.daemon.sayUnread)).toHaveLength(1);
    });
  });

  // 何を保証するか: user role だけが聞ける。transcript の無いセッションは断り、
  // 次に聞いた時は読み直す (失敗を一覧として持たない)。
  test("is the user's to ask, and a session whose transcript does not read is refused", async () => {
    await withSpeakingDaemon(async (ctx, _spoken, dir) => {
      sinceLongAgo(ctx);
      const file = path.join(dir, "projects", "p", `${A}.jsonl`);
      const session = await sessionConn(ctx, A, { transcript_path: file });
      expect(await session.request({ op: "notification_list", sid: A })).toEqual({
        ok: false,
        error: { code: "bad_request", msg: "op 'notification_list' requires user role" },
      });
      const user = await userConn(ctx);
      expect(await user.request({ op: "notification_list", sid: A })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(ctx.daemon.sayUnread.listed.has(A)).toBe(false);
      sessionTree(dir, A, sayLine("one", "toolu_1", { timestamp: at(1) }));
      const listed = await user.requestOk({ op: "notification_list", sid: A });
      expect(listed.says.map((say) => say.tool_use_id)).toEqual(["toolu_1"]);
    });
  });
});
