// The wire's requests as their schemas say them (DR-0038): every op takes the
// form its clients send and refuses one whose fields are not of their types,
// and a line is read once, by the one request schema.
import { describe, expect, test } from "bun:test";
import type { Parsed } from "../src/parse.ts";
import {
  isOtherGenerationHello,
  readRequest,
  REQUEST_OPS,
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
  post: {
    ok: { op: "post", room: "r1", msg: "hi", to: ["a1", "u1"] },
    bad: [
      { op: "post", room: "r1" },
      { op: "post", room: "r1", msg: 7 },
      { op: "post", room: "r1", msg: "m", to: [1] },
    ],
  },
  reply: {
    ok: { op: "reply", room: "r1", mid: 3, msg: "re" },
    bad: [
      { op: "reply", room: "r1", mid: "3", msg: "re" },
      { op: "reply", room: "r1", mid: 3 },
    ],
  },
  message_send: {
    ok: { op: "message_send", to: SID, text: "hi", reply_to: "abc/1" },
    bad: [
      { op: "message_send", to: SID },
      { op: "message_send", to: 1, text: "hi" },
    ],
  },
  address_send: {
    ok: { op: "address_send", to: `ccmsg:path:/w`, text: "hi" },
    bad: [
      { op: "address_send", to: `ccmsg:${SID}` },
      { op: "address_send", to: 1, text: "hi" },
    ],
  },
  create_room: {
    ok: {
      op: "create_room",
      members: [SID],
      msg: "m",
      title: "t",
      include_self: false,
      kind: "broadcast",
    },
    bad: [
      { op: "create_room" },
      { op: "create_room", members: [SID], kind: "1on1" },
      { op: "create_room", members: [1] },
    ],
  },
  next_room: {
    ok: { op: "next_room", room: "r1", msg: "m", title: "t" },
    bad: [{ op: "next_room" }, { op: "next_room", room: "r1", title: 1 }],
  },
  say: {
    ok: { op: "say", text: "hello" },
    bad: [{ op: "say" }, { op: "say", text: ["hello"] }],
  },
  say_read: {
    ok: { op: "say_read", id: "0f0f/1" },
    bad: [{ op: "say_read" }, { op: "say_read", id: 1 }],
  },
  set_title: {
    ok: { op: "set_title", room: "r1", title: " t " },
    bad: [
      { op: "set_title", room: "r1" },
      { op: "set_title", room: "r1", title: null },
    ],
  },
  archive_room: {
    ok: { op: "archive_room", room: "r1", archived: true },
    bad: [
      { op: "archive_room", room: "r1" },
      { op: "archive_room", room: "r1", archived: "yes" },
    ],
  },
  kick: {
    ok: { op: "kick", room: "r1", id: "a2" },
    bad: [
      { op: "kick", room: "r1" },
      { op: "kick", room: "r1", id: 2 },
    ],
  },
  subscribe: {
    ok: { op: "subscribe", since: { r1: 3 }, since_seq: { r1: 9 }, backlog: true },
    bad: [
      { op: "subscribe", since_seq: 5 },
      { op: "subscribe", backlog: "yes" },
      { op: "subscribe", since: { r1: "x" } },
      { op: "subscribe", since: { r1: null } },
      { op: "subscribe", since_seq: { r1: -5 } },
    ],
  },
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
  session_input: {
    ok: { op: "session_input", session_id: SID, text: " two\nlines " },
    bad: [
      { op: "session_input", session_id: SID, text: " \n " },
      { op: "session_input", text: "x" },
    ],
  },
  sidecar_reply: {
    ok: { op: "sidecar_reply", reply: { id: "i1", ok: true, result: { outcome: "accepted" } } },
    bad: [{ op: "sidecar_reply" }, { op: "sidecar_reply", reply: { id: "i1", ok: false } }],
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
  leave: {
    ok: { op: "leave", room: "r1" },
    bad: [{ op: "leave" }],
  },
  invite: {
    ok: { op: "invite", room: "r1", sid: SID },
    bad: [
      { op: "invite", room: "r1", sid: "" },
      { op: "invite", room: "r1" },
    ],
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
  test("create_room says where a 1on1 room comes from", () => {
    expect(refusal(read({ op: "create_room", members: [SID], kind: "1on1" }))).toBe(
      "kind: a 1on1 room is not opened through create_room; omit kind for a normal room",
    );
  });

  // JSON text can spell a number past the finite range; it is not a seq.
  test("a since_seq cursor past the finite range is refused", () => {
    expect(readLine('{"op":"subscribe","request_id":"q1","since_seq":{"r3":1e999}}').ok).toBe(
      false,
    );
  });

  // A mid is a position like a seq: a negative one is refused under the
  // request's id, not read as "no cursor".
  test("a since cursor that is not a mid is refused under the request's id", () => {
    expect(
      readRequest(line({ op: "subscribe", request_id: "q1", since: { r1: -1 } })),
    ).toMatchObject({
      kind: "invalid_request",
      frame: { op: "subscribe", request_id: "q1" },
      failure: { issues: [{ path: "since.r1" }] },
    });
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
