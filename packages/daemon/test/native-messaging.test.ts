// PeerInfo.send_message: 「この peer には Claude Code ネイティブの SendMessage が
// 届く」を答える面 (CLAUDE_CONFIG_DIR) 比較。単体 (normalize / compare) と、
// 実 daemon を UDS 越しに叩く peers の実配線の両方を見る。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canNativeSendMessage, normalizeConfigDir } from "../src/native-messaging.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const T = 15000;

describe("normalizeConfigDir", () => {
  test("末尾スラッシュ・冗長な区切りを畳んで比較可能な綴りにする", () => {
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp/"));
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp//"));
    expect(normalizeConfigDir("/tmp")).toBe(normalizeConfigDir("/tmp/./"));
  });

  test("symlink を辿って実体の綴りに揃える (面が同じなら綴り違いでも一致)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-cfgdir-"));
    try {
      const real = path.join(base, "real-config");
      const link = path.join(base, "link-config");
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      expect(normalizeConfigDir(link)).toBe(normalizeConfigDir(real));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("存在しないパスは realpath できなくても綴りのまま残す (比較材料としては有効)", () => {
    expect(normalizeConfigDir("/definitely/not/here/.claude")).toBe("/definitely/not/here/.claude");
  });

  test("比較材料にならない申告 (空・相対・非文字列) は undefined", () => {
    expect(normalizeConfigDir(undefined)).toBeUndefined();
    expect(normalizeConfigDir("")).toBeUndefined();
    expect(normalizeConfigDir("   ")).toBeUndefined();
    expect(normalizeConfigDir(".claude")).toBeUndefined();
    expect(normalizeConfigDir("~/.claude")).toBeUndefined();
  });
});

describe("canNativeSendMessage", () => {
  test("同一面なら届く", () => {
    expect(canNativeSendMessage("/home/u/.claude", "/home/u/.claude")).toBe(true);
  });

  test("別面なら届かない", () => {
    expect(canNativeSendMessage("/home/u/.claude", "/home/u/.claude-work")).toBe(false);
  });

  test("どちらかの判定素材が無ければ届かない側に倒す", () => {
    expect(canNativeSendMessage(undefined, "/home/u/.claude")).toBe(false);
    expect(canNativeSendMessage("/home/u/.claude", undefined)).toBe(false);
    expect(canNativeSendMessage(undefined, undefined)).toBe(false);
  });
});

interface PeerLite {
  sid: string;
  send_message?: true;
}

async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  configDir?: string,
): Promise<Awaited<ReturnType<typeof connect>>> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    ...(configDir ? { config_dir: configDir } : {}),
  });
  return c;
}

async function peersOf(c: Awaited<ReturnType<typeof connect>>): Promise<Map<string, PeerLite>> {
  const res = await c.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
  return new Map(res.peers.map((p) => [p.sid, p]));
}

describe("peers の send_message フラグ", () => {
  test(
    "同一面の peer にだけ付き、別面・面不明・自分自身には付かない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const home = os.homedir();
        const askerConn = await sessionHello(ctx, "ASKER", path.join(home, ".claude-personal"));
        await sessionHello(ctx, "SAME", path.join(home, ".claude-personal/"));
        await sessionHello(ctx, "OTHER", path.join(home, ".claude-work"));
        await sessionHello(ctx, "UNKNOWN");

        const peers = await peersOf(askerConn);
        expect(peers.get("SAME")?.send_message).toBe(true);
        expect(peers.get("OTHER")?.send_message).toBeUndefined();
        expect(peers.get("UNKNOWN")?.send_message).toBeUndefined();
        // 自分宛の SendMessage は用途が無いので自分の行には付けない
        expect(peers.get("ASKER")?.send_message).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "面を申告していないセッションから見れば同一面の相手にも付かない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const cfg = path.join(os.homedir(), ".claude-personal");
        const askerConn = await sessionHello(ctx, "ASKER");
        await sessionHello(ctx, "PEER", cfg);
        const peers = await peersOf(askerConn);
        expect(peers.get("PEER")?.send_message).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "user role (webui) の peers には比較の相手が無いのでフラグを出さない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const cfg = path.join(os.homedir(), ".claude-personal");
        await sessionHello(ctx, "A", cfg);
        await sessionHello(ctx, "B", cfg);
        const admin = await connect(ctx.sock);
        await admin.request({ op: "hello", role: "user" });
        const peers = await peersOf(admin);
        expect(peers.get("A")?.send_message).toBeUndefined();
        expect(peers.get("B")?.send_message).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "config_dir を省いた re-hello は前の申告を消さない (subscribe と post で env が違っても保つ)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const cfg = path.join(os.homedir(), ".claude-personal");
        const askerConn = await sessionHello(ctx, "ASKER", cfg);
        const peerConn = await sessionHello(ctx, "PEER", cfg);
        expect((await peersOf(askerConn)).get("PEER")?.send_message).toBe(true);
        // 同じ sid の別 conn が config_dir 無しで hello (旧 CLI / env を失った
        // subprocess) しても、確立済みの面は保たれる
        await peerConn.request({
          op: "hello",
          role: "session",
          sid: "PEER",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        expect((await peersOf(askerConn)).get("PEER")?.send_message).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
