// The wire's replies as their schemas say them (DR-0038): every op's reply,
// in the form the daemon sends it, reads back whole — nothing left out — and
// a reply whose fields are not of their types is a failure.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import { REQUEST_OPS, type RequestOp } from "../src/request.ts";
import {
  type ErrorResponse,
  ErrorResponseSchema,
  type FsListResponse,
  type FsReadResponse,
  RESPONSE_SCHEMAS,
  type ResponseOf,
  type SessionStatusSnapshot,
} from "../src/index.ts";

const SID = "11111111-2222-4333-8444-555555555555";

/** As it travels: what the daemon's JSON.stringify writes, decoded. */
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

const MEMBER = {
  type: "member",
  id: "a1",
  sid: SID,
  repo: "kawaz/x",
  ws: "main",
  cwd: "/w",
  joined_at: "2026-10-09T00:00:00.000Z",
  seq: 1,
} as const;

const PEER = {
  sid: SID,
  repo: "kawaz/x",
  ws: "main",
  cwd: "/w/x/main",
  transcript_path: "/c/projects/p/s.jsonl",
  repo_root: "/w/x",
  branch: "main",
  connected_at: "2026-10-09T00:00:00.000Z",
  last_activity_at: "2026-10-09T00:00:01.000Z",
  last_user_input_at: "2026-10-09T00:00:02.000Z",
  client_version: "0.157.0",
  protocol: 3,
  stale_client: { last_seen: "2026-10-09T00:00:03.000Z", version: "0.1.0", protocol: 2 },
} as const;

/** A snapshot with every part present, a tree nested two deep included. */
const SNAPSHOT: SessionStatusSnapshot = {
  todos: [
    { id: "1", subject: "a", status: "in_progress", owner: "me", blocked_by: ["2"], blocks: ["3"] },
  ],
  workflows: [
    {
      task_id: "t1",
      name: "wf",
      summary: "s",
      status: "completed",
      started_at: "2026-10-09T00:00:00.000Z",
      ended_at: "2026-10-09T00:01:00.000Z",
      run_id: "wf_12345678-abc",
      phases: [{ title: "p", done: 1, total: 2 }],
      agents: [
        {
          agent_id: "a1",
          label: "l",
          model: "m",
          agent_type: "Explore",
          state: "done",
          tokens: 10,
          tool_calls: 2,
          phase_index: 1,
          phase_title: "p",
          last_tool: "Read",
          result_preview: "r",
          error: "e",
          started_at: 1,
          duration_ms: 2,
        },
      ],
    },
  ],
  background: [
    {
      task_id: "b1",
      kind: "agent",
      description: "d",
      status: "running",
      started_at: "2026-10-09T00:00:00.000Z",
      ended_at: "2026-10-09T00:00:01.000Z",
      agent_type: "general-purpose",
    },
  ],
  context: { tokens: 100, model: "claude-x", effort: "high", timestamp: "2026-10-09T00:00:00Z" },
  teammates: [
    {
      name: "w",
      spawned: true,
      agent_type: "worker",
      color: "blue",
      spawned_at: "t0",
      last_sent_at: "t1",
      last_received_at: "t2",
      state: "idle",
      model: "claude-x[1m]",
    },
  ],
  agent_tree: {
    teammates: [],
    agents: [
      {
        agent_id: "x1",
        agent_type: "Explore",
        description: "d",
        spawn_depth: 0,
        kind: "subagent",
        state: "completed",
        last_activity_ms: 5,
        children: [
          {
            agent_id: "x2",
            teammate_name: "w",
            color: "red",
            model: "m",
            team_name: "t",
            spawn_depth: 1,
            kind: "teammate",
            state: "active",
            children: [],
          },
        ],
      },
    ],
    workflows: [
      {
        workflow_id: "wf_12345678-abc",
        done: 1,
        total: 2,
        phases: [
          {
            index: 1,
            title: "p",
            done: 1,
            total: 1,
            members: [
              {
                agent_id: "w1",
                spawn_depth: 0,
                kind: "workflow_member",
                workflow_id: "wf_12345678-abc",
                state: "completed",
                children: [],
              },
            ],
          },
        ],
        unassigned: [],
        last_activity_ms: 9,
      },
    ],
  },
  external_files: [
    { path: "/etc/hosts", origin: "tool" },
    { path: "/tmp/a.png", origin: "attachment" },
  ],
  workspace_folders: [{ name: "x", path: "/w/x" }],
  api_error: { text: "API Error: 500", timestamp: "2026-10-09T00:00:00Z" },
};

