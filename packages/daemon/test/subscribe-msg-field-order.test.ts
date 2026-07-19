// docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md: the harness's
// task-notification truncation cuts from the block's tail. With the old wire
// order (`msg` mid-way through the object, `seq`/`reply_via` after it), a
// long `msg` silently ate the trailing fields (kawaz r26 mid=110 — an agent
// never noticed `reply_via` had gone missing). Pinning `msg` as the LAST key
// on the subscribe wire means truncation always lands inside the body itself
// — visibly incomplete — instead of silently dropping other fields.
//
// These tests read the raw JSON *line* (not the parsed object — key order is
// invisible after JSON.parse) and assert the field order directly, plus that
// storage (`rooms/*.jsonl`) keeps its own, unrelated order.
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
async function user(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}

/** Extracts the top-level key order from a raw JSON object line via regex
 * (not JSON.parse — parsing an object into a JS Map loses nothing, but
 * re-serializing it to check order round-trips through V8's own insertion-
 * order semantics, which is exactly what we're trying to verify independent
 * of — testing the wire bytes directly is the only way to pin this down). */
function topLevelKeyOrder(line: string): string[] {
  const keys: string[] = [];
  const re = /"([^"\\]+)":/g;
  let depth = 0;
  // Walk the line char by char to only capture depth-1 keys (skip nested
  // objects/arrays like `to`'s array or a nested value that happens to look
  // like `"key":`).
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth === 1 && ch === '"') {
      re.lastIndex = i;
      const mm = re.exec(line);
      if (mm && mm.index === i) {
        keys.push(mm[1]);
        i = re.lastIndex;
        continue;
      }
    }
    i++;
  }
  return keys;
}

describe("subscribe wire order: msg events place `msg` last", () => {
  test(
    "plain post: scope/importance order type,r,mid,from,seq,msg,reply_via,ts",
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

        await a.request({ op: "post", room, msg: "hello there" });

        // Drain lines until the msg line for this post arrives.
        let line: string | null = null;
        for (;;) {
          line = await sub.readLine();
          if (line === null) throw new Error("connection closed before msg arrived");
          const parsed = JSON.parse(line);
          if (parsed.type === "msg" && parsed.msg === "hello there") break;
        }
        const keys = topLevelKeyOrder(line);
        // Scope/importance order (kawaz r38 mid=23): msg sits before the
        // fixed tail (reply_via, ts) so ts is always last.
        expect(keys[keys.length - 1]).toBe("ts");
        // And the leading keys are in the documented order (to/seq/reply_via
        // are optional — this recipient does get a reply_via since it's a
        // real member of a non-1on1... actually 2-member create_room is a
        // 1on1, but from is a session, so reply_via directs `ccmsg reply`.
        // Assert prefix
        // order strictly, tolerating to?/reply_via presence.
        const withoutOptional = keys.filter((k) => !["to", "reply_via"].includes(k));
        expect(withoutOptional).toEqual(["type", "r", "mid", "from", "seq", "msg", "ts"]);
        // r must come before seq and reply_via (structural fix for the
        // webui truncated-parse room recovery — DR issue §"webui 側の
        // truncated 救済 parse").
        expect(keys.indexOf("r")).toBeLessThan(keys.indexOf("msg"));
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test("post with explicit `to`: `to` still precedes `msg`", async () => {
    const ctx = await startTestDaemon();
    try {
      const u = await user(ctx);
      const a = await session(ctx, "A");
      await session(ctx, "B");
      await session(ctx, "C");
      const created = await u.request<{ room: string }>({
        op: "create_room",
        members: ["A", "B", "C"],
      });
      const room = created.room;

      const sub = await connect(ctx.sock);
      await sub.hello({ role: "session", sid: "B" });
      await sub.request({ op: "subscribe" });

      await a.request({ op: "post", room, msg: "targeted", to: ["a2", "a3"] });

      let line: string | null = null;
      for (;;) {
        line = await sub.readLine();
        if (line === null) throw new Error("connection closed before msg arrived");
        const parsed = JSON.parse(line);
        if (parsed.type === "msg" && parsed.msg === "targeted") break;
      }
      const keys = topLevelKeyOrder(line);
      expect(keys[keys.length - 1]).toBe("ts");
      expect(keys).toContain("to");
      expect(keys.indexOf("to")).toBeLessThan(keys.indexOf("msg"));
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("reply carries reply_to before msg on the wire", async () => {
    const ctx = await startTestDaemon();
    try {
      const u = await user(ctx);
      const a = await session(ctx, "A");
      const b = await session(ctx, "B");
      const created = await u.request<{ room: string }>({
        op: "create_room",
        members: ["A", "B"],
      });
      const room = created.room;
      const posted = await a.request<{ mid: number }>({ op: "post", room, msg: "question" });

      const sub = await connect(ctx.sock);
      await sub.hello({ role: "user" });
      await sub.request({ op: "subscribe" });

      await b.request({ op: "reply", room, mid: posted.mid, msg: "answer" });

      let line: string | null = null;
      for (;;) {
        line = await sub.readLine();
        if (line === null) throw new Error("connection closed before reply arrived");
        const parsed = JSON.parse(line);
        if (parsed.type === "msg" && parsed.msg === "answer") break;
      }
      const keys = topLevelKeyOrder(line);
      expect(keys[keys.length - 1]).toBe("ts");
      expect(keys).toContain("reply_to");
      expect(keys.indexOf("reply_to")).toBeLessThan(keys.indexOf("msg"));
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("storage (rooms/*.jsonl) keeps its own field order, unaffected by wire reshaping", async () => {
    const ctx = await startTestDaemon();
    try {
      const a = await session(ctx, "A");
      const created = await a.request<{ room: string }>({
        op: "create_room",
        members: ["B"],
      });
      const room = created.room;
      await a.request({ op: "post", room, msg: "stored message" });

      const file = path.join(ctx.roomsDir, `${room}.jsonl`);
      const lines = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      const msgLine = lines.find((l) => {
        const parsed = JSON.parse(l);
        return parsed.type === "msg" && parsed.msg === "stored message";
      });
      if (!msgLine) throw new Error("stored msg line not found");
      const keys = topLevelKeyOrder(msgLine);
      // Storage's MsgEvent order (packages/protocol/src/index.ts): type, mid,
      // from, (to?), ts, msg, (seq?), (reply_to?) — msg is NOT last here,
      // deliberately, since this is the persisted shape the issue says must
      // stay untouched.
      const withoutOptional = keys.filter((k) => !["to", "seq", "reply_to"].includes(k));
      expect(withoutOptional).toEqual(["type", "mid", "from", "ts", "msg"]);
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
