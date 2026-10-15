// セッションの所在 (DR-0003 §3 「所在の正本」): 所在を名乗れない hello は cwd を
// 空で送り、daemon は登録済みの所在を保持する。peers のような、Bash ツールが cd
// した先で走るコマンドの hello が peers の cwd を一時ディレクトリへ動かさないため
// の規則。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_VERSION, type PeerInfo } from "@ccmsg/protocol";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

async function hello(
  ctx: DaemonCtx,
  sid: string,
  extra: Partial<{ repo: string; ws: string; cwd: string; repo_root: string; branch: string }>,
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: extra.repo ?? "",
    ws: extra.ws ?? "",
    cwd: extra.cwd ?? "",
    ...(extra.repo_root ? { repo_root: extra.repo_root } : {}),
    ...(extra.branch ? { branch: extra.branch } : {}),
  });
  return c;
}

async function peerOf(c: TestClient, sid: string): Promise<PeerInfo | undefined> {
  const res = await c.requestOk({ op: "peers", all: true });
  return res.peers.find((p) => p.sid === sid);
}

describe("session location", () => {
  let ctx: DaemonCtx;
  // 所在として名乗る実在ディレクトリ。daemon は hello 時に cwd を realpath する
  // (macOS の /tmp → /private/tmp) ので、期待値も realpath で突き合わせる。
  let stationed: string;
  let repoRoot: string;

  async function setup(): Promise<void> {
    ctx = await startTestDaemon();
    stationed = path.join(ctx.base, "repo", "main");
    fs.mkdirSync(stationed, { recursive: true });
    repoRoot = fs.realpathSync(path.join(ctx.base, "repo"));
    stationed = fs.realpathSync(stationed);
  }

  test(
    "cwd を空で名乗る hello は登録済みの所在を保つ",
    async () => {
      await setup();
      try {
        // SessionStart 由来の所在を持つ hello (subscribe 相当)。
        const registered = await hello(ctx, A, {
          cwd: stationed,
          repo: "kawaz/repo",
          ws: "main",
          repo_root: repoRoot,
          branch: "main",
        });
        // 別ディレクトリで走ったコマンド相当: 所在の出所を持たないので何も名乗らない。
        const drifted = await hello(ctx, A, {});
        try {
          const peer = await peerOf(drifted, A);
          expect(peer?.cwd).toBe(stationed);
          expect(peer?.repo).toBe("kawaz/repo");
          expect(peer?.ws).toBe("main");
          expect(peer?.repo_root).toBe(repoRoot);
          expect(peer?.branch).toBe("main");
        } finally {
          registered.close();
          drifted.close();
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "所在を名乗る hello は 5 フィールドを丸ごと置き換える",
    async () => {
      await setup();
      try {
        const first = await hello(ctx, B, {
          cwd: stationed,
          repo: "kawaz/repo",
          ws: "main",
          repo_root: repoRoot,
          branch: "main",
        });
        // workspace 層の無い checkout へ移ったセッション: repo_root / branch を
        // 名乗らない hello はそれらを捨てる (古い containment root を持ち続けない)。
        const moved = await hello(ctx, B, { cwd: repoRoot, repo: "kawaz/other", ws: "" });
        try {
          const peer = await peerOf(moved, B);
          expect(peer?.cwd).toBe(repoRoot);
          expect(peer?.repo).toBe("kawaz/other");
          expect(peer?.repo_root).toBeUndefined();
          expect(peer?.branch).toBeUndefined();
        } finally {
          first.close();
          moved.close();
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
