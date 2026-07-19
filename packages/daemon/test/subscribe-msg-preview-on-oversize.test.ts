// kawaz r34 mid=18: 長文 msg が harness の task-notification truncation で
// wire frame を末尾から切られ、受信 AI が本文取得のため `ccmsg read` を
// 叩き直す往復が発生する事象への予測遮断 (docs/findings/
// 2026-07-19-task-notification-truncation.md 実測、8-9 割で予測遮断)。
//
// daemon の subscribe 出力段 (orderedMsgFrame) は、自然に組んだ frame の
// serialized length が閾値 (WIRE_MSG_SAFE_BYTES、デフォルト 400 bytes、
// env override 可) を超えたら msg 本文を送らず、全文取得コマンドを
// `msg_via` に置く。storage (`rooms/*.jsonl`) は全文のまま保持する
// (= wire frame の reshape のみ、orderedMsgFrame と同層)。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

async function session(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: `ws-${sid}`, cwd: `/tmp/${sid}` });
  return c;
}

interface MsgFrame {
  type: string;
  msg?: string;
  msg_via?: string;
  mid: number;
  r: string;
  reply_hint?: string;
}

async function readNextMsg(sub: TestClient): Promise<{ line: string; frame: MsgFrame }> {
  for (;;) {
    const line = await sub.readLine();
    if (line === null) throw new Error("connection closed before msg arrived");
    const parsed = JSON.parse(line) as { type?: string };
    if (parsed.type === "msg") return { line, frame: parsed as MsgFrame };
  }
}

describe("subscribe: predicted-truncation msg_via guidance", () => {
  test(
    "short msg passes through unchanged (below safe threshold, no msg_via)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const sub = await connect(ctx.sock);
        await sub.hello({ role: "session", sid: "B" });
        await sub.request({ op: "subscribe" });

        const body = "hello there";
        await a.request({ op: "post", room, msg: body });

        const { frame } = await readNextMsg(sub);
        expect(frame.msg).toBe(body);
        expect(frame.msg_via).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "oversize msg is omitted and msg_via gives the exact `ccmsg read` command",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_WIRE_MSG_SAFE_BYTES: "300" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const sub = await connect(ctx.sock);
        await sub.hello({ role: "session", sid: "B" });
        await sub.request({ op: "subscribe" });

        // 300 byte cap を大きく越えるサイズの ascii 本文 (安定 boundary)。
        const body = `${"a".repeat(500)}TAILMARKER`;
        const posted = await a.request<{ mid: number }>({ op: "post", room, msg: body });

        const { line, frame } = await readNextMsg(sub);
        expect(frame.msg).toBeUndefined();
        expect(frame.msg_via).toBe(`Use \`ccmsg read ${room} ${posted.mid}\``);
        expect(line).not.toContain("TAILMARKER");

        // msg_via replaces msg as the last wire key (issue 2026-07-17).
        const keyRe = /"([^"\\]+)":/g;
        const keys: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = keyRe.exec(line)) !== null) keys.push(m[1]);
        expect(keys[keys.length - 1]).toBe("msg_via");
        expect(keys).not.toContain("msg");
        expect(keys).not.toContain("truncated");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "user-role subscriber (webui) always receives the full body — no msg_via",
    async () => {
      // 予測遮断の対象は Monitor → task-notification 経由で truncate される
      // session role のみ。webui (user role) は frame を直接描画するため、
      // 同じ oversize msg でも全文が届かなければならない。
      const ctx = await startTestDaemon({ CCMSG_WIRE_MSG_SAFE_BYTES: "300" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const webui = await connect(ctx.sock);
        await webui.hello({ role: "user" });
        await webui.request({ op: "subscribe" });

        const body = `${"c".repeat(500)}WEBUI-TAIL`;
        await a.request({ op: "post", room, msg: body });

        const { frame } = await readNextMsg(webui);
        expect(frame.msg).toBe(body);
        expect(frame.msg_via).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "storage retains the full msg body regardless of wire-side msg_via",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_WIRE_MSG_SAFE_BYTES: "300" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        // 送信は subscribe を張らずに post のみ (storage は post 時点で
        // append される、DR-0003 §2)。
        const body = `${"b".repeat(500)}FULL-STORED-TAIL`;
        const posted = await a.request<{ mid: number }>({ op: "post", room, msg: body });

        const file = path.join(ctx.roomsDir, `${room}.jsonl`);
        const lines = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        const storedLine = lines.find((l) => {
          const parsed = JSON.parse(l) as { type?: string; mid?: number };
          return parsed.type === "msg" && parsed.mid === posted.mid;
        });
        if (!storedLine) throw new Error("stored msg line not found");
        const stored = JSON.parse(storedLine) as { msg: string; msg_via?: string };
        expect(stored.msg).toBe(body);
        // msg_via は wire 専用の delivery-time hint。
        expect(stored.msg_via).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "default cap (~400) redirects a realistically long msg through msg_via",
    async () => {
      // env override 無しでデフォルト 400 byte cap を効かせる。実測で
      // 500-char event body 相当で harness が切るので、それ以下でも
      // 予測遮断が発火することを確認する。
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const sub = await connect(ctx.sock);
        await sub.hello({ role: "session", sid: "B" });
        await sub.request({ op: "subscribe" });

        // 400 byte cap を意図的に超える (500 chars, ascii なので serialize
        // 後もほぼ 500+overhead)。
        const body = "x".repeat(500);
        const posted = await a.request<{ mid: number }>({ op: "post", room, msg: body });

        const { frame } = await readNextMsg(sub);
        expect(frame.msg).toBeUndefined();
        expect(frame.msg_via).toBe(`Use \`ccmsg read ${room} ${posted.mid}\``);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
