// 許可依頼 (DR-0040) の daemon 側の契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - permit_request は依頼を daemon のメモリに記録し、attachments をその時点で
//     読んで記録に写す。読めなかったものは理由を、長いものは先頭だけを持つ
//   - 記録は user role にだけ届く: subscribe 時に全件 (空でも)
//     ev:"permit_requests"、記録のたびに 1 件の ev:"permit_request"。session
//     には流さない
//   - 応答は記録の id と attachments ごとの結果 (中身は返さない)
//   - role gate: permit_request は session 限定
//   - 記録の数には上限があり、古いものから消える
//
// wire 越しに確かめる op なので、同じプロセスに立てた daemon に UDS で繋ぐ。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PERMIT_ATTACHMENT_MAX_BYTES, type PermitRequestRecord } from "@ccmsg/protocol";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { createPermitRequestLog, readPermitAttachment } from "../src/permit-requests.ts";
import {
  isKind,
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";

const SID_A = "9e700000-0000-4000-8000-000000000001";
const SID_B = "9e700000-0000-4000-8000-000000000002";

const tmpDir = perTestTmpDir();

/** A subscribed user connection and the requests its subscribe-time
 * catch-up carried. */
async function subscribedUser(
  ctx: InProcessDaemon,
): Promise<{ u: TestClient; requests: readonly PermitRequestRecord[] }> {
  const u = await userConn(ctx);
  await u.request({ op: "subscribe" });
  const { ev } = await u.readEventUntil("permit_requests");
  return { u, requests: ev.requests };
}

describe("permit_request op", () => {
  // 何を保証するか: 依頼は呼んだセッション自身の sid で記録され、user の
  // subscribe に 1 件ずつ届く。intents / commands は書かれた順のまま、無い
  // list は空で入る。
  test("records the request as the asking session's and pushes it to user subscribers", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const { u, requests: before } = await subscribedUser(ctx);
      expect(before).toEqual([]);
      const s = await sessionConn(ctx, SID_A);
      const answered = await s.requestOk({
        op: "permit_request",
        permit: {
          blocked: "`git push` が止められた",
          commands: ["git push origin main", "git push origin v1 \\\n  --tags"],
        },
      });
      expect(answered.attachments).toEqual([]);
      const { ev } = await u.readEventUntil("permit_request");
      expect(ev.request).toMatchObject({
        id: answered.id,
        sid: SID_A,
        blocked: "`git push` が止められた",
        attachments: [],
        intents: [],
        commands: ["git push origin main", "git push origin v1 \\\n  --tags"],
        read: false,
      });
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: attachments は依頼の時点で daemon が読み、記録はその時の
  // 中身を持つ (後でファイルが変わっても記録は変わらない)。応答は中身を
  // 返さず、読めたか・切り詰めたかだけを返す。
  test("reads each attachment when the request comes, and answers without the contents", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const dir = tmpDir("permit-att-");
      const policy = path.join(dir, "policy.json");
      fs.writeFileSync(policy, '{"allow":["s3:GetObject"]}\n');
      const gone = path.join(dir, "gone.sh");
      const s = await sessionConn(ctx, SID_A);
      const { u } = await subscribedUser(ctx);
      const answered = await s.requestOk({
        op: "permit_request",
        permit: { blocked: "x", attachments: [policy, gone], intents: ["policy を当てる"] },
      });
      expect(answered.attachments).toEqual([
        { path: policy, read: true, truncated: false },
        { path: gone, read: false, reason: "missing" },
      ]);
      fs.writeFileSync(policy, "changed later\n");
      const { ev } = await u.readEventUntil("permit_request");
      expect(ev.request.attachments).toEqual([
        {
          path: policy,
          read: true,
          content: '{"allow":["s3:GetObject"]}\n',
          bytes: 27,
          truncated: false,
        },
        { path: gone, read: false, reason: "missing" },
      ]);
      // A tab that subscribes later catches up with the same record.
      const { u: later, requests } = await subscribedUser(ctx);
      expect(requests).toEqual([ev.request]);
      later.close();
      u.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか (「セッションへの echo は不要」、say と同じ): 依頼は
  // session の subscribe には subscribe 時にも記録の後にも届かない。
  test("pushes requests to user subscribers only, never to a session", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const asker = await sessionConn(ctx, SID_B);
      await asker.request({ op: "subscribe" });
      const { u } = await subscribedUser(ctx);
      await asker.requestOk({ op: "permit_request", permit: { blocked: "x", commands: ["ls"] } });
      await u.readEventUntil("permit_request");
      // 順序の確定した round trip の後で、asker の stream に無いことを見る。
      await asker.request({ op: "ping" });
      const events = await asker.pendingEvents();
      expect(events.filter(isKind("permit_request"))).toEqual([]);
      expect(events.filter(isKind("permit_requests"))).toEqual([]);
      u.close();
      asker.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 許可依頼は止められたエージェント自身が出すもので、user
  // role (webui) からは記録を作れない。
  test("requires session role", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      const res = await u.requestError({
        op: "permit_request",
        permit: { blocked: "x", commands: ["ls"] },
      });
      expect(res.error).toEqual({
        code: "bad_request",
        msg: "op 'permit_request' requires session role",
      });
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 何も求めていない依頼 (intents も commands も無い) は、
  // daemon が読む前に形の誤りとして断られる。
  test("refuses a request that asks for nothing", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const s = await sessionConn(ctx, SID_A);
      const res = await s.requestError({ op: "permit_request", permit: { blocked: "x" } });
      expect(res.error.code).toBe("invalid_args");
      expect(res.error.msg).toContain("ask for at least one of intents and commands");
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("permit_request_read op", () => {
  // 何を保証するか: 既読は渡した id の記録だけを read にし (他は未読のまま)、
  // 変わった記録を 1 件ずつ全タブに送る。二度目の既読は成功を返し、何も
  // 送らない (ボタンの連打は普通に起きる)。
  test("marks the named requests read, pushing each one changed to every tab", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const s = await sessionConn(ctx, SID_A);
      const permit = { blocked: "x", commands: ["ls"] };
      const a = await s.requestOk({ op: "permit_request", permit });
      const b = await s.requestOk({ op: "permit_request", permit });
      const { u, requests } = await subscribedUser(ctx);
      expect(requests.map((r) => [r.id, r.read])).toEqual([
        [a.id, false],
        [b.id, false],
      ]);
      const { u: otherTab } = await subscribedUser(ctx);

      expect(await u.request({ op: "permit_request_read", ids: [a.id] })).toMatchObject({
        ok: true,
        ids: [a.id],
      });
      for (const tab of [u, otherTab]) {
        const { ev } = await tab.readEventUntil("permit_request");
        expect([ev.request.id, ev.request.read]).toEqual([a.id, true]);
      }
      expect(ctx.daemon.permitRequests.snapshot().map((r) => r.read)).toEqual([true, false]);

      expect(await u.request({ op: "permit_request_read", ids: [a.id] })).toMatchObject({
        ok: true,
      });
      await u.request({ op: "ping" });
      expect((await u.pendingEvents()).filter(isKind("permit_request"))).toEqual([]);
      u.close();
      otherTab.close();
      s.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 何を保証するか: 存在しない id の既読は黙って成功せず、どれも既読に
  // しない。既読は人の操作なので session からは立てられない。
  test("refuses an id that is no request, and a session asking", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const s = await sessionConn(ctx, SID_A);
      const a = await s.requestOk({
        op: "permit_request",
        permit: { blocked: "x", commands: ["ls"] },
      });
      const u = await userConn(ctx);
      const res = await u.requestError({ op: "permit_request_read", ids: [a.id, "0000/9"] });
      expect(res.error).toEqual({
        code: "invalid_args",
        msg: "no permit request with id 0000/9",
      });
      expect(ctx.daemon.permitRequests.snapshot().map((r) => r.read)).toEqual([false]);
      const bySession = await s.requestError({ op: "permit_request_read", ids: [a.id] });
      expect(bySession.error.code).toBe("bad_request");
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

describe("permit request log", () => {
  // 何を保証するか: 記録の数には上限があり、超えたら古いものから消える
  // (daemon は何日も動くので、上限が無いとメモリが増え続ける)。
  test("keeps the newest requests up to its limit", () => {
    let n = 0;
    const log = createPermitRequestLog(() => `i/${String(++n)}`, 2);
    const fields = (blocked: string) => ({
      sid: SID_A,
      ts: "t",
      blocked,
      attachments: [],
      intents: [],
      commands: ["ls"],
    });
    log.add(fields("one"));
    log.add(fields("two"));
    log.add(fields("three"));
    expect(log.snapshot().map((r) => [r.id, r.blocked])).toEqual([
      ["i/2", "two"],
      ["i/3", "three"],
    ]);
  });
});
