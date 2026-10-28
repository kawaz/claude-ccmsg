// What the daemon pushes, as the schemas say it (DR-0038): every push reads
// back whole — nothing left out — and one whose fields are not of their types
// is a failure.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import { StreamEventSchema, type StreamEvent } from "../src/stream-event.ts";

const SID = "11111111-2222-4333-8444-555555555555";

/** As it travels: what the daemon's JSON.stringify writes, decoded. */
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

/** Each push's samples, by `ev` (typed, so a sample that is not that push
 * does not compile, and a push without samples does not either). */
const PUSHES: {
  readonly [Ev in StreamEvent["ev"]]: readonly Extract<StreamEvent, { ev: Ev }>[];
} = {
  says: [
    { ev: "says", says: [] },
    {
      ev: "says",
      says: [
        { id: "0f0f/1", sid: SID, text: "-v Kyoko hello", ts: "t", read: true },
        { id: "0f0f/2", sid: SID, text: "", ts: "t", read: false },
      ],
    },
  ],
  permit_requests: [
    { ev: "permit_requests", requests: [] },
    {
      ev: "permit_requests",
      requests: [
        {
          id: "0f0f/1",
          sid: SID,
          ts: "t",
          blocked: "`git push` が止められた",
          attachments: ["/w/a.json", "/w/b"],
          intents: [],
          commands: [{ command: "git push", description: "公開する" }, { command: "ls" }],
          read: false,
        },
      ],
    },
  ],
  request_overrides: [
    { ev: "request_overrides", sessions: [] },
    {
      ev: "request_overrides",
      sessions: [
        {
          session_id: SID,
          session: { model: "claude-opus-5-5[1m]", effort: "high" },
          once: { model: "haiku", effort: null },
        },
      ],
    },
  ],
  request_override: [
    { ev: "request_override", session_id: SID, target: "session", model: "sonnet", effort: "low" },
    { ev: "request_override", session_id: SID, target: "once", model: null, effort: null },
  ],
  permit_request: [
    {
      ev: "permit_request",
      request: {
        id: "0f0f/2",
        sid: SID,
        ts: "t",
        blocked: "x",
        attachments: [],
        intents: ["`/w/a.ts` の編集"],
        commands: [],
        read: true,
      },
    },
  ],
  restarting: [{ ev: "restarting" }, { ev: "restarting", reason: "upgrade" }],
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
  claude_version: [{ ev: "claude_version", version: "2.1.312", observed_at: 1_793_000_000_000 }],
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

describe("StreamEventSchema", () => {
  for (const [ev, samples] of Object.entries(PUSHES)) {
    test(`${ev}: what the daemon sends reads back whole`, () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(parseWith(StreamEventSchema, wire(sample))).toEqual({ ok: true, value: sample });
      }
    });
  }

  test("an ev this client does not know is a failure", () => {
    const read = parseWith(StreamEventSchema, { ev: "something_new", x: 1 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.summary).toContain("ev");
  });

  test("a field of another type names the field", () => {
    const read = parseWith(StreamEventSchema, { ev: "transcript", sid: SID, lines: [1] });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.issues[0]?.path).toBe("lines.0");
  });
});
