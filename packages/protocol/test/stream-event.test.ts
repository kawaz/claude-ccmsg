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
  comments: [
    { ev: "comments", session_id: SID, comments: [], threads: [], drafts: [], read_marks: [] },
    {
      ev: "comments",
      session_id: SID,
      comments: [
        {
          kind: "comment",
          author: "user",
          cid: "c7k2p",
          session_id: SID,
          anchor: {
            kind: "selection",
            uuid: "u-9",
            msg_start_with: "この関数は",
            text: "null",
            before: "が ",
            after: " を",
          },
          body: "undefined では?",
          written: { at: "2026-11-22T00:00:00.000Z" },
          sent: { at: "2026-11-22T00:00:05.000Z", after_uuid: "u-10" },
          updated_at: "2026-11-22T00:00:05.000Z",
          btw: false,
          status: "delivered",
          row_uuid: "u-11",
        },
        {
          kind: "comment",
          author: "agent",
          cid: "c8m1t",
          session_id: SID,
          anchor: { kind: "comment", cid: "c7k2p" },
          body_start: "そうです",
          written: { at: "2026-11-22T00:00:09.000Z" },
          sent: { at: "2026-11-22T00:00:09.000Z" },
          updated_at: "2026-11-22T00:00:09.000Z",
          tool_use_id: "toolu_01",
        },
      ],
      threads: [{ kind: "thread", session_id: SID, root: "c7k2p" }],
      drafts: [
        {
          kind: "draft",
          id: "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e5f",
          session_id: SID,
          written: { at: "2026-11-22T00:00:00.000Z", after_uuid: "u-1" },
          updated_at: "2026-11-22T00:00:00.000Z",
          text: "[FILE3] を見て",
          attachments: [{ n: 3, name: "a.png", path: "/state/sessions/s.att-x.png" }],
          status: "queued",
        },
      ],
      read_marks: [
        {
          kind: "read",
          session_id: SID,
          uuid: "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e60",
          read: true,
        },
      ],
    },
  ],
  comment: [
    {
      ev: "comment",
      comment: {
        kind: "comment",
        author: "btw",
        cid: "c9q4r",
        session_id: SID,
        anchor: { kind: "comment", cid: "c7k2p" },
        body: "答え",
        written: { at: "2026-11-22T00:00:00.000Z" },
        updated_at: "2026-11-22T00:00:00.000Z",
        status: "running",
        tool: "Read",
      },
    },
  ],
  read_mark: [
    {
      ev: "read_mark",
      mark: {
        kind: "read",
        session_id: SID,
        uuid: "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e60",
        read: false,
      },
    },
  ],
  comment_thread: [
    {
      ev: "comment_thread",
      thread: {
        kind: "thread",
        session_id: SID,
        root: "c7k2p",
        resolved_at: "2026-11-22T00:01:00.000Z",
        seen_cid: "c8m1t",
      },
    },
  ],
  prompt_draft: [
    {
      ev: "prompt_draft",
      draft: {
        kind: "draft",
        id: "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e5f",
        session_id: SID,
        written: { at: "2026-11-22T00:00:00.000Z", after_uuid: "u-1" },
        updated_at: "2026-11-22T00:00:00.000Z",
        text: "[FILE3] を見て",
        attachments: [{ n: 3, name: "a.png", path: "/state/sessions/s.att-x.png" }],
        status: "unconfirmed",
        sent: { at: "2026-11-22T00:00:09.000Z" },
        send_error: "dialog",
      },
    },
  ],
  prompt_draft_removed: [
    { ev: "prompt_draft_removed", session_id: SID, id: "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e5f" },
  ],
  project_auto_mode: [
    {
      ev: "project_auto_mode",
      key: "repo:github.com/kawaz/claude-ccmsg",
      project: {
        environment: [],
        allow: [],
        soft_deny: ["Never push to main"],
        hard_deny: [],
      },
    },
  ],
  bookmarks: [
    { ev: "bookmarks", sessions: [] },
    { ev: "bookmarks", sessions: [{ session_id: SID, uuids: ["u1", "a2"] }] },
  ],
  say_unread: [
    { ev: "say_unread", says: [] },
    {
      ev: "say_unread",
      says: [
        { session_id: SID, tool_use_id: "toolu_01", ts: "2026-10-28T00:00:00.000Z" },
        { session_id: SID, tool_use_id: "toolu_02", ts: "2026-10-28T00:00:01.000Z" },
        {
          session_id: SID,
          tool_use_id: "toolu_03",
          ts: "2026-10-28T00:00:02.000Z",
          agent_id: "a1b2c3",
        },
      ],
    },
  ],
  agent_says: [
    { ev: "agent_says", says: [] },
    {
      ev: "agent_says",
      says: [
        {
          session_id: SID,
          agent_id: "a1b2c3",
          tool_use_id: "toolu_03",
          ts: "2026-10-28T00:00:02.000Z",
          text: "終わった",
        },
      ],
    },
  ],
  permit_state: [
    { ev: "permit_state", unread: [], granted: [], marks: [], rules: [] },
    {
      ev: "permit_state",
      unread: [{ session_id: SID, tool_use_id: "toolu_01", ts: "2026-11-08T00:00:00.000Z" }],
      granted: ["toolu_02"],
      marks: [
        {
          tool_use_id: "toolu_02",
          kind: "project_permissions",
          index: 0,
          mark: "run",
          at: "2026-11-08T00:00:01.000Z",
        },
        {
          tool_use_id: "toolu_02",
          kind: "commands",
          index: 1,
          mark: "run",
          at: "2026-11-08T00:00:02.000Z",
        },
        {
          tool_use_id: "toolu_03",
          kind: "intents",
          index: 0,
          mark: "dismiss",
          at: "2026-11-08T00:00:03.000Z",
        },
      ],
      rules: [
        { tool_use_id: "toolu_02", index: 0, rules: ["Edit(~/a.toml)", "Edit(//real/a.toml)"] },
        { tool_use_id: "toolu_02", index: 1, rules: ["Bash(old)"] },
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
  bash_command_ended: [
    { ev: "bash_command_ended", sid: SID, command: "ls -la" },
    { ev: "bash_command_ended", sid: SID, command: "echo '<a&b>'" },
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
        {
          sid: SID,
          cwd: "/w",
          vcs: { type: "git", branch: "main", remotes: [] },
          protocol: { major: 3, minor: 1 },
        },
        {
          sid: SID,
          cwd: "",
          stale_client: { last_seen: "2026-10-09T00:00:00.000Z", protocol: { major: 1 } },
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
      touched_files: [],
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
