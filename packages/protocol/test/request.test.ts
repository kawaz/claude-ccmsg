// The wire's requests as their schemas say them (DR-0038): every op takes the
// form its clients send and refuses one whose fields are not of their types,
// and a line is read once, by the one request schema.
import { describe, expect, test } from "bun:test";
import type { Parsed } from "../src/parse.ts";
import {
  isOtherGenerationHello,
  readRequest,
  REQUEST_OPS,
  RETIRED_OPS,
  type Request,
  type RequestInput,
  type RequestOp,
} from "../src/request.ts";
import { PROTOCOL_VERSION } from "../src/version.ts";

const SID = "11111111-2222-4333-8444-555555555555";

const line = (value: object): string => JSON.stringify(value);

/** One op's samples: a body its clients send (typed, so a sample that is not
 * the op's type does not compile), and bodies the op refuses because a field
 * is missing or not of its type. */
interface OpSamples<Op extends RequestOp> {
  readonly ok: Extract<RequestInput, { op: Op }>;
  readonly bad: readonly object[];
}

const SAMPLES: { readonly [Op in RequestOp]: OpSamples<Op> } = {
  hello: {
    ok: {
      op: "hello",
      role: "session",
      sid: SID,
      cwd: "/w",
      protocol: PROTOCOL_VERSION,
      client_version: "1",
    },
    bad: [
      { op: "hello" },
      { op: "hello", role: "admin" },
      { op: "hello", role: "user", ua: 1 },
      { op: "hello", role: "user", protocol: "1" },
    ],
  },
  user_message: {
    ok: { op: "user_message", session_id: SID, agent_id: "a1b2c3", text: "hi" },
    bad: [
      { op: "user_message", session_id: SID, agent_id: "", text: "hi" },
      { op: "user_message", session_id: SID, agent_id: "a1", text: " \n" },
      { op: "user_message", session_id: SID, text: "hi" },
    ],
  },
  send_message: {
    ok: {
      op: "send_message",
      to: { cwd: "/w", name: "n", session_id: SID, pid: 7 },
      agent_id: "a1b2",
      text: "hi",
    },
    bad: [
      // A send to every session is not one: at least one field names somebody.
      { op: "send_message", to: {}, text: "hi" },
      { op: "send_message", to: { cwd: "/w" }, text: " \n" },
      { op: "send_message", to: { pid: 1.5 }, text: "hi" },
      { op: "send_message", to: { name: "" }, text: "hi" },
      { op: "send_message", to: { session_id: SID }, agent_id: "", text: "hi" },
    ],
  },
  peer_list: {
    ok: { op: "peer_list", cwd: "/w", name: "n" },
    bad: [{ op: "peer_list", cwd: 1 }],
  },
  say: {
    ok: { op: "say", text: "hello" },
    bad: [{ op: "say" }, { op: "say", text: ["hello"] }],
  },
  say_read: {
    ok: { op: "say_read", id: "0f0f/1" },
    bad: [{ op: "say_read" }, { op: "say_read", id: 1 }],
  },
  subscribe: { ok: { op: "subscribe" }, bad: [] },
  read: {
    ok: { op: "read", room: "r1", mids: [1, 2] },
    bad: [
      { op: "read", room: "r1" },
      { op: "read", room: "r1", mids: ["1"] },
    ],
  },
  room_history: {
    ok: { op: "room_history", room: "r1" },
    bad: [{ op: "room_history" }],
  },
  rooms: { ok: { op: "rooms" }, bad: [] },
  peers: { ok: { op: "peers" }, bad: [] },
  notify: {
    ok: { op: "notify", sid: SID, text: "n" },
    bad: [{ op: "notify" }, { op: "notify", text: "n", sid: 1 }],
  },
  dir_tree: {
    ok: { op: "dir_tree", roots: ["/w"], depth: 1, filter: "x" },
    bad: [{ op: "dir_tree" }, { op: "dir_tree", roots: "/w" }],
  },
  session_launch: {
    ok: { op: "session_launch", cwd: "/w", params: { MODEL: "m" }, command: "c", template: "t" },
    bad: [
      { op: "session_launch", cwd: "/w" },
      { op: "session_launch", cwd: "/w", params: { MODEL: 7 } },
    ],
  },
  session_kill: {
    ok: { op: "session_kill", session_id: SID, force: true },
    bad: [
      { op: "session_kill", session_id: "" },
      { op: "session_kill", session_id: SID, force: "yes" },
    ],
  },
  session_rename: {
    ok: { op: "session_rename", session_id: SID, title: "t" },
    bad: [
      { op: "session_rename", session_id: "", title: "t" },
      { op: "session_rename", session_id: SID },
    ],
  },
  user_prompt: {
    ok: { op: "user_prompt", session_id: SID, text: " two\nlines " },
    bad: [
      { op: "user_prompt", session_id: SID, text: " \n " },
      { op: "user_prompt", text: "x" },
    ],
  },
  sidecar_reply: {
    ok: { op: "sidecar_reply", reply: { id: "i1", ok: true, result: { outcome: "accepted" } } },
    bad: [{ op: "sidecar_reply" }, { op: "sidecar_reply", reply: { id: "i1", ok: false } }],
  },
  sidecar_hello: {
    ok: {
      op: "sidecar_hello",
      run_id: "mgq1k2x3abcd1234",
      started_at: 1_791_955_713_123,
      config_dir: "/h/.claude",
      hyoui_session_id: "hy-1",
    },
    bad: [
      { op: "sidecar_hello", started_at: 1 },
      { op: "sidecar_hello", run_id: "../x", started_at: 1 },
      { op: "sidecar_hello", run_id: "abc", started_at: 0 },
      { op: "sidecar_hello", run_id: "abc", started_at: 1.5 },
      { op: "sidecar_hello", run_id: "abc", started_at: 1, hyoui_session_id: "" },
      { op: "sidecar_hello", run_id: "abc", started_at: 1, config_dir: "" },
    ],
  },
  session_facts: {
    ok: {
      op: "session_facts",
      facts: { at: 1, model: "claude-opus-5-5[1m]", context: { window: 1_000_000, at: 1 } },
    },
    bad: [{ op: "session_facts" }, { op: "session_facts", facts: { model: "m" } }],
  },
  session_env: {
    ok: { op: "session_env", session_id: SID },
    bad: [{ op: "session_env" }, { op: "session_env", session_id: "" }],
  },
  session_launcher_config: { ok: { op: "session_launcher_config" }, bad: [] },
  llm_usage: {
    ok: { op: "llm_usage", refresh: true },
    bad: [{ op: "llm_usage", refresh: "true" }],
  },
  llm_stats: {
    ok: { op: "llm_stats", days: 7 },
    bad: [{ op: "llm_stats", days: "7" }],
  },
  llm_status: {
    ok: { op: "llm_status", refresh: false },
    bad: [{ op: "llm_status", refresh: 1 }],
  },
  llm_keepalive_pause: {
    ok: { op: "llm_keepalive_pause", sid: SID },
    bad: [{ op: "llm_keepalive_pause" }, { op: "llm_keepalive_pause", sid: 1 }],
  },
  fs_list: {
    ok: { op: "fs_list", sid: SID, path: "src" },
    bad: [{ op: "fs_list" }, { op: "fs_list", sid: SID, path: 1 }],
  },
  fs_read: {
    ok: { op: "fs_read", sid: SID, path: "a.txt" },
    bad: [{ op: "fs_read", sid: SID }],
  },
  fs_read_external: {
    ok: { op: "fs_read_external", sid: SID, path: "/x/a.txt" },
    bad: [{ op: "fs_read_external", sid: SID, path: ["/x"] }],
  },
  fs_list_workspace: {
    ok: { op: "fs_list_workspace", sid: SID, path: "/ws" },
    bad: [{ op: "fs_list_workspace", path: "/ws" }],
  },
  fs_read_workspace: {
    ok: { op: "fs_read_workspace", sid: SID, path: "/ws/a" },
    bad: [{ op: "fs_read_workspace", sid: SID }],
  },
  fs_write: {
    ok: { op: "fs_write", sid: SID, path: "docs/inbox/a.md", content: "" },
    bad: [{ op: "fs_write", sid: SID, path: "a" }],
  },
  fs_create: {
    ok: { op: "fs_create", sid: SID, path: "a", kind: "contained", content: "" },
    bad: [{ op: "fs_create", sid: SID, path: "a", kind: "external", content: "" }],
  },
  fs_delete: {
    ok: { op: "fs_delete", sid: SID, path: "/ws/a", kind: "workspace" },
    bad: [{ op: "fs_delete", sid: SID, path: "a" }],
  },
  fs_edit: {
    ok: {
      op: "fs_edit",
      sid: SID,
      path: "/x/a",
      kind: "external",
      content: "c",
      expected_mtime: "2026-10-09T00:00:00.000Z",
      expected_size: 1,
    },
    bad: [
      { op: "fs_edit", sid: SID, path: "a", kind: "contained", content: "c", expected_mtime: "t" },
    ],
  },
  fs_stat_batch: {
    ok: { op: "fs_stat_batch", sid: SID, paths: ["/a", "/b"] },
    bad: [
      { op: "fs_stat_batch", sid: SID, paths: "/a" },
      { op: "fs_stat_batch", sid: SID },
      { op: "fs_stat_batch", sid: SID, paths: ["/a", null] },
    ],
  },
  fs_find: {
    ok: {
      op: "fs_find",
      sid: SID,
      kind: "contained",
      root: "src",
      query: "x -y",
      respect_gitignore: false,
    },
    bad: [
      { op: "fs_find", sid: SID, kind: "external", query: "x" },
      { op: "fs_find", sid: SID, kind: "contained" },
    ],
  },
  sandbox_grant: {
    ok: { op: "sandbox_grant", sid: SID, path: "a.html", kind: "contained" },
    bad: [{ op: "sandbox_grant", sid: SID, path: "a.html" }],
  },
  sandbox_revoke: {
    ok: { op: "sandbox_revoke", gid: "g1" },
    bad: [{ op: "sandbox_revoke" }],
  },
  transcript_read: {
    ok: {
      op: "transcript_read",
      sid: SID,
      before: 100,
      max_bytes: 10,
      agent_id: "a",
      run_id: "wf_1",
    },
    bad: [{ op: "transcript_read", sid: SID, before: "100" }, { op: "transcript_read" }],
  },
  session_search: {
    ok: { op: "session_search", query: "q", regex: true, config_dirs: ["/c"], mtime_within: "1d" },
    bad: [
      { op: "session_search", config_dirs: "/c" },
      { op: "session_search", regex: "yes" },
    ],
  },
  fork_origin: {
    ok: { op: "fork_origin", sid: SID },
    bad: [{ op: "fork_origin" }],
  },
  session_dump_file: {
    ok: { op: "session_dump_file", sid: SID, since: "2026-10-09T00:00:00Z", no_thinking: true },
    bad: [{ op: "session_dump_file", sid: SID, no_agent: 1 }],
  },
  agents: { ok: { op: "agents" }, bad: [] },
  transcript_subscribe: {
    ok: { op: "transcript_subscribe", sid: SID },
    bad: [{ op: "transcript_subscribe", sid: 1 }],
  },
  transcript_unsubscribe: {
    ok: { op: "transcript_unsubscribe", sid: SID },
    bad: [{ op: "transcript_unsubscribe" }],
  },
  client_trace: {
    ok: {
      op: "client_trace",
      sid: SID,
      start: 0,
      end: 10,
      size: 10,
      sampled: true,
      elapsed_ms: 3,
      points: [{ ts: "2026-10-09T00:00:00.000Z", comp: "webui", edge: "in", kind: "dom_commit" }],
    },
    bad: [
      { op: "client_trace", sid: SID, start: 0, end: 10, size: 10, sampled: true, elapsed_ms: 3 },
      {
        op: "client_trace",
        sid: SID,
        start: 0,
        end: 10,
        size: 10,
        sampled: true,
        elapsed_ms: 3,
        points: [{ ts: 1, comp: "webui", edge: "in", kind: "dom_commit" }],
      },
    ],
  },
  session_status: {
    ok: { op: "session_status", sid: SID },
    bad: [{ op: "session_status" }],
  },
  session_status_subscribe: {
    ok: { op: "session_status_subscribe", sid: SID },
    bad: [{ op: "session_status_subscribe" }],
  },
  session_status_unsubscribe: {
    ok: { op: "session_status_unsubscribe", sid: SID },
    bad: [{ op: "session_status_unsubscribe" }],
  },
  session_errors: { ok: { op: "session_errors" }, bad: [] },
  ping: { ok: { op: "ping" }, bad: [] },
  translate: {
    ok: { op: "translate", texts: [] },
    bad: [{ op: "translate" }, { op: "translate", texts: ["ok", 42] }],
  },
  shutdown: {
    ok: { op: "shutdown", reason: "test" },
    bad: [{ op: "shutdown", reason: 1 }],
  },
};

