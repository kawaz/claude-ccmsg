// The comment ops over the wire (DR-0062 §9): only the person (user role)
// adds, changes, sends and resolves comments, and the ops answer with the
// shapes the protocol says. The store's behaviour is comments.test.ts's.
// 何を保証するか:
//   - session role のコメントの op は bad_request で断り、何も保存しない
//   - user role の comment_add は未送信のコメントを返し、続く queue_send / 解決 /
//     削除が同じセッションの記録に効く
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import type { Conn } from "../src/server.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = { role: "session", sid: SID, cwd: "" };
const ANCHOR = { kind: "message", uuid: "u-1", on: "応答" } as const;

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
    const daemon = stubDaemon({}, tmp("comments-op-"));
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
    const daemon = stubDaemon({}, tmp("comments-op-"));
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
});
