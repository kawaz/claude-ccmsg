// 許可依頼 (DR-0040) の daemon 側の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - permit_request は { ok } で答えるだけ。読み上げず、依頼の中身は持たず、
//     タブには何も送らない (依頼は transcript の permit の行)
//   - push で受けた main の permit の tool_use を、tool_use の id ごとに 1 度だけ
//     voice で読み上げ、発声コマンドにその呼び出しの行を開く webui の URL を
//     渡す。subagent の呼び出し、入力が tool の形に合わない呼び出し、追いつきで
//     読んだ行は読み上げない。追いつきの最中の push は、追いつきが読み終わって
//     から読んだ行かどうかで分ける
//   - 依頼は transcript の permit の tool_use のうち、tool_result が
//     PERMIT_REQUESTED_TEXT のものだけ。断られた (subagent の) 呼び出し、結果の
//     まだ無い呼び出し、main の transcript の sidechain の行は依頼でない
//   - 未読は live のセッションの fold、live でないセッションの一回読み、
//     notification_list の全走査から集め、ev:"permit_state" で user role に届く。
//     同じ id は 1 件
//   - notification_list は main と agent の transcript の依頼を時刻順に返す
//   - permit_read は tool_use の id で既読にし、ファイルに書いてから答える。
//     知らない id は全部断る
//   - permit_attachment_read は、その依頼が名指したパスだけを読む。daemon が
//     まだ読んでいないセッションの依頼は、その場で transcript を読んで探す
//   - permit-state.json は既読・since・適用を持ち、読み戻せる。読めなければ
//     今から始め直す
//   - 操作の項目 (commands と project_permissions) が全部済んだ依頼は、人が
//     既読にしなくても未読から外れる: 各コマンドの <bash-input> の行が依頼の
//     結果の行より後に来て、各 project_permission が適用された時。intents の
//     ある依頼は外れない
//
// wire 越しに確かめる op なので、同じプロセスに立てた daemon に UDS で繋ぐ。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CCMSG_TOOLS,
  PERMIT_ATTACHMENT_MAX_BYTES,
  type JsonObject,
  type PermitItemKind,
  type SayCommandInput,
  type TranscriptPushRow,
} from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { readPermitAttachment } from "../src/permit-attachment.ts";
import {
  loadPermitStore,
  markPermitApplied,
  markPermitDismissed,
  markPermitGranted,
  markPermitsRead,
  permitFold,
  permitScan,
  permitStateEvent,
  type PermitStore,
  unreadPermits,
} from "../src/permit-state.ts";
import { relayHasRead, relaysCaughtUp } from "../src/transcript-relay.ts";
import { line, toolUseBlock, userContentRow } from "../../protocol/test/transcript-rows.ts";
import { handingConn } from "./drive-request.ts";
import type { Conn } from "../src/server.ts";
import { recordedSpeeches, sayRecorderScript } from "./say-recorder.ts";
import {
  appendPushed,
  isKind,
  liveSessionConn,
  sessionConn,
  stampRows,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import {
  at,
  bashLines,
  PERMIT_REFUSED_TEXT,
  permitLines,
  permitSessionTree,
} from "./permit-rows.ts";

const SID_A = "9e700000-0000-4000-8000-000000000001";
const SID_B = "9e700000-0000-4000-8000-000000000002";
/** A connection's identity as `SID_A`, for the connections the test hands requests on. */
const SESSION_A: Conn["identity"] = { role: "session", sid: SID_A, cwd: "" };
const WORKER = "a1234567";

const tmpDir = perTestTmpDir();

/** Count the requests of `at`'s day as not acted on: the store's `since` is
 * the daemon's start otherwise. */
function sinceLongAgo(ctx: InProcessDaemon): void {
  ctx.daemon.permits.since = "2026-01-01T00:00:00.000Z";
}

/** A subscribed user connection, past its subscribe-time ev:"permit_state". */
async function subscribedUser(ctx: InProcessDaemon): Promise<TestClient> {
  const u = await userConn(ctx);
  await u.request({ op: "subscribe" });
  await u.readEventUntil("permit_state");
  return u;
}

/** A row of a session's conversation, an assistant turn that calls permit,
 * as its module pushes it (`e.message`). */
function permitRow(
  input: JsonObject,
  id: string,
  fields: { uuid?: string; agent_id?: string } = {},
): TranscriptPushRow {
  return {
    uuid: fields.uuid ?? crypto.randomUUID(),
    door: "response",
    ...(fields.agent_id !== undefined ? { agent_id: fields.agent_id } : {}),
    message: {
      type: "assistant",
      role: "assistant",
      content: [toolUseBlock(CCMSG_TOOLS.permit, input, id)],
    },
  };
}

/** Push one row of `session`'s conversation, an assistant turn that calls
 * permit, as its module does. */
async function pushPermit(
  session: TestClient,
  input: JsonObject,
  id: string,
  fields: { uuid?: string; agent_id?: string } = {},
): Promise<void> {
  await session.requestOk({ op: "transcript_push", rows: [permitRow(input, id, fields)] });
}

/** A daemon in this process whose say command records each speech, and the
 * speeches once they ended. */
async function withSpeakingDaemon(
  run: (ctx: InProcessDaemon, speeches: () => Promise<SayCommandInput[]>) => Promise<void>,
): Promise<void> {
  const work = tmpDir("permit-say-");
  const spokenFile = path.join(work, "spoken");
  const speech = writeMockBin(path.join(work, "say"), sayRecorderScript(spokenFile));
  const ctx = await startInProcessDaemon({ config: { say_command: [speech] } });
  try {
    await run(ctx, async () => {
      await ctx.daemon.speaker.idle();
      return recordedSpeeches(spokenFile);
    });
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

describe("permit_request op", () => {
  // 何を保証するか: permit_request は { ok } で答えるだけで、読み上げない (読み
  // 上げは呼び出しの行の push が起こす)。タブには何も送らない (依頼は
  // transcript の行で、daemon は中身を持たない)。
  test("answers { ok }, speaks nothing, and pushes nothing to the tabs", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const u = await subscribedUser(ctx);
      const s = await sessionConn(ctx, SID_A);
      expect(
        await s.requestOk({
          op: "permit_request",
          permit: { blocked: "x", commands: [{ command: "git push" }], voice: "push の許可を" },
        }),
      ).toEqual({ ok: true });
      await s.requestOk({
        op: "permit_request",
        permit: { blocked: "x", intents: ["設定を直す"] },
      });
      expect(await speeches()).toEqual([]);
      await u.request({ op: "ping" });
      expect((await u.pendingEvents()).filter(isKind("permit_state"))).toEqual([]);
      u.close();
      s.close();
    });
  });

  // 何を保証するか: 許可依頼は止められたエージェント自身が出すもので、user
  // role (webui) からは出せない。何も求めていない依頼は形の誤りで断る。
  test("requires session role, and refuses a request that asks for nothing", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      expect(
        (
          await u.requestError({
            op: "permit_request",
            permit: { blocked: "x", commands: [{ command: "ls" }] },
          })
        ).error,
      ).toEqual({ code: "bad_request", msg: "op 'permit_request' requires session role" });
      const s = await sessionConn(ctx, SID_A);
      const res = await s.requestError({ op: "permit_request", permit: { blocked: "x" } });
      expect(res.error.code).toBe("invalid_args");
      expect(res.error.msg).toContain("ask for at least one of intents and commands");
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: エージェントが書いたファイルの rule は、どの形でも
  // (symlink を通る path を実体の綴り無しで、Write、/ 1 つで) 断らずに受ける。
  // 当たる形への直しは daemon が依頼を見つけた時に行い、エージェントには
  // 知らせない (DR-0040 §12)。
  test("takes a file rule of any form, without asking the agent for more", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const work = tmpDir("permit-request-symlink-");
      fs.mkdirSync(path.join(work, "real"));
      fs.symlinkSync("real", path.join(work, "link"));
      fs.mkdirSync(ctx.daemon.home, { recursive: true });
      fs.symlinkSync(path.join(work, "real"), path.join(ctx.daemon.home, "hlink"));
      const s = await sessionConn(ctx, SID_A);
      const asking = (adds: string[]) => ({
        op: "permit_request" as const,
        permit: { blocked: "x", project_permissions: adds.map((add) => ({ add })) },
      });
      expect(
        await s.requestOk(
          asking([
            `Edit(/${work}/link/a.toml)`,
            "Read(~/hlink/new.txt)",
            `Write(/${work}/b.toml)`,
            `Edit(${work}/c.toml)`,
          ]),
        ),
      ).toEqual({ ok: true });
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("permit: the daemon speaks the pushed permit calls", () => {
  const REQUEST = { blocked: "push が止められた", commands: [{ command: "git push" }] };

  // 何を保証するか: push の行の permit の tool_use ごとに say_command を 1 回
  // 起こす: kind は "permit"、session_id は push したセッション、text は voice、
  // spoken は読み上げ辞書を当てた voice (`-` で始まる voice もそのまま)、
  // session はそのセッションの peers の行。同じ id の二度目の push (書かれる
  // 前の二重 push) では読み上げ直さない。
  test("says each call's voice once, through the dictionary, as the session's", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      fs.mkdirSync(ctx.daemon.paths.configDir, { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.sayDictionary, "push\tプッシュ\n");
      const s = await sessionConn(ctx, SID_A);
      await pushPermit(s, { ...REQUEST, voice: "push の許可をお願いします。" }, "toolu_p1");
      await pushPermit(s, { ...REQUEST, voice: "push の許可をお願いします。" }, "toolu_p1");
      await pushPermit(s, { ...REQUEST, voice: "-v の許可をお願いします。" }, "toolu_p2");
      const spoken = await speeches();
      expect(spoken.map(({ session: _session, ...speech }) => speech)).toEqual([
        {
          kind: "permit",
          session_id: SID_A,
          text: "push の許可をお願いします。",
          spoken: "プッシュ の許可をお願いします。",
        },
        {
          kind: "permit",
          session_id: SID_A,
          text: "-v の許可をお願いします。",
          spoken: "-v の許可をお願いします。",
        },
      ]);
      expect(spoken.map((speech) => speech.session?.sid)).toEqual([SID_A, SID_A]);
      s.close();
    });
  });

  // 何を保証するか: 発声コマンドの入力の url は、そのセッションの TL をその
  // permit の呼び出しの行の uuid の位置で開く URL (webui の 🔐 のフィルタで依頼をクリックした時に着地
  // する `/s/<sid>/timeline/<uuid>?seek=true`、フィルタ無し。行が TL の最初に読む
  // 範囲より古くても、見つかるまで過去分を読む) で、webui の URL の先頭
  // (ping の webui_url) に続ける。daemon に webui の URL が無ければ url は無い。
  test("hands the say command the URL of the call's row, when the daemon has a webui URL", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const s = await sessionConn(ctx, SID_A);
      const row = crypto.randomUUID();
      await pushPermit(s, { ...REQUEST, voice: "許可を" }, "toolu_n", {
        uuid: crypto.randomUUID(),
      });
      ctx.daemon.webuiUrls = async () => ["https://ccmsg.example.ts.net", "https://other.example"];
      await pushPermit(s, { ...REQUEST, voice: "許可を" }, "toolu_u", { uuid: row });
      expect((await speeches()).map((speech) => speech.url)).toEqual([
        undefined,
        `https://ccmsg.example.ts.net/s/${SID_A}/timeline/${row}?seek=true`,
      ]);
      s.close();
    });
  });

  // 何を保証するか: subagent / teammate の permit の呼び出しは module が断る
  // (DR-0040 §9) ので読み上げない。入力が tool の形に合わない呼び出し (voice が
  // 無い、何も求めていない、blocked が無い) も module が断るので読み上げない。
  test("speaks no subagent's call, and no call whose input is not the tool's", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const s = await sessionConn(ctx, SID_A);
      await pushPermit(s, { ...REQUEST, voice: "subagent から" }, "toolu_sub", {
        agent_id: WORKER,
      });
      await pushPermit(s, REQUEST, "toolu_novoice");
      await pushPermit(s, { blocked: "x", voice: "何も求めない" }, "toolu_nothing");
      await pushPermit(
        s,
        { commands: [{ command: "ls" }], voice: "blocked 無し" },
        "toolu_noblock",
      );
      await pushPermit(s, { ...REQUEST, voice: "main から" }, "toolu_main");
      expect((await speeches()).map((speech) => speech.text)).toEqual(["main から"]);
      s.close();
    });
  });

  // 何を保証するか: 追いつき (live になった時のファイルの頭からの読み) で見た
  // 呼び出しは古い行なので読み上げない。同じ行が読み済みの後に同じ uuid で
  // もう一度 push されても読み上げない。
  test("speaks no call the catch-up read, nor a row pushed again after it was read", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const dir = tmpDir("permit-catchup-");
      const old = stampRows(permitLines("toolu_old", { ...REQUEST, voice: "昔の依頼" }));
      const file = permitSessionTree(dir, SID_A, old.text);
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await pushPermit(s, { ...REQUEST, voice: "昔の依頼" }, "toolu_old", {
        uuid: old.uuids[0] ?? "",
      });
      await pushPermit(s, { ...REQUEST, voice: "新しい依頼" }, "toolu_new");
      expect((await speeches()).map((speech) => speech.text)).toEqual(["新しい依頼"]);
      s.close();
    });
  });

  // 何を保証するか: 追いつきの最中に push された呼び出しは、追いつきが読み
  // 終わってから分ける (追いつきの読みは途中で、読み済みの集合はまだ全部では
  // ない)。追いつきが読んだ古い呼び出し (compaction が同じ uuid で送り直す、
  // DR-0045 §2) は読み上げず、ファイルにまだ無い新しい呼び出しは捨てずに
  // 追いつきの後に 1 度だけ読み上げる。
  test("a call pushed during the catch-up is said after it, unless the catch-up read it", async () => {
    await withSpeakingDaemon(async (ctx, speeches) => {
      const dir = tmpDir("permit-catchup-");
      const old = stampRows(permitLines("toolu_old", { ...REQUEST, voice: "昔の依頼" }));
      const oldUuid = old.uuids[0] ?? "";
      const file = permitSessionTree(dir, SID_A, old.text);
      const s = await sessionConn(ctx, SID_A, { transcript_path: file });
      const run = handingConn(ctx.daemon, SESSION_A);
      run.hand({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
      // The catch-up has not got to the old call yet.
      expect(relayHasRead(ctx.daemon.transcriptRelay, SID_A, oldUuid)).toBe(false);

      const fresh = stampRows(permitLines("toolu_new", { ...REQUEST, voice: "新しい依頼" }));
      const freshRow = permitRow({ ...REQUEST, voice: "新しい依頼" }, "toolu_new", {
        uuid: fresh.uuids[0] ?? "",
      });
      const module = handingConn(ctx.daemon, SESSION_A);
      module.hand({
        op: "transcript_push",
        rows: [
          permitRow({ ...REQUEST, voice: "昔の依頼" }, "toolu_old", { uuid: oldUuid }),
          freshRow,
        ],
      });
      module.hand({ op: "transcript_push", rows: [freshRow] });
      // Claude Code writes the lines after the rows went in.
      fs.appendFileSync(file, fresh.text);
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      expect((await speeches()).map((speech) => speech.text)).toEqual(["新しい依頼"]);
      s.close();
    });
  });
});

