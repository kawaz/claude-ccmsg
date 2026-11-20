// hello's `branch` field, which the daemon carries in the peer row's
// `vcs.branch` (the only source of a jj bookmark): unlike transcript_path
// (DR-0009's preserve-on-omit exception), branch follows the same "latest
// hello wins" rule as cwd — each hello's branch is simply whatever that hello
// announced, omitted-or-not. Each session works in a jj checkout of its own,
// whose files name no branch. Each test starts a daemon in this process and
// talks to it over UDS (same fixture pattern as transcript.test.ts).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  asJjCheckout,
  connect,
  type InProcessDaemon,
  startInProcessDaemon,
  stopInProcessDaemon,
  defined,
  sessionConn,
} from "./helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";

/** A jj checkout for the session to work in, under the daemon's base (removed
 * with it). */
function checkout(ctx: InProcessDaemon): string {
  return fs.realpathSync(asJjCheckout(path.join(ctx.base, "checkout")));
}

describe("hello branch field", () => {
  test("非空の branch は peers に載る", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { cwd: checkout(ctx), branch: "feat/branch-label" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.vcs?.branch).toBe("feat/branch-label");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("branch を省略すると peers に現れない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { cwd: checkout(ctx) });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.vcs?.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("空文字の branch も peers に現れない (「」は「未指定」と同じ扱い)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, A, { cwd: checkout(ctx), branch: "" });
      const peers = await c.requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === A),
        `the peer ${A}`,
      );
      expect(me.vcs?.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // cwd と同じ "latest hello wins" — transcript_path の
  // preserve-on-omit 特例はここでは適用されない: 省略した再 hello は
  // branch をクリアする (直前の meta を保持しない)。
  test("branch 申告済みの sid が、省略しての再 hello 後は peers から消える (latest-hello-wins)", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const sid = A;
      const cwd = checkout(ctx);
      await sessionConn(ctx, sid, { cwd, branch: "main" });
      await sessionConn(ctx, sid, { cwd });

      const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.vcs?.branch).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("branch 申告済みの sid が、別の branch での再 hello で更新される", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const sid = A;
      const cwd = checkout(ctx);
      await sessionConn(ctx, sid, { cwd, branch: "main" });
      await sessionConn(ctx, sid, { cwd, branch: "feature/x" });

      const peers = await (await connect(ctx.sock)).requestOk({ op: "peers" });
      const me = defined(
        peers.peers.find((p) => p.sid === sid),
        `the peer ${sid}`,
      );
      expect(me.vcs?.branch).toBe("feature/x");
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
