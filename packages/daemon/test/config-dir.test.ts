// セッションの面 (CLAUDE_CONFIG_DIR) の正規化と、面が違っても peers の返事が
// 同じ `ccmsg:` 宛先を出すこと (DR-0037 §1) を、実 daemon を UDS 越しに叩いて見る。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeConfigDir } from "../src/config-dir.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const T = 15000;
const ASKER = "a5000000-0000-4000-8000-000000000001";
const OTHER = "07000000-0000-4000-8000-000000000003";
const UNKNOWN = "00000000-0000-4000-8000-000000000004";

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

async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  configDir?: string,
): Promise<Awaited<ReturnType<typeof connect>>> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    ...(configDir ? { config_dir: configDir } : {}),
  });
  return c;
}

async function addressesOf(
  c: Awaited<ReturnType<typeof connect>>,
): Promise<Map<string, readonly string[]>> {
  const res = await c.requestOk({ op: "peers" });
  return new Map(res.peers.map((p) => [p.sid, p.addresses ?? []]));
}

describe("peers の宛先", () => {
  test(
    "面の違うセッションにも、面不明のセッションにも、user role (webui) にも同じ ccmsg: 宛先を出す",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const home = os.homedir();
        const askerConn = await sessionHello(ctx, ASKER, path.join(home, ".claude-personal"));
        const otherConn = await sessionHello(ctx, OTHER, path.join(home, ".claude-work"));
        const unknownConn = await sessionHello(ctx, UNKNOWN);
        const admin = await connect(ctx.sock);
        await admin.request({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });

        // hello が cwd を realpath で採るので、/tmp は macOS では /private/tmp
        const cwd = fs.realpathSync("/tmp");
        const expected = new Map(
          [ASKER, OTHER, UNKNOWN].map((sid) => [sid, [`ccmsg:${sid}`, `ccmsg:path:${cwd}`]]),
        );
        expect(await addressesOf(askerConn)).toEqual(expected);
        expect(await addressesOf(otherConn)).toEqual(expected);
        expect(await addressesOf(unknownConn)).toEqual(expected);
        expect(await addressesOf(admin)).toEqual(expected);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
