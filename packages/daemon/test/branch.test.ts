// hello's `branch` field (informational, webui session list): unlike
// transcript_path (DR-0009's preserve-on-omit exception), branch follows the
// same "latest hello wins" rule as repo/ws/cwd — each hello's meta.branch is
// simply whatever that hello announced, omitted-or-not. Each test spawns a
// real daemon over UDS (same fixture pattern as transcript.test.ts).
import { describe, expect, test } from "bun:test";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

/** Connect + hello as a session, optionally announcing a branch. Raw request
 *  (bypassing TestClient.hello's narrower typed signature), same pattern as
 *  fs-access.test.ts's sessionAtWithRoot / transcript.test.ts's sessionHello. */
async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  opts: { cwd?: string; branch?: string } = {},
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: opts.cwd ?? "/tmp",
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
  });
  return c;
}

interface PeerLite {
  sid: string;
  branch?: string;
}

describe("hello branch field", () => {
  test(
    "非空の branch は peers に載る",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A", { branch: "feat/branch-label" });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === "A")!;
        expect(me.branch).toBe("feat/branch-label");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "branch を省略すると peers に現れない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A");
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === "A")!;
        expect(me.branch).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "空文字の branch も peers に現れない (「」は「未指定」と同じ扱い)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await sessionHello(ctx, "A", { branch: "" });
        const peers = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === "A")!;
        expect(me.branch).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // repo/ws/cwd と同じ "latest hello wins" — transcript_path の
  // preserve-on-omit 特例はここでは適用されない: 省略した再 hello は
  // branch をクリアする (直前の meta を保持しない)。
  test(
    "branch 申告済みの sid が、省略しての再 hello 後は peers から消える (latest-hello-wins)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const sid = "A";
        await sessionHello(ctx, sid, { branch: "main" });
        await sessionHello(ctx, sid, { cwd: "/tmp/other" });

        const peers = await (
          await connect(ctx.sock)
        ).request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.branch).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "branch 申告済みの sid が、別の branch での再 hello で更新される",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const sid = "A";
        await sessionHello(ctx, sid, { branch: "main" });
        await sessionHello(ctx, sid, { branch: "feature/x" });

        const peers = await (
          await connect(ctx.sock)
        ).request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const me = peers.peers.find((p) => p.sid === sid)!;
        expect(me.branch).toBe("feature/x");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
