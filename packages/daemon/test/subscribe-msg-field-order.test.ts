// docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md: a consumer that
// truncates a long line cuts from its tail. Pinning `msg` as the LAST key on
// the subscribe wire means truncation always lands inside the body itself —
// visibly incomplete — instead of silently dropping other fields. The wire
// order is type,r,mid,from[,seq,to,reply_to][,replay],ts,msg, observed on the
// user-role subscriber (the only role whose stream carries `msg`).
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

/** Reads raw lines on `sub` until the msg frame whose body is `body`. */
async function readMsgLine(sub: TestClient, body: string): Promise<string> {
  for (;;) {
    const line = await sub.readLine();
    if (line === null) throw new Error("connection closed before msg arrived");
    const parsed = JSON.parse(line);
    if (parsed.type === "msg" && parsed.msg === body) return line;
  }
}

describe("subscribe wire order: msg events place `msg` last", () => {
  test(
    "plain post: type,r,mid,from,seq,ts,msg",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const sub = await user(ctx);
        await sub.request({ op: "subscribe" });

        await a.request({ op: "post", room, msg: "hello there" });

        const keys = topLevelKeyOrder(await readMsgLine(sub, "hello there"));
        expect(keys).toEqual(["type", "r", "mid", "from", "seq", "ts", "msg"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test("post with explicit `to`: `to` follows seq and precedes ts,msg", async () => {
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

      const sub = await user(ctx);
      await sub.request({ op: "subscribe" });

      await a.request({ op: "post", room, msg: "targeted", to: ["a2", "a3"] });

      const keys = topLevelKeyOrder(await readMsgLine(sub, "targeted"));
      expect(keys).toEqual(["type", "r", "mid", "from", "seq", "to", "ts", "msg"]);
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test("reply carries reply_to before ts,msg on the wire", async () => {
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

      const sub = await user(ctx);
      await sub.request({ op: "subscribe" });

      await b.request({ op: "reply", room, mid: posted.mid, msg: "answer" });

      const keys = topLevelKeyOrder(await readMsgLine(sub, "answer"));
      expect(keys).toEqual(["type", "r", "mid", "from", "seq", "to", "reply_to", "ts", "msg"]);
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  test(
    "recent-replay frame: `replay` sits before ts,msg",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        await a.request({ op: "post", room: created.room, msg: "before subscribe" });

        const sub = await user(ctx);
        await sub.request({ op: "subscribe" });

        const keys = topLevelKeyOrder(await readMsgLine(sub, "before subscribe"));
        expect(keys).toEqual(["type", "r", "mid", "from", "seq", "replay", "ts", "msg"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

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