/** A line read as a request: the typed request, or the failure of whichever
 * layer did not read. */
function readLine(text: string): Parsed<Request> {
  const got = readRequest(text);
  return got.kind === "request"
    ? { ok: true, value: got.request }
    : { ok: false, failure: got.failure };
}

const read = (body: object, requestId = "q1"): Parsed<Request> =>
  readLine(line({ ...body, request_id: requestId }));

/** The summary of a line that is not a request. */
function refusal(read: Parsed<Request>): string {
  if (read.ok) throw new Error(`expected a failure, read ${JSON.stringify(read.value)}`);
  return read.failure.summary;
}

describe("readRequest: every op", () => {
  test("the samples cover every op the request schema reads", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...REQUEST_OPS].sort());
  });

  for (const op of REQUEST_OPS) {
    const samples: { readonly ok: RequestInput; readonly bad: readonly object[] } = SAMPLES[op];

    test(`${op}: the form its clients send reads as itself, with its request id`, () => {
      expect(read(samples.ok)).toEqual({ ok: true, value: { ...samples.ok, request_id: "q1" } });
    });

    for (const bad of samples.bad) {
      test(`${op}: refuses ${JSON.stringify(bad)}`, () => {
        expect(read(bad).ok).toBe(false);
      });
    }
  }
});

