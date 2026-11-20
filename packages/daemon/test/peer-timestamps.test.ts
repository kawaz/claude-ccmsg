// peers の connected_at / last_activity_at (webui セッションリストの安定ソート +
// idle 時間表示の元データ): connected_at はこの daemon プロセスで sid のエントリが
// 最初に作られた時刻で再接続しても変わらない。last_activity_at はそのセッションが
// 仕事をした request (会話に行が入った transcript_push、エージェントの ccmsg の
// tool の request) で進み、接続 (hello)・サイドカーの名乗り (sidecar_hello)・読む
// だけの request (ping 等) では進まない (DR-0053 §3)。daemon が起動し直すと
// サイドカーは名乗り直し、module は依頼のたびに hello するので、それらを活動と
// 数えると経過時間が「再起動からの時間」「最後の接続からの時間」になってしまう。
//
// peers 照会は別途繋いだ admin (role: "user") conn で行う (webui と同じ形)。
// 同一パターン (real daemon over UDS) は branch.test.ts / transcript.test.ts を踏襲。
import { describe, expect, test } from "bun:test";
import {
  nameRun,
  startInProcessDaemon,
  stopInProcessDaemon,
  type TestClient,
  sessionConn,
  userConn,
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

/** A row going into `c`'s session's conversation, as its hooks module pushes it (transcript_push): the session working. */
async function pushARow(c: TestClient): Promise<void> {
  await c.requestOk({
    op: "transcript_push",
    rows: [{ uuid: crypto.randomUUID(), door: "response", message: {} }],
  });
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

interface PeerLite {
  sid: string;
  connected_at?: string;
  last_activity_at?: string;
}

async function getPeer(admin: TestClient, sid: string): Promise<PeerLite> {
  const res = await admin.requestOk({ op: "peers" });
  const me = res.peers.find((p) => p.sid === sid);
  if (!me) throw new Error(`peer ${sid} not found in ${JSON.stringify(res.peers)}`);
  return me;
}

describe("peers timestamps", () => {
  // hello は接続であって仕事ではない。transcript の無いセッションには活動の記録がまだ何も無いので、last_activity_at は載らない (connected_at は載る)。
  test("hello だけでは connected_at だけが載り、last_activity_at は載らない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      const me = await getPeer(admin, A);
      expect(me.connected_at).toBeDefined();
      expect(() => new Date(me.connected_at ?? "").toISOString()).not.toThrow();
      expect(me.last_activity_at).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("会話に行が入る request (transcript_push) のたびに last_activity_at が進む (connected_at は不変)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      await pushARow(c);
      const first = await getPeer(admin, A);
      expect(first.last_activity_at).toBeDefined();
      await new Promise((res) => setTimeout(res, 10));
      await pushARow(c);
      const second = await getPeer(admin, A);
      expect(Date.parse(second.last_activity_at ?? "")).toBeGreaterThan(
        Date.parse(first.last_activity_at ?? ""),
      );
      expect(second.connected_at).toBe(first.connected_at);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // 読むだけの request (ping)、同じ内容の hello の再送、サイドカーの名乗り (sidecar_hello) は活動ではない: どれも daemon の再起動や module の依頼のたびに起き、セッションが何かをしたことを意味しない。
  test("ping・hello の再送・sidecar_hello では last_activity_at は進まない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      await pushARow(c);
      const first = await getPeer(admin, A);
      await new Promise((res) => setTimeout(res, 10));
      await c.requestOk({ op: "ping" });
      await c.requestOk({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: A,
        cwd: "/tmp",
      });
      await nameRun(ctx, c);
      const second = await getPeer(admin, A);
      expect(second.last_activity_at).toBe(first.last_activity_at);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("同じ conn を保ったまま再 hello しても connected_at は変わらない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      const first = await getPeer(admin, A);
      await new Promise((res) => setTimeout(res, 10));
      // 2 回目の hello (repo/ws/cwd の再宣言、latest-hello-wins パス) は
      // registerSession の既存 entry パスを通る — connectedAt を持つ entry
      // はそのまま、上書きされない
      await c.request({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: A,
        cwd: "/tmp",
      });
      const second = await getPeer(admin, A);
      expect(second.connected_at).toBe(first.connected_at);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("conn が切れた後に別 conn で hello し直しても connected_at は変わらない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c1 = await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      const first = await getPeer(admin, A);
      c1.close();
      await new Promise((res) => setTimeout(res, 50));
      await new Promise((res) => setTimeout(res, 10));
      const c2 = await sessionConn(ctx, A);
      const second = await getPeer(admin, A);
      expect(second.connected_at).toBe(first.connected_at);
      c2.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("A 宛ての notify は A の last_activity_at を進めない — A 自身の明示リクエストのみが進める", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A);
      const admin = await userConn(ctx);
      await pushARow(c);
      const before = await getPeer(admin, A);
      expect(before.last_activity_at).toBeDefined();
      // 別のセッション B が A 宛てに notify を送る。進むのは送った B の
      // last_activity_at (notify は B のエージェントの仕事) で、受け手の A は
      // 何もリクエストしていない
      const b = await sessionConn(ctx, B);
      await b.requestOk({ op: "notify", sid: A, text: "hi" });
      const after = await getPeer(admin, A);
      expect(after.last_activity_at).toBe(before.last_activity_at);
      expect((await getPeer(admin, B)).last_activity_at).toBeDefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
