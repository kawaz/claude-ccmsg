// hello's `branch` field (informational, webui session list): unlike
// transcript_path (DR-0009's preserve-on-omit exception), branch follows the
// same "latest hello wins" rule as repo/ws/cwd — each hello's meta.branch is
// simply whatever that hello announced, omitted-or-not. Each test starts a
// daemon in this process and talks to it over UDS (same fixture pattern as
// transcript.test.ts).
import { describe, expect, test } from "bun:test";
import {
  connect,
  startInProcessDaemon,
  stopInProcessDaemon,
  defined,
  sessionConn,
} from "./helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";

describe("hello branch field", () => {
  test("非空の branch は peers に載る", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { branch: "feat/branch-label" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.branch).toBe("feat/branch-label");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("branch を省略すると peers に現れない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A);
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("空文字の branch も peers に現れない (「」は「未指定」と同じ扱い)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { branch: "" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // repo/ws/cwd と同じ "latest hello wins" — transcript_path の
  // preserve-on-omit 特例はここでは適用されない: 省略した再 hello は
  // branch をクリアする (直前の meta を保持しない)。
  test("branch 申告済みの sid が、省略しての再 hello 後は peers から消える (latest-hello-wins)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const sid = A;
      await sessionConn(ctx, sid, { branch: "main" });
      await sessionConn(ctx, sid, { cwd: "/tmp/other" });

      const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("branch 申告済みの sid が、別の branch での再 hello で更新される", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const sid = A;
      await sessionConn(ctx, sid, { branch: "main" });
      await sessionConn(ctx, sid, { branch: "feature/x" });

      const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.branch).toBe("feature/x");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