describe("readRequest: a line that is not a request is a failure", () => {
  test("not JSON", () => {
    expect(refusal(readLine("{op:"))).toStartWith("Invalid JSON");
  });

  for (const value of [[1], { op: 1, request_id: "q1" }, { op: "teleport", request_id: "q1" }]) {
    test(`no op of this daemon: ${JSON.stringify(value)}`, () => {
      expect(read(value).ok).toBe(false);
    });
  }

  // Rooms are read-only (DR-0036 §2): no op writes one.
  for (const value of [
    { op: "post", room: "r1", msg: "hi" },
    { op: "reply", room: "r1", mid: 3, msg: "re" },
    { op: "create_room", members: [SID] },
    { op: "next_room", room: "r1" },
    { op: "set_title", room: "r1", title: "t" },
    { op: "archive_room", room: "r1", archived: true },
    { op: "kick", room: "r1", id: "a2" },
    { op: "leave", room: "r1" },
    { op: "invite", room: "r1", sid: SID },
  ]) {
    test(`no op writes a room: ${value.op}`, () => {
      expect(readRequest(line({ ...value, request_id: "q1" }))).toMatchObject({
        kind: "invalid_request",
        frame: { op: value.op, request_id: "q1" },
        failure: { issues: [{ path: "op", message: `unknown op: ${value.op}` }] },
      });
    });
  }

  // A session sends to another with send_message alone (DR-0039 §3): the ops a
  // client of an earlier build sends with a message in them are not read, and
  // the refusal says they are gone and a restart loads the current plugin.
  for (const value of [
    { op: "message_send", to: SID, text: "hi", reply_to: "abc/1" },
    { op: "address_send", to: `ccmsg:${SID}`, text: "hi" },
  ]) {
    test(`no op but send_message sends to a session: ${value.op}`, () => {
      const read = readRequest(line({ ...value, request_id: "q1" }));
      expect(read).toMatchObject({
        kind: "invalid_request",
        frame: { op: value.op, request_id: "q1" },
        failure: { issues: [{ path: "op" }] },
      });
      expect(read.kind === "invalid_request" && read.failure.summary).toBe(
        `op: \`${value.op}\` は削除された (セッションへの送信は send tool)。送ったのは古い版の ccmsg (起動時の plugin の hooks module、または開いたままの webui)。セッションを再起動すると最新の plugin が載る (webui はページを読み込み直す)`,
      );
    });
  }

  // An op renamed under a later build (DR-0039 Consequences) is not read under
  // its old name; the refusal names the op it is now.
  for (const [old, now] of [
    ["peer_send", "send_message"],
    ["session_input", "user_prompt"],
    ["agent_input", "user_message"],
  ]) {
    test(`a renamed op is refused with its new name: ${old}`, () => {
      const read = readRequest(
        line({ op: old, to: { session_id: SID }, text: "hi", request_id: "q1" }),
      );
      expect(read.kind === "invalid_request" && read.failure.summary).toBe(
        `op: \`${old}\` は \`${now}\` に改名された。送ったのは古い版の ccmsg (起動時の plugin の hooks module、または開いたままの webui)。セッションを再起動すると最新の plugin が載る (webui はページを読み込み直す)`,
      );
    });
  }

  test("no retired op is served, and each renamed one names a served op", () => {
    const served: readonly string[] = REQUEST_OPS;
    for (const [old, now] of RETIRED_OPS) {
      expect(served).not.toContain(old);
      if (now !== null) expect(served).toContain(now);
    }
  });

  test("a request id that is missing or empty", () => {
    expect(readLine(line({ op: "ping" })).ok).toBe(false);
    expect(read({ op: "ping" }, "").ok).toBe(false);
    expect(readLine(line({ op: "hello", role: "session", sid: SID })).ok).toBe(false);
  });

  test("the field an op refuses is named in the failure", () => {
    expect(refusal(read({ op: "translate", texts: ["ok", 42] }))).toBe(
      "texts.1: Invalid type: Expected string but received 42",
    );
  });

  // However many parts of a value are wrong, the failure names one: its size
  // does not grow with the value's.
  test("a value with many wrong parts fails with one issue", () => {
    const refused = read({ op: "translate", texts: Array.from({ length: 10_000 }, (_, i) => i) });
    if (refused.ok) throw new Error("expected a failure");
    expect(refused.failure.issues).toHaveLength(1);
    expect(refused.failure.summary).toBe("texts.0: Invalid type: Expected string but received 0");
  });
});