describe("permit: the requests in a live session's transcript", () => {
  // 何を保証するか: live のセッションの permit の呼び出しは、結果の行が
  // PERMIT_REQUESTED_TEXT で書かれた時に依頼になり、ev:"permit_state" の未読に
  // 出る。断られた呼び出し・結果のまだ無い呼び出し・sidechain の行は出ない。
  test("a call answered as requested is unread; a refused one, one unanswered and a sidechain one are not", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-live-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const now = (): string => new Date().toISOString();
      const permit = { blocked: "x", commands: [{ command: "git push" }] };

      await appendPushed(
        s,
        file,
        permitLines("toolu_waiting", permit, { result: null, timestamp: now() }),
      );
      await appendPushed(
        s,
        file,
        permitLines("toolu_refused", permit, { result: PERMIT_REFUSED_TEXT, timestamp: now() }),
      );
      await appendPushed(
        s,
        file,
        permitLines("toolu_side", permit, { isSidechain: true, timestamp: now() }),
      );
      await appendPushed(s, file, permitLines("toolu_ok", permit, { timestamp: now() }));
      const { ev } = await u.readEventUntil("permit_state", (e) => e.unread.length > 0);
      expect(ev.unread).toMatchObject([{ session_id: SID_A, tool_use_id: "toolu_ok" }]);
      expect(ev.marks).toEqual([]);
      expect(unreadPermits(ctx.daemon.permits).map((p) => p.tool_use_id)).toEqual(["toolu_ok"]);

      // The waiting call's result comes later: it is a request from then on.
      const answer =
        permitLines("toolu_waiting", permit, { timestamp: now() }).split("\n")[1] ?? "";
      await appendPushed(s, file, `${answer}\n`);
      const later = await u.readEventUntil("permit_state", (e) => e.unread.length === 2);
      expect(later.ev.unread.map((p) => p.tool_use_id).sort()).toEqual([
        "toolu_ok",
        "toolu_waiting",
      ]);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: permit_read は tool_use の id で既読にし、ファイルに書いて
  // から答え、全タブに更新を送る。二度押しは成功して何も変えない。知らない id が
  // 混ざると、どれも既読にせず invalid_args で断る。session role は断る。
  test("permit_read marks by tool_use id, writes the file first, and refuses an unknown id", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-read-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const other = await subscribedUser(ctx);
      const permit = { blocked: "x", commands: [{ command: "ls" }] };
      await appendPushed(
        s,
        file,
        permitLines("toolu_1", permit, { timestamp: new Date().toISOString() }),
      );
      await appendPushed(
        s,
        file,
        permitLines("toolu_2", permit, { timestamp: new Date().toISOString() }),
      );
      await other.readEventUntil("permit_state", (e) => e.unread.length === 2);

      expect(await u.request({ op: "permit_read", ids: ["toolu_1", "toolu_x"] })).toEqual({
        ok: false,
        error: { code: "invalid_args", msg: "no permit request with id toolu_x" },
      });
      expect(unreadPermits(ctx.daemon.permits)).toHaveLength(2);

      expect(await u.requestOk({ op: "permit_read", ids: ["toolu_1"] })).toEqual({
        ok: true,
        ids: ["toolu_1"],
      });
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain(
        `"read":{"${SID_A}":["toolu_1"]}`,
      );
      expect((fs.statSync(ctx.daemon.paths.permitState).mode & 0o777).toString(8)).toBe("600");
      const { ev } = await other.readEventUntil("permit_state", (e) => e.unread.length === 1);
      expect(ev.unread.map((p) => p.tool_use_id)).toEqual(["toolu_2"]);

      expect(await u.requestOk({ op: "permit_read", ids: ["toolu_1"] })).toEqual({
        ok: true,
        ids: ["toolu_1"],
      });
      expect((await s.requestError({ op: "permit_read", ids: ["toolu_2"] })).error.code).toBe(
        "bad_request",
      );
      u.close();
      other.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: permit_grant (「許可する」) は依頼を既読と許可済みにし、
  // 写した項目 (intents と commands の位置) を run にする (DR-0040 §8)。既読
  // (無視) にした依頼にも後から許可済みを立てる。ev:"permit_state" の granted と
  // marks に載り、ファイルにも入る。同じものをもう一度送っても何も変えない
  // (送らない)。依頼の行に無い項目は invalid_args、session role は bad_request で
  // 断る。
  test("permit_grant marks the request granted and the items it copied run", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-granted-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const permit = { blocked: "x", intents: ["y"], commands: [{ command: "ls" }] };
      const now = (): string => new Date().toISOString();
      await appendPushed(s, file, permitLines("toolu_a", permit, { timestamp: now() }));
      await appendPushed(s, file, permitLines("toolu_b", permit, { timestamp: now() }));
      await u.readEventUntil("permit_state", (e) => e.unread.length === 2);
      const state = async () => {
        const { ev } = await u.readEventUntil("permit_state");
        return [
          ev.unread.map((p) => p.tool_use_id),
          ev.granted,
          ev.marks.map(({ tool_use_id, kind, index, mark }) => [tool_use_id, kind, index, mark]),
        ];
      };
      const grant = (id: string, items: { kind: "intents" | "commands"; index: number }[]) => ({
        op: "permit_grant" as const,
        sid: SID_A,
        tool_use_id: id,
        items,
      });

      expect(
        (await u.requestError(grant("toolu_a", [{ kind: "commands", index: 1 }]))).error.code,
      ).toBe("invalid_args");
      expect(
        (await s.requestError(grant("toolu_a", [{ kind: "intents", index: 0 }]))).error.code,
      ).toBe("bad_request");
      await u.requestOk(grant("toolu_a", [{ kind: "intents", index: 0 }]));
      expect(await state()).toEqual([["toolu_b"], ["toolu_a"], [["toolu_a", "intents", 0, "run"]]]);
      await u.requestOk({ op: "permit_read", ids: ["toolu_b"] });
      expect(await state()).toEqual([[], ["toolu_a"], [["toolu_a", "intents", 0, "run"]]]);
      await u.requestOk(
        grant("toolu_b", [
          { kind: "intents", index: 0 },
          { kind: "commands", index: 0 },
        ]),
      );
      expect(await state()).toEqual([
        [],
        ["toolu_a", "toolu_b"],
        [
          ["toolu_a", "intents", 0, "run"],
          ["toolu_b", "intents", 0, "run"],
          ["toolu_b", "commands", 0, "run"],
        ],
      ]);
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain(
        `"granted":{"${SID_A}":["toolu_a","toolu_b"]}`,
      );

      await u.requestOk({ op: "permit_read", ids: ["toolu_a"] });
      await u.requestOk(grant("toolu_a", [{ kind: "intents", index: 0 }]));
      await u.request({ op: "ping" });
      expect((await u.pendingEvents()).filter(isKind("permit_state"))).toEqual([]);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: セッションが live でなくなると、その依頼は未読から消える
  // (say と同じ)。終了の途中では空の未読を配らない。
  test("a session no longer live takes its requests out of the unread", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-end-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      await appendPushed(
        s,
        file,
        permitLines(
          "toolu_1",
          { blocked: "x", intents: ["y"] },
          { timestamp: new Date().toISOString() },
        ),
      );
      await u.readEventUntil("permit_state", (e) => e.unread.length === 1);
      await s.end();
      await u.readEventUntil("permit_state", (e) => e.unread.length === 0);
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("permit: a session that is not live", () => {
  // 何を保証するか: module の繋がっていないセッションでも、TL を開いた時の status
  // の一回読みが transcript の依頼を数える。live になったら fold に引き継ぎ、
  // 二重に数えない。
  test("its requests are found on the read that answers its status, and handed to its fold once live", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-scan-");
    try {
      sinceLongAgo(ctx);
      const file = path.join(dir, `${SID_A}.jsonl`);
      const permit = { blocked: "x", commands: [{ command: "ls" }] };
      fs.writeFileSync(
        file,
        permitLines("toolu_1", permit, { timestamp: at(1) }) +
          permitLines("toolu_2", permit, { timestamp: at(2), result: PERMIT_REFUSED_TEXT }),
      );
      await sessionConn(ctx, SID_A, { transcript_path: file });
      const u = await subscribedUser(ctx);
      await u.requestOk({ op: "session_status_subscribe", sid: SID_A });
      const { ev } = await u.readEventUntil("permit_state", (e) => e.unread.length === 1);
      expect(ev.unread).toEqual([{ session_id: SID_A, tool_use_id: "toolu_1", ts: at(1) }]);

      await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      expect(ctx.daemon.permits.scanned.has(SID_A)).toBe(false);
      expect(unreadPermits(ctx.daemon.permits).map((p) => p.tool_use_id)).toEqual(["toolu_1"]);
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 一回読みは、その時に live のセッションの依頼を置き換えない。
  // 見つけた依頼が前と同じなら知らせない。since より前の依頼は手を付けたものと
  // みなす。
  test("the read leaves a live session's, tells only a change, and counts one before since as read", () => {
    const store = loadPermitStore(
      path.join(tmpDir("permit-scan-unit-"), "permit-state.json"),
      { warn: (): void => {} },
      () => new Date("2026-10-28T00:00:00.000Z"),
    );
    const permit = { blocked: "x", intents: ["y"] };
    const old = permitLines("toolu_old", permit, { timestamp: "2026-10-27T00:00:00.000Z" });
    const fresh = permitLines("toolu_new", permit, { timestamp: "2026-10-28T00:00:01.000Z" });
    let told = 0;
    const read = (sid: string, text: string): void => {
      const reader = permitScan(store, sid, () => void (told += 1));
      for (const l of text.split("\n")) if (l !== "") reader.take(l);
      reader.done();
    };
    read(SID_A, old + fresh);
    expect(told).toBe(1);
    expect(unreadPermits(store).map((p) => p.tool_use_id)).toEqual(["toolu_new"]);
    read(SID_A, old + fresh);
    expect(told).toBe(1);
    store.permits.set(SID_B, new Map());
    read(SID_B, fresh);
    expect(told).toBe(1);
    expect(store.scanned.has(SID_B)).toBe(false);
  });
});

// DR-0040 §4: a request whose every action (each command run, each project
// permission applied) is done counts as acted on, without 既読. Its commands
// run are read off the transcript, after the request's result, by the same
// reads that find the requests.
describe("permit: a request whose every action is done", () => {
  const LOG = { warn: (): void => {} };
  const ID = "toolu_acts";

  function storeAt(file: string): PermitStore {
    return loadPermitStore(file, LOG, () => new Date("2026-10-28T00:00:00.000Z"));
  }

  /** A fold of `SID_A`'s lines into `store`: `catchUp` reads lines as the
   * catch-up does (a restart's read of the file), `push` as the live lines
   * after it. `told` counts the calls that may have moved the unread. */
  function foldInto(store: PermitStore): {
    catchUp(text: string): void;
    push(text: string): void;
    told(): number;
  } {
    let told = 0;
    const fold = permitFold(store, SID_A, () => void (told += 1));
    const take = (text: string): void => {
      for (const l of text.split("\n")) if (l !== "") fold.take(l);
      fold.settle();
    };
    return {
      catchUp(text) {
        // The fold reads lines: which file they come from is not its.
        fold.restart(`/p/${SID_A}.jsonl`);
        take(text);
      },
      push: take,
      told: () => told,
    };
  }

  const unreadIds = (store: PermitStore): string[] =>
    unreadPermits(store).map((p) => p.tool_use_id);
  const ts = (secs: number): string => new Date(Date.UTC(2026, 9, 28, 0, 0, secs)).toISOString();
  const request = (input: JsonObject, secs = 1): string =>
    permitLines(ID, { blocked: "x", ...input }, { timestamp: ts(secs) });
  const ran = (command: string, fields: JsonObject = {}): string =>
    bashLines(command, { timestamp: ts(9), ...fields });

  // 何を保証するか: コマンド 2 つの依頼は、1 つ実行しただけでは未読のまま、
  // 2 つ目を実行した時に (どちらが先でも) 未読から外れる。外れた時に onChange
  // で知らせ (全タブに ev:"permit_state" が出る)、人の既読は立てない (派生で
  // あって permit_read ではない)。
  test("two commands: unread after one has run, acted on once both have, in either order", () => {
    for (const order of [
      ["git push", "just deploy"],
      ["just deploy", "git push"],
    ]) {
      const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
      const fold = foldInto(store);
      fold.catchUp(request({ commands: [{ command: "git push" }, { command: "just deploy" }] }));
      expect(unreadIds(store)).toEqual([ID]);
      fold.push(ran(order[0] ?? ""));
      expect(unreadIds(store)).toEqual([ID]);
      const before = fold.told();
      fold.push(ran(order[1] ?? ""));
      expect(unreadIds(store)).toEqual([]);
      expect(fold.told()).toBe(before + 1);
      expect(store.read.ids()).toEqual([]);
    }
  });

  // 何を保証するか: 数えるのは依頼の結果の行より後の、main の <bash-input> の
  // 行で、コマンドが同じもの (CR の改行を LF に、末尾の空白を落として一致) だけ。
  // 依頼より前の実行、違うコマンド、sidechain の行、出力の行は数えない。人が
  // 端末で同じコマンドを ! で打った行も実行に数える (行はどの押下か持たない)。
  test("counts a run of the same command after the request only", () => {
    const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const fold = foldInto(store);
    const command = "echo one\r\necho two  \n";
    fold.catchUp(ran("echo one\necho two") + request({ commands: [{ command }] }, 2));
    expect(unreadIds(store)).toEqual([ID]);
    fold.push(ran("echo one\necho two -x"));
    fold.push(ran("echo one\necho two", { isSidechain: true }));
    fold.push(
      `${line(userContentRow("<bash-stdout>echo one\necho two</bash-stdout><bash-stderr></bash-stderr>", { timestamp: ts(9) }))}\n`,
    );
    expect(unreadIds(store)).toEqual([ID]);
    fold.push(ran("echo one\necho two"));
    expect(unreadIds(store)).toEqual([]);
  });

  // 何を保証するか: intents (文章で求める許可) のある依頼は、コマンドを全部実行
  // しても未読のまま (人が「既読」か「許可する」を押す)。
  test("a request with an intent stays unread when its commands have all run", () => {
    const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const fold = foldInto(store);
    fold.catchUp(request({ intents: ["y"], commands: [{ command: "ls" }] }) + ran("ls"));
    expect(unreadIds(store)).toEqual([ID]);
  });

  // 何を保証するか: 実行の数え上げは transcript から読み直すので、daemon が
  // 再起動しても (同じファイルから作った store の追いつきが 1 つ目の実行の行を
  // 読む)、2 つ目を実行した時に外れる。live でないセッションの一回読みも同じく
  // 数え、見つけた依頼が同じでも実行が増えていれば知らせる。
  test("the runs are read again after a restart, and by the read of a session not live", () => {
    const file = path.join(tmpDir("permit-acts-"), "permit-state.json");
    const asked = request({ commands: [{ command: "a" }, { command: "b" }] });
    const first = storeAt(file);
    foldInto(first).catchUp(asked + ran("a"));
    expect(unreadIds(first)).toEqual([ID]);

    const restarted = storeAt(file);
    const fold = foldInto(restarted);
    fold.catchUp(asked + ran("a"));
    expect(unreadIds(restarted)).toEqual([ID]);
    fold.push(ran("b"));
    expect(unreadIds(restarted)).toEqual([]);

    const scanned = storeAt(file);
    let told = 0;
    const scan = (text: string): void => {
      const reader = permitScan(scanned, SID_A, () => void (told += 1));
      for (const l of text.split("\n")) if (l !== "") reader.take(l);
      reader.done();
    };
    scan(asked + ran("a"));
    expect([unreadIds(scanned), told]).toEqual([[ID], 1]);
    scan(asked + ran("a") + ran("b"));
    expect([unreadIds(scanned), told]).toEqual([[], 2]);
  });

  // 何を保証するか: live のセッションで「! で実行」の行が push で届くと、
  // 最後のコマンドの行で依頼が未読から外れ、ev:"permit_state" が全タブに出る
  // (permit_read を送らなくても)。
  test("over the wire: the last command's row takes the request out of the unread for every tab", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-acts-wire-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const other = await subscribedUser(ctx);
      const now = (): string => new Date().toISOString();
      await appendPushed(
        s,
        file,
        permitLines(
          ID,
          { blocked: "x", commands: [{ command: "git push" }, { command: "just deploy" }] },
          { timestamp: now() },
        ),
      );
      await other.readEventUntil("permit_state", (e) => e.unread.length === 1);
      await appendPushed(s, file, bashLines("git push", { timestamp: now() }));
      await appendPushed(s, file, bashLines("just deploy", { timestamp: now() }));
      for (const tab of [u, other]) {
        const { ev } = await tab.readEventUntil("permit_state", (e) => e.unread.length === 0);
        expect(ev.unread).toEqual([]);
      }
      u.close();
      other.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
  // 何を保証するか: project_permissions だけの依頼は、項目を 1 つ適用しただけ
  // では未読のまま、全部を適用した時に外れる (適用 1 件で既読にはしない)。
  test("project permissions alone: unread until every one is applied", async () => {
    const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    foldInto(store).catchUp(
      request({ project_permissions: [{ add: "Bash(a)" }, { remove: "Bash(b)" }] }),
    );
    await markPermitApplied(store, SID_A, ID, 0, ts(10));
    expect(unreadIds(store)).toEqual([ID]);
    await markPermitApplied(store, SID_A, ID, 1, ts(11));
    expect(unreadIds(store)).toEqual([]);
    expect(store.read.ids()).toEqual([]);
  });

  // 何を保証するか: コマンドと project_permissions が混ざった依頼は、どちらの順で
  // 済ませても、両方の種類が全部済んだ時にだけ外れる。
  test("commands and project permissions: out only once both kinds are all done, in either order", async () => {
    const asked = request({
      commands: [{ command: "ls" }],
      project_permissions: [{ add: "Bash(ls)" }],
    });
    const appliedFirst = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const fold = foldInto(appliedFirst);
    fold.catchUp(asked);
    await markPermitApplied(appliedFirst, SID_A, ID, 0, ts(10));
    expect(unreadIds(appliedFirst)).toEqual([ID]);
    fold.push(ran("ls"));
    expect(unreadIds(appliedFirst)).toEqual([]);

    const ranFirst = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    foldInto(ranFirst).catchUp(asked + ran("ls"));
    expect(unreadIds(ranFirst)).toEqual([ID]);
    await markPermitApplied(ranFirst, SID_A, ID, 0, ts(10));
    expect(unreadIds(ranFirst)).toEqual([]);
  });

  // 何を保証するか: 「やらない」も項目が済んだことに数える。コマンド 2 つの片方を
  // 実行し片方をやらないにすると外れ、settings の項目をやらないにしても外れる。
  // intents は「やらない」だけで済む (run は無い): intents のある依頼は、全部の
  // intent をやらないにした時だけ外れる。同じ項目を 2 度やらないにしても何も
  // 変えない (false)。
  test("やらない counts as done: one command run and one dismissed, a permission dismissed, every intent dismissed", async () => {
    const commands = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const fold = foldInto(commands);
    fold.catchUp(request({ commands: [{ command: "a" }, { command: "b" }] }));
    fold.push(ran("a"));
    expect(await markPermitDismissed(commands, SID_A, ID, "commands", 1, true, ts(10))).toBe(true);
    expect(unreadIds(commands)).toEqual([]);
    expect(await markPermitDismissed(commands, SID_A, ID, "commands", 1, true, ts(11))).toBe(false);

    const settings = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    foldInto(settings).catchUp(
      request({ project_permissions: [{ add: "Bash(a)" }, { add: "Bash(b)" }] }),
    );
    await markPermitApplied(settings, SID_A, ID, 0, ts(10));
    await markPermitDismissed(settings, SID_A, ID, "project_permissions", 1, true, ts(11));
    expect(unreadIds(settings)).toEqual([]);

    const worded = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const wordedFold = foldInto(worded);
    wordedFold.catchUp(request({ intents: ["x", "y"], commands: [{ command: "a" }] }));
    wordedFold.push(ran("a"));
    await markPermitDismissed(worded, SID_A, ID, "intents", 0, true, ts(10));
    expect(unreadIds(worded)).toEqual([ID]);
    await markPermitDismissed(worded, SID_A, ID, "intents", 1, true, ts(11));
    expect(unreadIds(worded)).toEqual([]);
  });

  // 何を保証するか: settings の項目の印を外す (dismissed: false) と、dismiss でも run
  // (適用) でも何も無い状態に戻る。全項目が済んで外れていた依頼は未読に戻る (既読の
  // 集合には入っていないため)。何も無い項目を外しても何も変えない (false)。
  test("taking a settings item's mark off leaves it with none, and the request unread again", async () => {
    const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    foldInto(store).catchUp(
      request({ project_permissions: [{ add: "Bash(a)" }, { remove: "Bash(b)" }] }),
    );
    await markPermitApplied(store, SID_A, ID, 0, ts(10));
    await markPermitDismissed(store, SID_A, ID, "project_permissions", 1, true, ts(11));
    expect(unreadIds(store)).toEqual([]);
    expect(
      await markPermitDismissed(store, SID_A, ID, "project_permissions", 0, false, ts(12)),
    ).toBe(true);
    expect(unreadIds(store)).toEqual([ID]);
    expect(
      await markPermitDismissed(store, SID_A, ID, "project_permissions", 1, false, ts(13)),
    ).toBe(true);
    expect(permitStateEvent(store).marks).toEqual([]);
    expect(
      await markPermitDismissed(store, SID_A, ID, "project_permissions", 1, false, ts(14)),
    ).toBe(false);
  });

  // 何を保証するか: ev:"permit_state" の marks は、依頼ごとの項目を種類と位置で
  // 持つ: コマンドの run (行の時刻)、settings の run (適用時刻)、やらない
  // (押した時刻)。1 項目に 1 つで、やらないの後に実行・適用されると run が勝つ。
  // 何も無い項目 (nothing) は載らない。
  test("the marks hold each item by kind and place, run winning over dismiss", async () => {
    const store = storeAt(path.join(tmpDir("permit-acts-"), "permit-state.json"));
    const fold = foldInto(store);
    fold.catchUp(
      request({
        intents: ["x"],
        commands: [{ command: "a" }, { command: "b" }],
        project_permissions: [{ add: "Bash(a)" }, { add: "Bash(b)" }],
      }),
    );
    await markPermitDismissed(store, SID_A, ID, "commands", 0, true, ts(10));
    await markPermitDismissed(store, SID_A, ID, "project_permissions", 0, true, ts(11));
    await markPermitDismissed(store, SID_A, ID, "intents", 0, true, ts(12));
    fold.push(ran("a"));
    await markPermitApplied(store, SID_A, ID, 0, ts(13));
    // In no order of their own: each item once, here one of each kind.
    const marks = permitStateEvent(store)
      .marks.map(({ kind, index, mark, at }) => [kind, index, mark, at])
      .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(marks).toEqual([
      ["commands", 0, "run", ts(9)],
      ["intents", 0, "dismiss", ts(12)],
      ["project_permissions", 0, "run", ts(13)],
    ]);
  });

  // 何を保証するか: やらないは permit-state.json に入り、daemon が再起動しても
  // (同じファイルから作った store) 残って、ev:"permit_state" の marks に載る。
  // 依頼の中身はファイルに入らない。
  test("やらない stays across a restart", async () => {
    const file = path.join(tmpDir("permit-acts-"), "permit-state.json");
    const asked = request({ commands: [{ command: "a" }, { command: "b" }] });
    const first = storeAt(file);
    foldInto(first).catchUp(asked);
    await markPermitDismissed(first, SID_A, ID, "commands", 0, true, ts(10));

    const restarted = storeAt(file);
    expect(permitStateEvent(restarted).marks).toEqual([
      { tool_use_id: ID, kind: "commands", index: 0, mark: "dismiss", at: ts(10) },
    ]);
    const fold = foldInto(restarted);
    fold.catchUp(asked);
    expect(unreadIds(restarted)).toEqual([ID]);
    fold.push(ran("b"));
    expect(unreadIds(restarted)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).not.toContain('"a"');
  });

  // 何を保証するか: 項目を変更で持っていた applied の要素 (permission を持つ) は、
  // ファイルの残りを読めなくせずに捨てる: 既読・許可済みは残る。
  test("an application kept by its change is dropped, the rest of the file read", async () => {
    const file = path.join(tmpDir("permit-acts-"), "permit-state.json");
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        since: "2026-10-28T00:00:00.000Z",
        read: { [SID_A]: ["toolu_r"] },
        granted: { [SID_A]: ["toolu_r"] },
        applied: [
          { sid: SID_A, tool_use_id: "toolu_r", permission: { add: "Bash(ls)" }, applied_at: "t" },
          { sid: SID_A, tool_use_id: "toolu_n", index: 0, applied_at: "t2" },
        ],
      })}\n`,
    );
    const store = storeAt(file);
    expect([store.read.ids(), store.granted.ids(), store.applied, store.dismissed]).toEqual([
      ["toolu_r"],
      ["toolu_r"],
      [{ sid: SID_A, tool_use_id: "toolu_n", index: 0, applied_at: "t2" }],
      [],
    ]);
  });

  // 何を保証するか: op permit_dismiss は依頼の行にある項目 (種類と位置) だけを
  // 受け、全タブに ev:"permit_state" を送る。知らない依頼・範囲外の位置は
  // invalid_args、session role は bad_request で断る。二度目は成功して何も送らない。
  // dismissed: false で取り消せる (依頼は未読に戻る)。依頼したセッションには何も
  // 届かない。
  test("over the wire: permit_dismiss is the person's, kept and sent to the tabs, and not to the session", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-dismiss-wire-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const other = await subscribedUser(ctx);
      await appendPushed(
        s,
        file,
        permitLines(
          ID,
          {
            blocked: "x",
            commands: [{ command: "git push" }],
            project_permissions: [{ add: "Bash(git push)" }],
          },
          { timestamp: new Date().toISOString() },
        ),
      );
      await other.readEventUntil("permit_state", (e) => e.unread.length === 1);
      await s.pendingEvents();
      const dismiss = (
        kind: PermitItemKind,
        index: number,
        tool_use_id = ID,
        dismissed = true,
      ) => ({
        op: "permit_dismiss" as const,
        sid: SID_A,
        tool_use_id,
        kind,
        index,
        dismissed,
      });

      for (const [kind, index, id] of [
        ["commands", 0, "toolu_x"],
        ["commands", 1, ID],
        ["project_permissions", 1, ID],
        ["intents", 0, ID],
      ] as const) {
        expect((await u.requestError(dismiss(kind, index, id))).error.code).toBe("invalid_args");
      }
      expect((await s.requestError(dismiss("commands", 0))).error.code).toBe("bad_request");

      expect(await u.requestOk(dismiss("commands", 0))).toEqual({ ok: true });
      const { ev } = await other.readEventUntil("permit_state", (e) => e.marks.length === 1);
      expect([
        ev.marks.map(({ tool_use_id, kind, index, mark }) => [tool_use_id, kind, index, mark]),
        ev.unread.map((p) => p.tool_use_id),
      ]).toEqual([[[ID, "commands", 0, "dismiss"]], [ID]]);
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain('"dismissed":[');

      await u.requestOk(dismiss("project_permissions", 0));
      const done = await other.readEventUntil("permit_state", (e) => e.unread.length === 0);
      expect(done.ev.marks).toHaveLength(2);

      await u.requestOk(dismiss("commands", 0));
      await other.request({ op: "ping" });
      expect((await other.pendingEvents()).filter(isKind("permit_state"))).toEqual([]);

      // Taken back (✖️ pressed again): the item is not done, and the request
      // is unread again.
      await u.requestOk(dismiss("commands", 0, ID, false));
      const back = await other.readEventUntil("permit_state", (e) => e.unread.length === 1);
      expect(back.ev.marks.map(({ kind, index }) => [kind, index])).toEqual([
        ["project_permissions", 0],
      ]);
      await s.request({ op: "ping" });
      expect(await s.pendingEvents()).toEqual([]);
      u.close();
      other.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("permit: every request of a session (notification_list)", () => {
  // 何を保証するか: notification_list は main と subagent / teammate の transcript
  // の依頼を全部 (既読も) 時刻順に返す。agent の transcript の断られた呼び出しは
  // 出さない (subagent からの permit は module が断る)。結果で依頼になった agent の
  // 呼び出しは agent_id 付きで出る。行の cwd と、読める形に整えた依頼を持つ。
  test("lists the main and agent transcripts' requests, leaving out the refused ones", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-list-");
    try {
      sinceLongAgo(ctx);
      const file = permitSessionTree(
        dir,
        SID_A,
        permitLines(
          "toolu_m1",
          {
            blocked: "push が止められた",
            attachments: ["/p/a.sh"],
            commands: [{ command: "git push", description: "公開する" }],
            project_permissions: [{ add: "Bash(git push)" }],
            voice: "聞いて",
          },
          { timestamp: at(1), cwd: "/work/one" },
        ) + permitLines("toolu_m2", { blocked: "two", intents: ["y"] }, { timestamp: at(3) }),
        {
          [WORKER]:
            permitLines(
              "toolu_w1",
              { blocked: "worker", intents: ["y"] },
              { timestamp: at(2), isSidechain: true, result: PERMIT_REFUSED_TEXT },
            ) +
            permitLines(
              "toolu_w2",
              { blocked: "worker ok", intents: ["y"] },
              { timestamp: at(4), isSidechain: true },
            ),
        },
      );
      await sessionConn(ctx, SID_A, { transcript_path: file });
      const u = await subscribedUser(ctx);
      const listed = await u.requestOk({ op: "notification_list", sid: SID_A });
      expect(listed.permits).toEqual([
        {
          tool_use_id: "toolu_m1",
          ts: at(1),
          cwd: "/work/one",
          permit: {
            blocked: "push が止められた",
            attachments: ["/p/a.sh"],
            intents: [],
            commands: [{ command: "git push", description: "公開する" }],
            project_permissions: [{ add: "Bash(git push)" }],
          },
        },
        {
          tool_use_id: "toolu_m2",
          ts: at(3),
          cwd: "/work/repo",
          permit: {
            blocked: "two",
            attachments: [],
            intents: ["y"],
            commands: [],
            project_permissions: [],
          },
        },
        {
          tool_use_id: "toolu_w2",
          ts: at(4),
          cwd: "/work/repo",
          permit: {
            blocked: "worker ok",
            attachments: [],
            intents: ["y"],
            commands: [],
            project_permissions: [],
          },
          agent_id: WORKER,
        },
      ]);
      const { ev } = await u.readEventUntil("permit_state", (e) => e.unread.length === 3);
      expect(ev.unread.map((p) => p.tool_use_id)).toEqual(["toolu_m1", "toolu_m2", "toolu_w2"]);

      // A read request is listed too; a later ask reads nothing again.
      await u.requestOk({ op: "permit_read", ids: ["toolu_m1"] });
      fs.appendFileSync(
        file,
        permitLines("toolu_m3", { blocked: "x", intents: ["y"] }, { timestamp: at(5) }),
      );
      const again = await u.requestOk({ op: "notification_list", sid: SID_A });
      expect(again.permits.map((p) => p.tool_use_id)).toEqual(["toolu_m1", "toolu_m2", "toolu_w2"]);
      expect(unreadPermits(ctx.daemon.permits).map((p) => p.tool_use_id)).toEqual([
        "toolu_m2",
        "toolu_w2",
      ]);
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("permit_attachment_read op", () => {
  // 何を保証するか: 人が開いた時点の中身を返す。読めないファイルは理由で答える。
  // daemon がまだそのセッションを読んでいなくても (TL を開かずに op が来ても)、
  // その場で transcript を読んで依頼を探す。
  test("reads a named attachment as it is when the person opens it", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-open-");
    try {
      const policy = path.join(dir, "policy.json");
      const gone = path.join(dir, "gone.sh");
      const file = permitSessionTree(
        dir,
        SID_A,
        permitLines("toolu_1", {
          blocked: "x",
          attachments: [policy, gone],
          commands: [{ command: "ls" }],
        }),
      );
      fs.writeFileSync(policy, '{"allow":["s3:GetObject"]}\n');
      await sessionConn(ctx, SID_A, { transcript_path: file });
      const u = await userConn(ctx);
      expect(
        await u.requestOk({
          op: "permit_attachment_read",
          sid: SID_A,
          tool_use_id: "toolu_1",
          path: policy,
        }),
      ).toEqual({
        ok: true,
        attachment: {
          path: policy,
          read: true,
          content: '{"allow":["s3:GetObject"]}\n',
          bytes: 27,
          truncated: false,
        },
      });
      expect(
        (
          await u.requestOk({
            op: "permit_attachment_read",
            sid: SID_A,
            tool_use_id: "toolu_1",
            path: gone,
          })
        ).attachment,
      ).toEqual({ path: gone, read: false, reason: "missing" });
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 読めるのはその依頼が名指したパスだけで、webui から任意の
  // パスは読めない。依頼でない呼び出し (断られた呼び出し) と知らない id も断る。
  // 読むのは人で、session は読めない。
  test("refuses a path the request did not name, a call that is no request, and a session", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-deny-");
    try {
      const named = path.join(dir, "named.txt");
      const other = path.join(dir, "other.txt");
      fs.writeFileSync(named, "n");
      fs.writeFileSync(other, "secret");
      const input = { blocked: "x", attachments: [named], commands: [{ command: "ls" }] };
      const file = permitSessionTree(
        dir,
        SID_A,
        permitLines("toolu_1", input) +
          permitLines("toolu_refused", input, { result: PERMIT_REFUSED_TEXT }),
      );
      const s = await sessionConn(ctx, SID_A, { transcript_path: file });
      const u = await userConn(ctx);
      const ask = (tool_use_id: string, p: string) => ({
        op: "permit_attachment_read" as const,
        sid: SID_A,
        tool_use_id,
        path: p,
      });
      expect((await u.requestError(ask("toolu_1", other))).error).toEqual({
        code: "invalid_args",
        msg: `permit request toolu_1 names no attachment ${other}`,
      });
      for (const id of ["toolu_refused", "toolu_x"]) {
        expect((await u.requestError(ask(id, named))).error).toEqual({
          code: "invalid_args",
          msg: `no permit request with id ${id} in session ${SID_A}`,
        });
      }
      expect((await s.requestError(ask("toolu_1", named))).error.code).toBe("bad_request");
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("readPermitAttachment", () => {
  // 何を保証するか: 上限より長いファイルは先頭の上限ぶんだけを持ち、全体の
  // 大きさと切り詰めた印を添える。上限で切れた多バイト文字は捨て、壊れた
  // 文字として「テキストでない」にしない。
  test("keeps the start of a long file, leaving out a character the limit cuts", async () => {
    const dir = tmpDir("permit-long-");
    const file = path.join(dir, "long.txt");
    // "あ" is 3 bytes in UTF-8: one more byte than the limit cuts it in two.
    const head = "a".repeat(PERMIT_ATTACHMENT_MAX_BYTES - 1);
    fs.writeFileSync(file, `${head}あ tail`);
    const read = await readPermitAttachment(file);
    expect(read).toEqual({
      path: file,
      read: true,
      content: head,
      bytes: PERMIT_ATTACHMENT_MAX_BYTES - 1 + 3 + 5,
      truncated: true,
    });
  });

  test("a file exactly at the limit is whole", async () => {
    const dir = tmpDir("permit-exact-");
    const file = path.join(dir, "exact.txt");
    fs.writeFileSync(file, "b".repeat(PERMIT_ATTACHMENT_MAX_BYTES));
    const read = await readPermitAttachment(file);
    expect(read).toMatchObject({ read: true, truncated: false });
  });

  // 何を保証するか: 中身を見せられない場合はその理由を区別して返す
  // (webui が理由を書き、エージェントが直し方を選べるように)。
  test("says why a path cannot be shown", async () => {
    const dir = tmpDir("permit-bad-");
    const binary = path.join(dir, "a.bin");
    fs.writeFileSync(binary, new Uint8Array([0x68, 0x00, 0x69]));
    const latin1 = path.join(dir, "a.latin1");
    fs.writeFileSync(latin1, new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    const locked = path.join(dir, "locked.txt");
    fs.writeFileSync(locked, "secret");
    fs.chmodSync(locked, 0o000);
    const reads = await Promise.all(
      [path.join(dir, "none"), dir, binary, latin1, locked].map(readPermitAttachment),
    );
    expect(reads.map((r) => (r.read ? "read" : r.reason))).toEqual([
      "missing",
      "not_a_file",
      "not_text",
      "not_text",
      // root reads a file whatever its mode; the CI's runner is not root.
      process.getuid?.() === 0 ? "read" : "denied",
    ]);
  });

  test("an empty file is read as empty text", async () => {
    const dir = tmpDir("permit-empty-");
    const file = path.join(dir, "empty");
    fs.writeFileSync(file, "");
    expect(await readPermitAttachment(file)).toEqual({
      path: file,
      read: true,
      content: "",
      bytes: 0,
      truncated: false,
    });
  });
});

// 永続化 (DR-0040 §5): 人の状態 (既読、since、適用) は <stateDir>/permit-state.json
// に持ち、daemon の再起動を越えて残る。依頼の中身は持たない。
describe("permit-state.json", () => {
  // 何を保証するか: 既読・since・適用はファイルから読み戻せ、同じファイルから
  // 作った次の store (再起動した daemon) が同じ状態を持つ。ファイルに依頼の中身は
  // 入らない。since より前の依頼は手を付けたものとみなす。
  test("the read ids, since and the applied permissions read back, and nothing of the requests", async () => {
    const file = path.join(tmpDir("permit-state-"), "permit-state.json");
    const log = { warn: (): void => {} };
    const first = loadPermitStore(file, log, () => new Date("2026-10-28T00:00:00.000Z"));
    const seen = (ts: string) => ({
      ts,
      cwd: "/p",
      permit: {
        blocked: "秘密のコマンド",
        attachments: [],
        intents: [],
        commands: [],
        project_permissions: [{ add: "Bash(ls)" }],
      },
      ran: new Map<number, string>(),
    });
    const permits = new Map([
      ["toolu_old", seen("2026-10-27T23:59:59.000Z")],
      ["toolu_1", seen("2026-10-28T00:00:01.000Z")],
      ["toolu_2", seen("2026-10-28T00:00:02.000Z")],
    ]);
    first.permits.set(SID_A, permits);
    expect(unreadPermits(first).map((p) => p.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    await markPermitGranted(first, SID_A, "toolu_1", [], "2026-10-28T00:30:00.000Z");
    await markPermitApplied(first, SID_A, "toolu_2", 0, "2026-10-28T01:00:00.000Z");
    expect(fs.readFileSync(file, "utf8")).not.toContain("秘密のコマンド");

    const second = loadPermitStore(file, log, () => new Date("2026-10-29T00:00:00.000Z"));
    expect(second.since).toBe("2026-10-28T00:00:00.000Z");
    expect(second.granted.ids()).toEqual(["toolu_1"]);
    expect(second.applied).toEqual([
      {
        sid: SID_A,
        tool_use_id: "toolu_2",
        index: 0,
        applied_at: "2026-10-28T01:00:00.000Z",
      },
    ]);
    second.permits.set(SID_A, permits);
    // Applying its only item is acting on the request.
    expect(unreadPermits(second)).toEqual([]);
    expect(await markPermitsRead(second, ["toolu_x"])).toEqual({
      kind: "unknown",
      ids: ["toolu_x"],
    });
  });

  // 何を保証するか: 無いファイルは今を since にして黙って始め、読めないファイル
  // (JSON でない、形が違う) も今から始め直して log に書く (古い依頼で 🔐 が
  // 溢れない)。
  test("a missing file starts from now silently, and one that does not read with a warning", () => {
    const dir = tmpDir("permit-state-");
    const warned: string[] = [];
    const log = { warn: (m: string): void => void warned.push(m) };
    const now = () => new Date("2026-10-28T00:00:00.000Z");
    expect(loadPermitStore(path.join(dir, "missing.json"), log, now).since).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(warned).toEqual([]);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, '{"since":"x","read":[]}\n');
    const store = loadPermitStore(broken, log, now);
    expect({
      since: store.since,
      read: store.read.ids(),
      granted: store.granted.ids(),
      applied: store.applied,
    }).toEqual({
      since: "2026-10-28T00:00:00.000Z",
      read: [],
      granted: [],
      applied: [],
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`permit-state: ${broken}:`);
  });
});
