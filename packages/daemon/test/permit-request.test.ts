// 許可依頼 (DR-0040) の daemon 側の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - permit_request は読み上げだけをして { ok } で答える。依頼の中身は持たず、
//     タブには何も送らない (依頼は transcript の permit の行)
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
//
// wire 越しに確かめる op なので、同じプロセスに立てた daemon に UDS で繋ぐ。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PERMIT_ATTACHMENT_MAX_BYTES } from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { readPermitAttachment } from "../src/permit-attachment.ts";
import {
  loadPermitStore,
  markPermitApplied,
  markPermitsRead,
  permitScan,
  unreadPermits,
} from "../src/permit-state.ts";
import { relaysCaughtUp } from "../src/transcript-relay.ts";
import {
  appendPushed,
  isKind,
  liveSessionConn,
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { at, PERMIT_REFUSED_TEXT, permitLines, permitSessionTree } from "./permit-rows.ts";

const SID_A = "9e700000-0000-4000-8000-000000000001";
const SID_B = "9e700000-0000-4000-8000-000000000002";
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

describe("permit_request op", () => {
  // 何を保証するか: permit_request は voice (無ければ固定文) を読み上げ、{ ok }
  // で答える。タブには何も送らない (依頼は transcript の行で、daemon は中身を
  // 持たない)。
  test("speaks the voice or the fixed sentence, and pushes nothing to the tabs", async () => {
    const work = tmpDir("permit-say-");
    const spokenFile = path.join(work, "spoken");
    const speech = writeMockBin(
      path.join(work, "say"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(spokenFile)}\n`,
    );
    const ctx = await startInProcessDaemon({ env: { CCMSG_SAY_BIN: speech } });
    try {
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
      await ctx.daemon.speaker.idle();
      expect(fs.readFileSync(spokenFile, "utf8")).toBe("-- push の許可を\n-- 許可を求めています\n");
      await u.request({ op: "ping" });
      expect((await u.pendingEvents()).filter(isKind("permit_state"))).toEqual([]);
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
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
      expect(ev.applied).toEqual([]);
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
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain('"read":["toolu_1"]');
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

  // 何を保証するか: granted 付きの既読 (「許可する」) は既読と許可済みを立てる。
  // 既読 (無視) にした依頼にも後から許可済みを立てる。granted の無い既読は
  // 許可済みを立てず、許可済みの依頼の既読・許可は何も変えない (送らない)。
  // ev:"permit_state" の granted に載り、ファイルにも入る。
  test("granted marks the request permitted too, after a plain read as well", async () => {
    const ctx = await startInProcessDaemon();
    const dir = tmpDir("permit-granted-");
    try {
      const file = path.join(dir, `${SID_A}.jsonl`);
      fs.writeFileSync(file, "");
      const s = await liveSessionConn(ctx, SID_A, { transcript_path: file });
      await relaysCaughtUp(ctx.daemon.transcriptRelay);
      const u = await subscribedUser(ctx);
      const permit = { blocked: "x", commands: [{ command: "ls" }] };
      const now = (): string => new Date().toISOString();
      await appendPushed(s, file, permitLines("toolu_a", permit, { timestamp: now() }));
      await appendPushed(s, file, permitLines("toolu_b", permit, { timestamp: now() }));
      await u.readEventUntil("permit_state", (e) => e.unread.length === 2);
      const state = async () => {
        const { ev } = await u.readEventUntil("permit_state");
        return [ev.unread.map((p) => p.tool_use_id), ev.granted];
      };

      await u.requestOk({ op: "permit_read", ids: ["toolu_a"], granted: true });
      expect(await state()).toEqual([["toolu_b"], ["toolu_a"]]);
      await u.requestOk({ op: "permit_read", ids: ["toolu_b"] });
      expect(await state()).toEqual([[], ["toolu_a"]]);
      await u.requestOk({ op: "permit_read", ids: ["toolu_b"], granted: true });
      expect(await state()).toEqual([[], ["toolu_a", "toolu_b"]]);
      expect(fs.readFileSync(ctx.daemon.paths.permitState, "utf8")).toContain(
        '"granted":["toolu_a","toolu_b"]',
      );

      await u.requestOk({ op: "permit_read", ids: ["toolu_a"] });
      await u.requestOk({ op: "permit_read", ids: ["toolu_a"], granted: true });
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
    });
    const permits = new Map([
      ["toolu_old", seen("2026-10-27T23:59:59.000Z")],
      ["toolu_1", seen("2026-10-28T00:00:01.000Z")],
      ["toolu_2", seen("2026-10-28T00:00:02.000Z")],
    ]);
    first.permits.set(SID_A, permits);
    expect(unreadPermits(first).map((p) => p.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);
    expect(await markPermitsRead(first, ["toolu_1"], true)).toEqual({ kind: "read" });
    await markPermitApplied(first, "toolu_2", { add: "Bash(ls)" }, "2026-10-28T01:00:00.000Z");
    expect(fs.readFileSync(file, "utf8")).not.toContain("秘密のコマンド");

    const second = loadPermitStore(file, log, () => new Date("2026-10-29T00:00:00.000Z"));
    expect(second.since).toBe("2026-10-28T00:00:00.000Z");
    expect([...second.granted]).toEqual(["toolu_1"]);
    expect(second.applied).toEqual([
      {
        tool_use_id: "toolu_2",
        permission: { add: "Bash(ls)" },
        applied_at: "2026-10-28T01:00:00.000Z",
      },
    ]);
    second.permits.set(SID_A, permits);
    // Applying is acting on the request, as 許可する is.
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
      read: [...store.read],
      granted: [...store.granted],
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