describe("readRequest: the frame and the request are read in turn", () => {
  test("a line whose frame reads but whose request does not keeps its frame", () => {
    expect(readRequest(line({ op: "fs_list", sid: SID, path: 1, request_id: "q7" }))).toEqual({
      kind: "invalid_request",
      frame: { op: "fs_list", request_id: "q7" },
      failure: {
        issues: [{ path: "path", message: "Invalid type: Expected string but received 1" }],
        summary: "path: Invalid type: Expected string but received 1",
      },
    });
    expect(readRequest(line({ op: "teleport", request_id: "q8" }))).toMatchObject({
      kind: "invalid_request",
      frame: { op: "teleport", request_id: "q8" },
    });
  });

  for (const text of ["{op:", line([1]), line({ op: "ping" }), line({ request_id: "q9" })]) {
    test(`a line whose frame does not read: ${text}`, () => {
      expect(readRequest(text).kind).toBe("invalid_frame");
    });
  }
});

describe("readRequest: the forms beside each op's type", () => {
  // A field the op does not name is left out rather than refused (request.ts):
  // the replay cursors a client of another generation sends with subscribe
  // ask for nothing (DR-0036 §2).
  test("subscribe leaves out the room replay fields", () => {
    expect(
      read({ op: "subscribe", since: { r1: 3 }, since_seq: { r1: 9 }, backlog: true }),
    ).toEqual({ ok: true, value: { op: "subscribe", request_id: "q1" } });
  });

  test("session_launch reads params as names with text values", () => {
    expect(read({ op: "session_launch", cwd: "/w", params: { MODEL: "m", EMPTY: "" } })).toEqual({
      ok: true,
      value: {
        op: "session_launch",
        cwd: "/w",
        params: { MODEL: "m", EMPTY: "" },
        request_id: "q1",
      },
    });
    expect(refusal(read({ op: "session_launch", cwd: "/w", params: { MODEL: 7 } }))).toContain(
      "params.MODEL",
    );
  });
});