const FS_READ: FsReadResponse = {
  ok: true,
  sid: SID,
  path: "a.txt",
  size: 3,
  truncated: false,
  binary: false,
  content: "abc",
  mtime: "2026-10-09T00:00:00.000Z",
};

const FS_LIST: FsListResponse = {
  ok: true,
  sid: SID,
  path: "",
  entries: [
    { name: "a.txt", type: "file", size: 3, mtime: "2026-10-09T00:00:00.000Z" },
    { name: "d", type: "dir" },
    { name: "l", type: "symlink" },
    { name: "s", type: "other" },
  ],
};

/** Each op's replies, as the daemon sends them (typed, so a sample that is not
 * the op's reply does not compile). */
const SAMPLES: { readonly [Op in RequestOp]: readonly ResponseOf<Op>[] } = {
  hello: [
    { ok: true, version: "0.157.0", protocol: 3 },
    {
      ok: true,
      version: "0.157.0",
      protocol: 3,
      terminal_gateway_url: "https://t.example/",
      llm_usage_available: true,
      llm_stats_available: true,
      llm_status_available: true,
      llm_keepalive_pause_available: true,
      sandbox_available: true,
      launch_available: true,
    },
  ],
  user_message: [
    { ok: true, outcome: "appended" },
    { ok: true, outcome: "not_delivered", reason: "not_running" },
    { ok: true, outcome: "not_delivered", reason: "session_changed" },
    { ok: true, outcome: "unconfirmed" },
  ],
  send_message: [
    { ok: true, results: [] },
    {
      ok: true,
      results: [
        { sid: SID, name: "n", cwd: "/w", outcome: "delivered" },
        { sid: SID, outcome: "unconfirmed" },
        { sid: SID, outcome: "not_delivered", reason: "no_module" },
        { sid: SID, outcome: "not_delivered", reason: "not_running" },
      ],
    },
  ],
  peer_list: [
    { ok: true, peers: [] },
    { ok: true, peers: [{ sid: SID, name: "n", cwd: "/w", pids: [7], module: true, self: false }] },
  ],
  say: [{ ok: true, id: "0f0f/1" }],
  say_read: [{ ok: true, ids: ["0f0f/1"] }],
  subscribe: [{ ok: true, subscribed: true }],
  read: [
    {
      ok: true,
      room: "r1",
      msgs: [
        { type: "msg", mid: 1, from: "u1", ts: "t", msg: "hi", seq: 2 },
        { type: "msg", mid: 2, from: "a1", to: ["u1"], ts: "t", msg: "yo", reply_to: "r1m1" },
      ],
    },
  ],
  room_history: [
    { ok: true, room: "r1", events: [] },
    {
      ok: true,
      room: "r1",
      events: [
        { type: "title", title: "t", ts: "t", seq: 1 },
        MEMBER,
        { type: "msg", mid: 1, from: "a1", ts: "t", msg: "hi", seq: 3 },
        { type: "leave", id: "a1", ts: "t", seq: 4 },
      ],
    },
  ],
  rooms: [
    {
      ok: true,
      rooms: [
        {
          id: "r1",
          title: "t",
          members: [MEMBER, { ...MEMBER, id: "u2", role: "guest" }],
          last_mid: 2,
          last_ts: "2026-10-09T00:00:00.000Z",
          archived: true,
          kind: "1on1",
        },
        { id: "r2", members: [], last_mid: 0, last_ts: null },
      ],
    },
  ],
  peers: [{ ok: true, peers: [PEER, { sid: SID, repo: "", ws: "", cwd: "" }] }],
  notify: [{ ok: true, delivered: 2 }],
  dir_tree: [
    {
      ok: true,
      entries: [
        {
          path: "/w",
          is_dir: true,
          children: [
            { path: "/w/a", is_dir: true, children: [] },
            { path: "/w/b", is_dir: true },
          ],
        },
      ],
    },
  ],
  session_launch: [
    { ok: true, session_id: SID, exit_code: 0, stdout: "o", stderr: "" },
    { ok: true, exit_code: 143, stdout: "", stderr: "" },
  ],
  session_kill: [{ ok: true, terminated: false }],
  session_rename: [{ ok: true, hyoui_session_id: "h1", title: "t" }],
  user_prompt: [
    { ok: true, outcome: "accepted" },
    { ok: true, outcome: "not_delivered", reason: "no_module" },
    { ok: true, outcome: "not_delivered", reason: "dialog" },
    { ok: true, outcome: "unconfirmed" },
  ],
  sidecar_reply: [{ ok: true }],
  sidecar_hello: [{ ok: true }],
  session_facts: [{ ok: true }],
  session_env: [{ ok: true, pid: 42, env: { PATH: "/bin", HOME: "/h" } }],
  session_launcher_config: [
    { ok: true, root_dirs: ["/w"], default_effort: {} },
    { ok: true, root_dirs: ["/w"], default_effort: { fable: "high", haiku: "low" } },
  ],
  llm_usage: [
    {
      ok: true,
      generated_at: 1,
      credentials: [
        {
          name: "main",
          type: "claude_oauth",
          support: "observed",
          auth: {
            status: "relogin_required",
            reason: "r",
            observed_at: 2,
            login_url: "https://g.example/login",
          },
          snapshot: {
            observed_at: 3,
            overage: { status: "rejected", disabled_reason: "out_of_credits" },
            windows: {
              "5h": { utilization: 0.13, status: "allowed", reset: 4, window_seconds: 18000 },
              "7d": { utilization: 1.01, status: "rejected", expired: true },
            },
          },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 47,
              severity: "normal",
              resets_at: 5,
              model: "Fable",
              is_active: true,
              window_seconds: 604800,
            },
          ],
          probe_error: "timeout",
        },
        { name: "relay", support: "upstream_dependent" },
      ],
    },
  ],
  llm_stats: [
    {
      ok: true,
      generated_at: 1,
      days: {
        "2026-10-09": {
          credentials: {
            main: {
              "claude-x": {
                requests: 1,
                tokens: {
                  input: 2,
                  output: 3,
                  "input.cache_creation": 4,
                  "input.cache_read": 5,
                },
                usd: 0.5,
              },
            },
            "-": { "claude-y": {} },
          },
          total_usd: 0.5,
        },
      },
    },
  ],
  llm_keepalive_pause: [{ ok: true }],
  llm_status: [
    {
      ok: true,
      schema_version: 1,
      generated_at: 1,
      overall: { severity: "critical", service_counts: { ok: 1, critical: 1 } },
      services: [
        {
          id: "anthropic",
          name: "Anthropic",
          severity: "critical",
          routes: ["main"],
          official: {
            state: "major_outage",
            source: "statuspage_v2",
            source_url: "https://status.example/",
            observed_at: 2,
            stale: false,
            components: [{ id: "c1", name: "API", state: "major_outage" }],
            incidents: [
              {
                id: "i1",
                name: "Elevated errors",
                state: "investigating",
                impact: "major",
                created_at: 3,
                updated_at: 4,
                url: "https://status.example/i1",
                latest_update: "u",
                scope: "page",
              },
            ],
            error: "e",
          },
          observed: {
            state: "failing",
            observed_at: 5,
            expires_at: 6,
            last_success_at: 7,
            last_failure: { at: 8, kind: "upstream_http", status: 529 },
          },
        },
        { id: "other", name: "other", severity: "ok", routes: [] },
      ],
    },
  ],
  fs_list: [FS_LIST],
  fs_read: [FS_READ, { ...FS_READ, binary: true, content: "", truncated: true }],
  fs_read_external: [{ ...FS_READ, path: "/etc/hosts" }],
  fs_list_workspace: [{ ...FS_LIST, path: "/w/x" }],
  fs_read_workspace: [{ ...FS_READ, path: "/w/x/a.txt" }],
  fs_write: [{ ok: true, sid: SID, path: "docs/inbox/a.md" }],
  fs_create: [{ ok: true, sid: SID, path: "a.md" }],
  fs_delete: [{ ok: true, sid: SID, path: "/w/x/a.md" }],
  fs_edit: [{ ok: true, sid: SID, path: "a.md", size: 3, mtime: "2026-10-09T00:00:00.000Z" }],
  fs_stat_batch: [
    {
      ok: true,
      results: [
        { kind: "contained", path: "a.ts" },
        null,
        { kind: "workspace", path: "/w/y/b.ts" },
        { kind: "external", path: "/etc/hosts" },
      ],
    },
  ],
  fs_find: [
    {
      ok: true,
      sid: SID,
      hits: [
        { path: "a.ts", type: "file" },
        { path: "d", type: "dir" },
        { path: "l", type: "symlink" },
      ],
      truncated: true,
    },
  ],
  sandbox_grant: [
    { ok: true, gid: "g1", token: "t1", url: "https://g1.sandbox.example/a.html", exp: 1 },
  ],
  sandbox_revoke: [{ ok: true }],
  transcript_read: [
    { ok: true, sid: SID, lines: ['{"type":"user"}'], start: 0, end: 16, size: 16 },
  ],
  session_search: [
    {
      ok: true,
      hits: [
        {
          sid: SID,
          config_dir: "/c",
          file: "/c/projects/p/s.jsonl",
          cwd: "/w",
          repo: "kawaz/x",
          ws: "main",
          created_at: "t0",
          updated_at: "t1",
          size: 10,
          matches: [
            { role: "user", text: "find me", timestamp: "t0" },
            { role: "agent", text: "found" },
          ],
          title: "t",
          model: "claude-x[1m]",
          effort: "medium",
        },
        {
          sid: SID,
          config_dir: "/c",
          file: "/c/projects/p/s2.jsonl",
          cwd: null,
          repo: null,
          ws: null,
          created_at: "t0",
          updated_at: "t1",
          size: 10,
          matches: [],
          title: null,
        },
      ],
      truncated: false,
    },
  ],
  fork_origin: [
    { ok: true, origin: { sid: SID, boundary_uuid: "u1", copied: 12 } },
    { ok: true, origin: null },
  ],
  session_dump_file: [{ ok: true, path: "/d/dumps/a.txt", entries: 3, bytes: 100 }],
  agents: [
    {
      ok: true,
      agents: [
        {
          pid: 1,
          cwd: "/w",
          kind: "interactive",
          startedAt: 2,
          sessionId: SID,
          name: "n",
          status: "busy",
          waitingFor: "dialog open",
          config_dir: "/c",
          turn: { state: "responding", since: "2026-10-09T00:00:00.000Z" },
          hyoui_session_id: "h1",
        },
      ],
      polled_at: "2026-10-09T00:00:00.000Z",
    },
    { ok: true, agents: [], polled_at: null },
  ],
  transcript_subscribe: [{ ok: true, sid: SID, size: 100 }],
  transcript_unsubscribe: [{ ok: true, sid: SID }],
  client_trace: [{ ok: true, sid: SID, written: 3 }],
  session_status: [
    { ok: true, sid: SID, ...SNAPSHOT },
    { ok: true, sid: SID, todos: [], workflows: [], background: [] },
  ],
  session_status_subscribe: [{ ok: true, sid: SID, ...SNAPSHOT }],
  session_status_unsubscribe: [{ ok: true, sid: SID }],
  session_errors: [
    { ok: true, errors: [{ sid: SID, text: "Prompt is too long", timestamp: "t" }] },
  ],
  ping: [
    {
      ok: true,
      pong: true,
      version: "0.157.0",
      uptime: 1.5,
      pid: 2,
      clients: 4,
      exe: "/bin/bun",
      script: "/p/run.ts",
      http: ["127.0.0.1:8642"],
      httpAllow: ["127.0.0.0/8"],
      network: "online",
    },
  ],
  translate: [
    {
      ok: true,
      results: [
        { ok: true, text: "こんにちは" },
        { ok: false, error: "notInstalled" },
      ],
    },
  ],
  shutdown: [{ ok: true, stopping: true }],
};

