// What the daemon pushes, as the schemas say it (DR-0038): every push of its
// own and every storage event as delivered reads back whole — nothing left
// out — and one whose fields are not of their types is a failure.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import {
  DeliveredEventSchema,
  type DeliveredEvent,
  PushStreamEventSchema,
  type PushStreamEvent,
} from "../src/stream-event.ts";

const SID = "11111111-2222-4333-8444-555555555555";

/** As it travels: what the daemon's JSON.stringify writes, decoded. */
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

/** Each push's samples, by `ev` (typed, so a sample that is not that push
 * does not compile, and a push without samples does not either). */
const PUSHES: {
  readonly [Ev in PushStreamEvent["ev"]]: readonly Extract<PushStreamEvent, { ev: Ev }>[];
} = {
  notify: [
    { ev: "notify", text: "hi", from: { role: "user" } },
    { ev: "notify", text: "just push", from: { role: "session", sid: SID } },
    { ev: "notify", text: "keepalive", from: { role: "gateway" } },
  ],
  restarting: [{ ev: "restarting" }, { ev: "restarting", reason: "upgrade" }],
  subscribe_superseded: [{ ev: "subscribe_superseded", sid: SID }],
  room_cursors: [{ ev: "room_cursors", rooms: [{ room: "r1", last_mid: 3 }] }],
  agents: [
    {
      ev: "agents",
      agents: [
        {
          pid: 1,
          cwd: "/w",
          kind: "interactive",
          startedAt: 2,
          sessionId: SID,
          name: "n",
          status: "idle",
          config_dir: "/c",
          hyoui_session_id: "h1",
        },
      ],
      polled_at: "2026-10-09T00:00:00.000Z",
    },
  ],
  peers: [
    {
      ev: "peers",
      peers: [
        { sid: SID, repo: "kawaz/x", ws: "main", cwd: "/w", branch: "main", protocol: 3 },
        {
          sid: SID,
          repo: "",
          ws: "",
          cwd: "",
          stale_client: { last_seen: "2026-10-09T00:00:00.000Z" },
        },
      ],
    },
  ],
  transcript: [
    { ev: "transcript", sid: SID, lines: ['{"type":"user"}'], start: 10, end: 26, size: 26 },
  ],
  session_status: [
    {
      ev: "session_status",
      sid: SID,
      todos: [{ id: "1", subject: "s", status: "pending" }],
      workflows: [],
      background: [],
      teammates: [],
      external_files: [],
      api_error: { text: "Please run /login", timestamp: "t" },
    },
  ],
  session_errors: [
    { ev: "session_errors", errors: [{ sid: SID, text: "API Error: 500", timestamp: "t" }] },
    { ev: "session_errors", errors: [] },
  ],
  net_online: [{ ev: "net_online", text: "the network is back", error_ts: "t" }],
  llm_requests: [
    {
      ev: "llm_requests",
      requests: [
        { ts: 1, session_id: SID, prefix: "", main: false },
        {
          ts: 2,
          session_id: SID,
          prefix: "abcd1234",
          main: true,
          origin: "main",
          cache_expires_at: 3,
          cache_ttl_secs: 3600,
          cache_paused: false,
          cache_since: 4,
          cache_count: 1,
          next_keepalive_at: 5,
          cache_until: 6,
          cache_until_count: 7,
          cache_breakeven_until: 8,
          cache_breakeven_count: 9,
          keepalive: "applied",
          ns: "n",
          model: "claude-x",
          credential: "main",
          status: 200,
        },
      ],
    },
  ],
  llm_status: [
    {
      ev: "llm_status",
      report: {
        overall: { severity: "warning", service_counts: { warning: 1 } },
        services: [{ id: "s", name: "s", severity: "warning", routes: ["main"] }],
      },
    },
  ],
};

/** Each storage event as delivered, by `type`. */
const DELIVERED: {
  readonly [T in DeliveredEvent["type"]]: readonly Extract<DeliveredEvent, { type: T }>[];
} = {
  member: [
    {
      type: "member",
      r: "r1",
      id: "u2",
      sid: SID,
      repo: "kawaz/x",
      ws: "main",
      cwd: "/w",
      joined_at: "t",
      role: "guest",
      seq: 1,
    },
  ],
  leave: [{ type: "leave", r: "r1", id: "a1", ts: "t", seq: 2 }],
  msg: [
    { type: "msg", r: "r1", mid: 1, from: "u1", ts: "t", msg: "hi", seq: 3 },
    {
      type: "msg",
      r: "r1",
      mid: 2,
      from: "a1",
      to: ["u1"],
      reply_to: "r1m1",
      replay: true,
      ts: "t",
      msg: "yo",
      seq: 4,
    },
  ],
  next: [{ type: "next", r: "r1", room: "r2", ts: "t", seq: 5 }],
  prev: [{ type: "prev", r: "r2", room: "r1", ts: "t", seq: 1 }],
  title: [{ type: "title", r: "r1", title: "t", ts: "t", seq: 6 }],
  archive: [{ type: "archive", r: "r1", archived: false, ts: "t", seq: 7 }],
  kind: [
    { type: "kind", r: "r3", kind: "broadcast", ts: "t", seq: 1 },
    { type: "kind", r: "r4", kind: "1on1", ts: "t" },
  ],
  say: [{ type: "say", r: "r4", sid: SID, text: "hello", ts: "t", seq: 2 }],
  say_read: [{ type: "say_read", r: "r4", ref: 2, ts: "t", seq: 3 }],
};

describe("PushStreamEventSchema", () => {
  for (const [ev, samples] of Object.entries(PUSHES)) {
    test(`${ev}: what the daemon sends reads back whole`, () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(parseWith(PushStreamEventSchema, wire(sample))).toEqual({ ok: true, value: sample });
      }
    });
  }

  test("an ev this client does not know is a failure", () => {
    const read = parseWith(PushStreamEventSchema, { ev: "something_new", x: 1 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.summary).toContain("ev");
  });

  test("a field of another type names the field", () => {
    const read = parseWith(PushStreamEventSchema, { ev: "transcript", sid: SID, lines: [1] });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.issues[0]?.path).toBe("lines.0");
  });

  test("a notify from a role nobody sends is a failure", () => {
    expect(
      parseWith(PushStreamEventSchema, { ev: "notify", text: "x", from: { role: "admin" } }).ok,
    ).toBe(false);
    expect(
      parseWith(PushStreamEventSchema, { ev: "notify", text: "x", from: { role: "session" } }).ok,
    ).toBe(false);
  });
});

describe("DeliveredEventSchema", () => {
  for (const [type, samples] of Object.entries(DELIVERED)) {
    test(`${type}: what the daemon sends reads back whole`, () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(parseWith(DeliveredEventSchema, wire(sample))).toEqual({ ok: true, value: sample });
      }
    });
  }

  test("an event without its room is a failure", () => {
    const read = parseWith(DeliveredEventSchema, { type: "title", title: "t", ts: "t" });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.issues.map((i) => i.path)).toEqual(["r"]);
  });

  test("replay is only ever true", () => {
    expect(
      parseWith(DeliveredEventSchema, {
        type: "msg",
        r: "r1",
        mid: 1,
        from: "u1",
        ts: "t",
        msg: "m",
        replay: false,
      }).ok,
    ).toBe(false);
  });

  test("a type no storage event has is a failure", () => {
    expect(parseWith(DeliveredEventSchema, { type: "link", r: "r1", ts: "t" }).ok).toBe(false);
  });
});
