// peers の connected_at / last_activity_at (webui セッションリストの安定ソート +
// idle 時間表示の元データ): connected_at はこの daemon プロセスで sid のエントリが
// 最初に作られた時刻で再接続しても変わらない、last_activity_at はその sid の
// いずれかの conn からリクエストが来るたび進む。
//
// peers クエリ自体もそのセッションの conn からの「リクエスト」なので、A 自身の
// conn で peers を呼ぶと A の last_activity_at を毎回進めてしまい観測が汚染される
// (webui は user role の別 conn から peers するので実運用では起きない)。そのため
// 本テストでは peers 照会は常に別途繋いだ admin (role: "user") conn で行う。
// 同一パターン (real daemon over UDS) は branch.test.ts / transcript.test.ts を踏襲。
import { describe, expect, test } from "bun:test";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

async function sessionHello(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "session", sid, repo: "r", ws: "w", cwd: "/tmp" });
  return c;
}

async function adminConn(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user" });
  return c;
}

interface PeerLite {
  sid: string;
  connected_at?: string;
  last_activity_at?: string;
}

async function getPeer(admin: TestClient, sid: string): Promise<PeerLite> {
  const res = await admin.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
  const me = res.peers.find((p) => p.sid === sid);
  if (!me) throw new Error(`peer ${sid} not found in ${JSON.stringify(res.peers)}`);
  return me;
}

describe("peers timestamps", () => {
  test(
    "hello 直後は connected_at と last_activity_at が両方載る",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await sessionHello(ctx, "A");
        const admin = await adminConn(ctx);
        const me = await getPeer(admin, "A");
        expect(me.connected_at).toBeDefined();
        expect(() => new Date(me.connected_at as string).toISOString()).not.toThrow();
        // hello 自体も post-dispatch 更新の対象なので、最初の照会時点で
        // last_activity_at も既に載っているはず
        expect(me.last_activity_at).toBeDefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "セッション側のリクエストのたびに last_activity_at が進む (connected_at は不変)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A");
        const admin = await adminConn(ctx);
        const first = await getPeer(admin, "A");
        await new Promise((res) => setTimeout(res, 10));
        await c.request({ op: "ping" });
        const second = await getPeer(admin, "A");
        expect(Date.parse(second.last_activity_at as string)).toBeGreaterThan(
          Date.parse(first.last_activity_at as string),
        );
        expect(second.connected_at).toBe(first.connected_at);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "同じ conn を保ったまま再 hello しても connected_at は変わらない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A");
        const admin = await adminConn(ctx);
        const first = await getPeer(admin, "A");
        await new Promise((res) => setTimeout(res, 10));
        // 2 回目の hello (repo/ws/cwd の再宣言、latest-hello-wins パス) は
        // registerSession の既存 entry パスを通る — connectedAt を持つ entry
        // はそのまま、上書きされない
        await c.request({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r2",
          ws: "w",
          cwd: "/tmp",
        });
        const second = await getPeer(admin, "A");
        expect(second.connected_at).toBe(first.connected_at);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "conn が切れて sid のエントリが消えた後、別 conn で hello し直すと connected_at は新しくなる",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c1 = await sessionHello(ctx, "A");
        const admin = await adminConn(ctx);
        const first = await getPeer(admin, "A");
        c1.close();
        await new Promise((res) => setTimeout(res, 50));
        await new Promise((res) => setTimeout(res, 10));
        const c2 = await sessionHello(ctx, "A");
        const second = await getPeer(admin, "A");
        expect(second.connected_at).not.toBe(first.connected_at);
        c2.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "subscribe のぶら下がり (push のみ) は last_activity_at を進めない — 明示リクエストのみが進める",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A");
        const admin = await adminConn(ctx);
        await c.request({ op: "subscribe" });
        const afterSubscribe = await getPeer(admin, "A");
        // admin から room に post して A 宛の push イベントを飛ばす — A 自身は
        // リクエストを送っていないので last_activity_at は動かないはず
        await admin.request({ op: "create_room", members: ["A"], msg: "hi" });
        await new Promise((res) => setTimeout(res, 30));
        const afterPush = await getPeer(admin, "A");
        expect(afterPush.last_activity_at).toBe(afterSubscribe.last_activity_at);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