describe("readRequest: hello by generation", () => {
  test("a hello of this generation, announced or not, is served", () => {
    const hellos: readonly Extract<RequestInput, { op: "hello" }>[] = [
      { op: "hello", role: "user", protocol: PROTOCOL_VERSION },
      { op: "hello", role: "user" },
    ];
    for (const hello of hellos) {
      const got = read(hello);
      if (!got.ok) throw new Error(got.failure.summary);
      expect(got.value).toEqual({ ...hello, request_id: "q1" });
      expect(isOtherGenerationHello(got.value)).toBe(false);
    }
  });

  // The rest of a hello of another generation is that generation's shape and
  // is not read: a client of another generation is told which to run.
  test("a hello of another generation reads as one, whatever else it holds", () => {
    const got = read({ op: "hello", role: "session", sid: SID, protocol: 999, cwd: ["/w"] });
    if (!got.ok) throw new Error(got.failure.summary);
    expect(got.value).toEqual({
      op: "hello",
      role: "session",
      sid: SID,
      protocol: 999,
      request_id: "q1",
    });
    expect(isOtherGenerationHello(got.value)).toBe(true);
  });

  test("what a hello of another generation says about its client is of its type", () => {
    expect(refusal(read({ op: "hello", protocol: 999, sid: 1 }))).toStartWith("sid: ");
    expect(refusal(read({ op: "hello", protocol: "2" }))).toStartWith("protocol: ");
  });

  test("a hello of this generation is read whole: a field of another type is refused", () => {
    expect(
      refusal(read({ op: "hello", role: "observer", protocol: PROTOCOL_VERSION })),
    ).toStartWith("role: ");
  });
});
