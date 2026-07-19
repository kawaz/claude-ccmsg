// kawaz r34 mid=18: 長文 msg が harness の task-notification truncation で
// wire frame を末尾から切られ、受信 AI が本文取得のため `ccmsg read` を
// 叩き直す往復が発生する事象への予測遮断 (docs/findings/
// 2026-07-19-task-notification-truncation.md 実測、8-9 割で予測遮断)。
//
// daemon の subscribe 出力段 (orderedMsgFrame) は、自然に組んだ frame の
// serialized length が閾値 (WIRE_MSG_SAFE_BYTES、デフォルト 400 bytes、
// env override 可) を超えたら msg 本文をプレビュー + 案内文に差し替え、
// `truncated:true` を付ける。storage (`rooms/*.jsonl`) は全文のまま保持
// する (= wire frame の reshape のみ、orderedMsgFrame と同層)。
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
  msg: string;
  mid: number;
  r: string;
  truncated?: boolean;
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

describe("subscribe: predicted-truncation preview + ccmsg read guidance", () => {
  test(
    "short msg passes through unchanged (below safe threshold, no truncated flag)",
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
        expect(frame.truncated).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "oversize msg becomes preview + `ccmsg read <room> <mid>` guidance and truncated:true",
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
        expect(frame.truncated).toBe(true);
        // Guidance points at the exact ccmsg read command for this msg.
        expect(frame.msg).toContain(`ccmsg read ${room} ${posted.mid}`);
        // Preview retains a leading chunk of the original body.
        expect(frame.msg.startsWith("a")).toBe(true);
        // Tail marker beyond the preview budget must NOT appear in the
        // frame — that's the whole point (receiver has to read to see it).
        expect(frame.msg).not.toContain("TAILMARKER");
        // msg is still the last key on the wire (issue 2026-07-17).
        // The last `":"` key in the raw line must be `"msg"`.
        const keyRe = /"([^"\\]+)":/g;
        const keys: string[] = [];
        let m: RegExpExecArray | null;
        // Only depth-1 keys — msg is a plain string (no nested braces of its
        // own), so simple regex is enough for this preview form.
        while ((m = keyRe.exec(line)) !== null) keys.push(m[1]);
        expect(keys[keys.length - 1]).toBe("msg");
        // `truncated` must sit immediately before msg (added right before
        // the msg re-assignment in orderedMsgFrame).
        expect(keys[keys.length - 2]).toBe("truncated");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "user-role subscriber (webui) always receives the full body — no preview",
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
        expect(frame.truncated).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "storage retains the full msg body regardless of wire-side preview",
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
        const stored = JSON.parse(storedLine) as { msg: string; truncated?: boolean };
        expect(stored.msg).toBe(body);
        // storage は truncated flag を持たない (wire 専用の delivery-time
        // hint、reply_hint と同じ扱い)。
        expect(stored.truncated).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "default cap (~400) triggers preview for realistically long msg (kawaz r34 mid=18 shape)",
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
        expect(frame.truncated).toBe(true);
        expect(frame.msg).toContain(`ccmsg read ${room} ${posted.mid}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
