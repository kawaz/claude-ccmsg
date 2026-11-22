// The comment ops over the wire (DR-0062 §9): only the person (user role)
// adds, changes, sends and resolves comments, and the ops answer with the
// shapes the protocol says. The store's behaviour is comments.test.ts's.
// 何を保証するか:
//   - session role のコメントの op は bad_request で断り、何も保存しない
//   - user role の comment_add は未送信のコメントを返し、続く queue_send / 解決 /
//     削除が同じセッションの記録に効く
//   - daemon が transcript を見つけられないセッションへのコメントの op は
//     session_not_found で断り、何も保存しない
//   - 配線 (DR-0062 §10、§11、P35): session_status_subscribe の始まりに
//     ev:"comments"、記録が変わると見ている全ての接続に ev:"comment"
//     (購読をやめた接続には送らない)。push された人の行にブロックがあれば
//     delivered、turn が responding から idle になると照合できない sent は
//     unconfirmed
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { commentBlockText, ErrorCode, type UserComment } from "@ccmsg/protocol";
import { line as jsonl, userContentRow } from "../../protocol/test/transcript-rows.ts";
import { commentsFile } from "../src/comments.ts";
import type { Conn } from "../src/server.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";
import {
  appendPushed,
  liveSessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = { role: "session", sid: SID, cwd: "" };
const ANCHOR = { kind: "message", uuid: "u-1", on: "応答" } as const;

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

/** A stub daemon (drive-request.ts) that finds SID's transcript. */
function daemonWithSession(base: string) {
  transcriptUnder(path.join(base, "home"));
  return stubDaemon({}, base);
}

describe("comment ops", () => {
  test("a session's agent may not add, send or resolve the person's comments", async () => {
    const daemon = stubDaemon({}, tmp("comments-op-"));
    const requests = [
      {
        op: "comment_add",
        request_id: "r1",
        session_id: SID,
        anchor: ANCHOR,
        body: "x",
        send_now: false,
      },
      {
        op: "queue_send",
        request_id: "r2",
        session_id: SID,
        items: [{ kind: "comment", cid: "c0000", seen_updated_at: "t" }],
      },
      {
        op: "comment_resolve",
        request_id: "r3",
        session_id: SID,
        cid: "c0000",
        resolved: true,
        seen_cid: "c0000",
      },
    ] as const;
    for (const request of requests) {
      const refused = await requestError(daemon, SESSION, request);
      expect(refused.error.code).toBe(ErrorCode.bad_request);
    }
    expect(await daemon.comments.list(SID)).toEqual([]);
    await daemon.comments.settled();
  });

  test("the person adds a comment and takes it back", async () => {
    const daemon = daemonWithSession(tmp("comments-op-"));
    const added = await requestOk(daemon, USER, {
      op: "comment_add",
      request_id: "r1",
      session_id: SID,
      anchor: ANCHOR,
      quote: "この関数は",
      body: "ここは?",
      send_now: false,
    });
    expect(added.comment).toMatchObject({ status: "draft", body: "ここは?", anchor: ANCHOR });
    expect(added.outcome).toBeUndefined();
    const deleted = await requestOk(daemon, USER, {
      op: "comment_delete",
      request_id: "r2",
      session_id: SID,
      cid: added.comment.cid,
      seen_updated_at: added.comment.updated_at,
    });
    expect(deleted).toEqual({ ok: true });
    const again = await requestError(daemon, USER, {
      op: "comment_delete",
      request_id: "r3",
      session_id: SID,
      cid: added.comment.cid,
      seen_updated_at: added.comment.updated_at,
    });
    expect(again.error.code).toBe(ErrorCode.not_found);
    await daemon.comments.settled();
  });

  test("sending to a session with no hooks module leaves the comment a draft with why", async () => {
    const daemon = daemonWithSession(tmp("comments-op-"));
    const added = await requestOk(daemon, USER, {
      op: "comment_add",
      request_id: "r1",
      session_id: SID,
      anchor: ANCHOR,
      body: "ここは?",
      send_now: false,
    });
    const sent = await requestOk(daemon, USER, {
      op: "queue_send",
      request_id: "r2",
      session_id: SID,
      items: [
        { kind: "comment", cid: added.comment.cid, seen_updated_at: added.comment.updated_at },
      ],
    });
    expect(sent.results).toEqual([
      { kind: "comment", id: added.comment.cid, outcome: "not_delivered", reason: "no_module" },
    ]);
    const [record] = await daemon.comments.list(SID);
    expect(record).toMatchObject({ status: "draft", send_error: "no_module" });
    await daemon.comments.settled();
  });
  test("a comment on a session the daemon finds no transcript of is refused", async () => {
    const daemon = stubDaemon({}, tmp("comments-op-"));
    const refused = await requestError(daemon, USER, {
      op: "comment_add",
      request_id: "r1",
      session_id: SID,
      anchor: ANCHOR,
      body: "x",
      send_now: false,
    });
    expect(refused.error.code).toBe(ErrorCode.session_not_found);
    expect(await daemon.comments.list(SID)).toEqual([]);
    await daemon.comments.settled();
  });
});

/** A daemon in this process, with SID's transcript under its HOME. */
async function withDaemon(run: (ctx: InProcessDaemon, transcript: string) => Promise<void>) {
  const ctx = await startInProcessDaemon();
  try {
    const transcript = transcriptUnder(path.join(ctx.base, "d", "home"));
    await run(ctx, transcript);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

/** A comment the person sent `msAgo` ago, kept in the daemon's file before it
 * reads it, the composer having taken it (`sent`). */
function keptSent(ctx: InProcessDaemon, msAgo: number): UserComment {
  const at = new Date(Date.now() - msAgo).toISOString();
  const comment: UserComment = {
    kind: "comment",
    author: "user",
    cid: "c0000",
    session_id: SID,
    anchor: ANCHOR,
    quote: "この関数は",
    body: "ここは?",
    written: { at },
    sent: { at, after_uuid: "u-1" },
    updated_at: at,
    btw: false,
    status: "sent",
  };
  const file = commentsFile(path.join(ctx.base, "s"), SID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(comment)}\n`);
  return comment;
}

describe("the wiring (DR-0062 §10, §11, P35)", () => {
  test("a tab that looks at the session gets its comments, and every tab looking gets each change", async () => {
    await withDaemon(async (ctx) => {
      const a = await userConn(ctx);
      const b = await userConn(ctx);
      for (const tab of [a, b]) {
        await tab.requestOk({ op: "session_status_subscribe", sid: SID });
        const first = await tab.readEventUntil("comments");
        expect(first.ev).toEqual({ ev: "comments", session_id: SID, comments: [], threads: [] });
      }
      // Another tab, looking at nothing, adds one: both looking are told.
      const adder = await userConn(ctx);
      const added = await adder.requestOk({
        op: "comment_add",
        session_id: SID,
        anchor: ANCHOR,
        body: "ここは?",
        send_now: false,
      });
      for (const tab of [a, b]) {
        const told = await tab.readEventUntil("comment");
        expect(told.ev.comment).toEqual(added.comment);
      }
      expect((await adder.pendingEvents()).filter((ev) => "ev" in ev)).toEqual([]);
      // b stops looking; a still is told, b is not.
      await b.requestOk({ op: "session_status_unsubscribe", sid: SID });
      await adder.requestOk({
        op: "comment_delete",
        session_id: SID,
        cid: added.comment.cid,
        seen_updated_at: added.comment.updated_at,
      });
      const deleted = await a.readEventUntil("comment");
      expect(deleted.ev.comment).toMatchObject({ cid: added.comment.cid, status: "deleted" });
      expect((await b.pendingEvents()).filter((ev) => "ev" in ev && ev.ev === "comment")).toEqual(
        [],
      );
      // A tab that closed is passed over.
      await a.end();
      const again = await adder.requestOk({
        op: "comment_add",
        session_id: SID,
        anchor: ANCHOR,
        body: "もう一つ",
        send_now: false,
      });
      expect(again.comment.status).toBe("draft");
    });
  });

  test("a row the session's module pushes with the comment's block makes it delivered", async () => {
    await withDaemon(async (ctx, transcript) => {
      const comment = keptSent(ctx, 1000);
      const module = await liveSessionConn(ctx, SID, { transcript_path: transcript });
      const tab = await userConn(ctx);
      await tab.requestOk({ op: "session_status_subscribe", sid: SID });
      const first = await tab.readEventUntil("comments");
      expect(first.ev.comments).toEqual([comment]);
      const block = commentBlockText({
        cid: comment.cid,
        on: "応答",
        quote: "この関数は",
        body: "ここは?",
      });
      await appendPushed(
        module,
        transcript,
        `${jsonl(
          userContentRow(block, { promptSource: "typed", timestamp: new Date().toISOString() }),
        )}\n`,
      );
      const delivered = await tab.readEventUntil("comment");
      expect(delivered.ev.comment).toMatchObject({ cid: comment.cid, status: "delivered" });
    });
  });

  test("a turn that ends without the comment's block makes it unconfirmed", async () => {
    await withDaemon(async (ctx, transcript) => {
      const comment = keptSent(ctx, 10_000);
      const module = await liveSessionConn(ctx, SID, { transcript_path: transcript });
      const tab = await userConn(ctx);
      await tab.requestOk({ op: "session_status_subscribe", sid: SID });
      await tab.readEventUntil("comments");
      const began = Date.now() - 5000;
      await module.requestOk({
        op: "session_facts",
        facts: { at: began, turn: { state: "responding", since: began } },
      });
      await module.requestOk({
        op: "session_facts",
        facts: { at: Date.now(), turn: { state: "idle", since: Date.now() } },
      });
      const unconfirmed = await tab.readEventUntil("comment");
      expect(unconfirmed.ev.comment).toMatchObject({ cid: comment.cid, status: "unconfirmed" });
    });
  });
});