describe("RESPONSE_SCHEMAS", () => {
  test("answers every op a request names, and no other", () => {
    expect(Object.keys(RESPONSE_SCHEMAS).toSorted()).toEqual([...REQUEST_OPS].toSorted());
  });

  function readsBackWhole<Op extends RequestOp>(op: Op): void {
    expect(SAMPLES[op].length).toBeGreaterThan(0);
    for (const sample of SAMPLES[op]) {
      expect(parseWith(RESPONSE_SCHEMAS[op], wire(sample))).toEqual({ ok: true, value: sample });
    }
  }

  for (const op of REQUEST_OPS) {
    test(`${op}: what the daemon sends reads back whole`, () => readsBackWhole(op));
  }

  test("the correlation envelope is not part of an op's reply", () => {
    expect(parseWith(RESPONSE_SCHEMAS.say, { ok: true, id: "0f0f/1", request_id: "q1" })).toEqual({
      ok: true,
      value: { ok: true, id: "0f0f/1" },
    });
  });
});

describe("a reply that is not the op's", () => {
  const failure = (op: RequestOp, value: object): string => {
    const read = parseWith(RESPONSE_SCHEMAS[op], value);
    expect(read.ok).toBe(false);
    return read.ok ? "" : read.failure.summary;
  };

  test("a field of another type names the field", () => {
    expect(failure("read", { ok: true, room: 1, msgs: [] })).toStartWith("room: ");
    expect(failure("ping", { ...SAMPLES.ping[0], network: "flaky" })).toStartWith("network: ");
    expect(failure("room_history", { ok: true, room: "r1" })).toStartWith("events: ");
    expect(
      failure("room_history", { ok: true, room: "r1", events: [{ type: "link", ts: "t" }] }),
    ).toStartWith("events.0");
  });

  test("an ErrorResponse is not a success reply", () => {
    expect(failure("read", { ok: false, error: { code: "room_not_found", msg: "m" } })).toContain(
      "ok",
    );
  });

  test("an outcome no op answers with is a failure", () => {
    expect(failure("user_prompt", { ok: true, outcome: "maybe" })).toContain("outcome");
    expect(failure("user_prompt", { ok: true, outcome: "not_delivered", reason: "x" })).toContain(
      "reason",
    );
  });

  test("a tree node deep in the snapshot is read too", () => {
    const [node] = SNAPSHOT.agent_tree?.agents ?? [];
    const broken = {
      ok: true,
      sid: SID,
      ...SNAPSHOT,
      agent_tree: {
        teammates: [],
        workflows: [],
        agents: [{ ...node, children: [{ agent_id: 1 }] }],
      },
    };
    expect(failure("session_status", broken)).toContain("agent_tree.agents.0.children.0");
  });
});

describe("ErrorResponseSchema", () => {
  test("reads the error a daemon sends for any op", () => {
    const error: ErrorResponse = {
      ok: false,
      error: { code: "invalid_args", msg: "op 'read': room: ..." },
    };
    expect(parseWith(ErrorResponseSchema, wire(error))).toEqual({ ok: true, value: error });
  });

  test("an error without its code or message is a failure", () => {
    expect(parseWith(ErrorResponseSchema, { ok: false, error: { code: "x" } }).ok).toBe(false);
    expect(parseWith(ErrorResponseSchema, { ok: false }).ok).toBe(false);
    expect(parseWith(ErrorResponseSchema, { ok: true, error: { code: "x", msg: "y" } }).ok).toBe(
      false,
    );
  });
});

describe("records", () => {
  test("a value of another type in a record is a failure", () => {
    expect(parseWith(RESPONSE_SCHEMAS.session_env, { ok: true, pid: 1, env: { A: 1 } }).ok).toBe(
      false,
    );
    expect(
      parseWith(RESPONSE_SCHEMAS.llm_status, {
        ok: true,
        overall: { severity: "ok", service_counts: { ok: "1" } },
        services: [],
      }).ok,
    ).toBe(false);
  });
});
