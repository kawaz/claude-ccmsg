// The wire's requests as their schemas say them (DR-0038): every op takes the
// form its clients send and refuses one whose fields are not of their types,
// and a line is read once, by the one request schema.
import { describe, expect, test } from "bun:test";
import type { Parsed } from "../src/parse.ts";
import {
  readRequest,
  REQUEST_OPS,
  RETIRED_OPS,
  type Request,
  type RequestInput,
  type RequestOp,
} from "../src/request.ts";
import { USERSCRIPT_MAX_LENGTH } from "../src/userscript.ts";
import { AUTO_MODE_ENTRY_MAX_LENGTH } from "../src/project-auto-mode.ts";
import { PROTOCOL_VERSION, UNANNOUNCED_PROTOCOL_MAJOR } from "../src/version.ts";

const SID = "11111111-2222-4333-8444-555555555555";
const DRAFT_ID = "0f8d2c1e-6a3b-4c5d-8e9f-0a1b2c3d4e5f";

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
      ccmsg_version: "1",
    },
    bad: [
      { op: "hello", protocol: PROTOCOL_VERSION },
      { op: "hello", role: "admin", protocol: PROTOCOL_VERSION },
      { op: "hello", role: "user", ua: 1, protocol: PROTOCOL_VERSION },
      { op: "hello", role: "user", protocol: "1" },
      { op: "hello", role: "user", protocol: { major: PROTOCOL_VERSION.major } },
      { op: "hello", role: "user", protocol: { major: PROTOCOL_VERSION.major, minor: -1 } },
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
    ok: { op: "send_message", to: { session_id: SID }, agent_id: "a1b2", text: "hi" },
    bad: [
      // A send names its recipient by session id, and by nothing else.
      { op: "send_message", to: {}, text: "hi" },
      { op: "send_message", to: { cwd: "/w" }, text: "hi" },
      { op: "send_message", to: { name: "n" }, text: "hi" },
      { op: "send_message", to: { pid: 7 }, text: "hi" },
      { op: "send_message", to: { session_id: SID, cwd: "/w" }, text: "hi" },
      { op: "send_message", to: { session_id: SID, name: "n" }, text: "hi" },
      { op: "send_message", to: { session_id: SID, pid: 7 }, text: "hi" },
      { op: "send_message", to: { session_id: "" }, text: "hi" },
      { op: "send_message", to: { session_id: SID }, text: " \n" },
      { op: "send_message", to: { session_id: SID }, agent_id: "", text: "hi" },
    ],
  },
  peer_list: {
    ok: { op: "peer_list", cwd_prefix: "/w/" },
    bad: [
      { op: "peer_list", cwd_prefix: 1 },
      { op: "peer_list", cwd_prefix: "" },
    ],
  },
  say_read: {
    ok: { op: "say_read", ids: ["toolu_01", "toolu_02"] },
    bad: [
      { op: "say_read" },
      { op: "say_read", ids: [] },
      { op: "say_read", ids: [1] },
      { op: "say_read", id: "toolu_01" },
    ],
  },
  notification_list: {
    ok: { op: "notification_list", sid: SID },
    bad: [{ op: "notification_list" }, { op: "notification_list", sid: 1 }],
  },
  bookmark_set: {
    ok: { op: "bookmark_set", sid: SID, uuid: "aaaaaaaa-0000-4000-8000-000000000001", on: true },
    bad: [
      { op: "bookmark_set", sid: SID, uuid: "u1" },
      { op: "bookmark_set", sid: SID, uuid: "", on: false },
      { op: "bookmark_set", uuid: "u1", on: true },
      { op: "bookmark_set", sid: SID, uuid: "u1", on: "yes" },
    ],
  },
  bookmark_rows: {
    ok: { op: "bookmark_rows", sid: SID },
    bad: [{ op: "bookmark_rows" }, { op: "bookmark_rows", sid: "" }],
  },
  prompt_rows: {
    ok: { op: "prompt_rows", sid: SID, since: "2026-11-22T01:00:00.000Z" },
    bad: [
      { op: "prompt_rows" },
      { op: "prompt_rows", sid: "" },
      { op: "prompt_rows", sid: SID, since: "not a time" },
      { op: "prompt_rows", sid: SID, since: 0 },
    ],
  },
  permit_request: {
    ok: {
      op: "permit_request",
      permit: {
        blocked: "`git push` が止められた",
        attachments: ["/w/policy.json"],
        intents: ["`/w/a.ts` の編集"],
        commands: [
          { command: "git push origin main", description: "main を公開する" },
          { command: "git push origin v1" },
        ],
      },
    },
    bad: [
      { op: "permit_request" },
      // Neither intents nor commands: nothing to permit.
      { op: "permit_request", permit: { blocked: "x" } },
      { op: "permit_request", permit: { blocked: "x", intents: [], commands: [] } },
      { op: "permit_request", permit: { blocked: " ", commands: [{ command: "ls" }] } },
      { op: "permit_request", permit: { blocked: "x", commands: [{ command: "\n" }] } },
      // A command is an object now; its text alone is not one.
      { op: "permit_request", permit: { blocked: "x", commands: ["ls"] } },
      {
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls", description: " " }] },
      },
      {
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls" }], attachments: ["a.ts"] },
      },
      {
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls" }], attachments: ["/a", "/a"] },
      },
      {
        op: "permit_request",
        permit: {
          blocked: "x",
          commands: [{ command: "ls" }],
          attachments: Array.from({ length: 17 }, (_, i) => `/a${i}`),
        },
      },
      // The module writes exactly the fields; another is the writer's mistake.
      {
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls" }], agent_id: "a1" },
      },
      {
        op: "permit_request",
        permit: { blocked: "x", commands: [{ command: "ls", cwd: "/w" }] },
      },
    ],
  },
  permit_attachment_read: {
    ok: { op: "permit_attachment_read", sid: SID, tool_use_id: "toolu_01", path: "/w/policy.json" },
    bad: [
      { op: "permit_attachment_read", sid: SID, tool_use_id: "toolu_01" },
      { op: "permit_attachment_read", sid: SID, path: "/w/policy.json" },
      { op: "permit_attachment_read", tool_use_id: "toolu_01", path: "/w/policy.json" },
    ],
  },
  permit_settings_read: {
    ok: { op: "permit_settings_read", sid: SID, tool_use_id: "toolu_01" },
    bad: [
      { op: "permit_settings_read" },
      { op: "permit_settings_read", sid: SID },
      { op: "permit_settings_read", tool_use_id: "toolu_01" },
    ],
  },
  permit_permission_apply: {
    ok: {
      op: "permit_permission_apply",
      sid: SID,
      tool_use_id: "toolu_01",
      index: 1,
      change: "remove",
    },
    bad: [
      { op: "permit_permission_apply", sid: SID, tool_use_id: "toolu_01" },
      { op: "permit_permission_apply", sid: SID, index: 0 },
      { op: "permit_permission_apply", tool_use_id: "toolu_01", index: 0 },
      // An item by its place: a whole number from 0.
      {
        op: "permit_permission_apply",
        sid: SID,
        tool_use_id: "toolu_01",
        index: -1,
        change: "add",
      },
      {
        op: "permit_permission_apply",
        sid: SID,
        tool_use_id: "toolu_01",
        index: 0.5,
        change: "add",
      },
      // What to do with the item's rules: add them or take them out.
      { op: "permit_permission_apply", sid: SID, tool_use_id: "toolu_01", index: 0 },
      {
        op: "permit_permission_apply",
        sid: SID,
        tool_use_id: "toolu_01",
        index: 0,
        change: "write",
      },
      {
        op: "permit_permission_apply",
        sid: SID,
        tool_use_id: "toolu_01",
        permission: { add: "Bash(a)" },
      },
    ],
  },
  permit_dismiss: {
    ok: {
      op: "permit_dismiss",
      sid: SID,
      tool_use_id: "toolu_01",
      kind: "intents",
      index: 1,
      dismissed: false,
    },
    bad: [
      { op: "permit_dismiss", sid: SID, tool_use_id: "toolu_01", kind: "commands", index: 0 },
      {
        op: "permit_dismiss",
        sid: SID,
        tool_use_id: "toolu_01",
        kind: "commands",
        dismissed: true,
      },
      { op: "permit_dismiss", sid: SID, tool_use_id: "toolu_01", index: 0, dismissed: true },
      { op: "permit_dismiss", sid: SID, kind: "commands", index: 0, dismissed: true },
      {
        op: "permit_dismiss",
        tool_use_id: "toolu_01",
        kind: "commands",
        index: 0,
        dismissed: true,
      },
      // The kinds are the call's lists.
      {
        op: "permit_dismiss",
        sid: SID,
        tool_use_id: "toolu_01",
        kind: "attachments",
        index: 0,
        dismissed: true,
      },
      {
        op: "permit_dismiss",
        sid: SID,
        tool_use_id: "toolu_01",
        kind: "commands",
        index: -1,
        dismissed: true,
      },
      {
        op: "permit_dismiss",
        sid: SID,
        tool_use_id: "toolu_01",
        kind: "commands",
        index: 0,
        dismissed: "yes",
      },
    ],
  },
  permit_grant: {
    ok: {
      op: "permit_grant",
      sid: SID,
      tool_use_id: "toolu_01",
      items: [
        { kind: "intents", index: 0 },
        { kind: "commands", index: 2 },
      ],
    },
    bad: [
      { op: "permit_grant", sid: SID, tool_use_id: "toolu_01", items: [] },
      { op: "permit_grant", sid: SID, tool_use_id: "toolu_01" },
      { op: "permit_grant", sid: SID, items: [{ kind: "intents", index: 0 }] },
      { op: "permit_grant", tool_use_id: "toolu_01", items: [{ kind: "intents", index: 0 }] },
      // Only intents and commands go into the permission copied.
      {
        op: "permit_grant",
        sid: SID,
        tool_use_id: "toolu_01",
        items: [{ kind: "project_permissions", index: 0 }],
      },
      {
        op: "permit_grant",
        sid: SID,
        tool_use_id: "toolu_01",
        items: [{ kind: "intents", index: -1 }],
      },
    ],
  },
  permit_read: {
    ok: { op: "permit_read", ids: ["toolu_01"] },
    bad: [{ op: "permit_read" }, { op: "permit_read", ids: [] }, { op: "permit_read", ids: [1] }],
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
    ok: {
      op: "session_launch",
      launch: { cwd: "/w", resume: SID, fork_session: true, prompt: "p" },
    },
    bad: [
      { op: "session_launch" },
      { op: "session_launch", launch: { cwd: "/w", model: "opus" } },
      { op: "session_launch", cwd: "/w", params: { MODEL: "m" } },
    ],
  },
  launch_tool: {
    ok: { op: "launch_tool", launch: { cwd: "/w", continue: true }, agent_id: "a1" },
    bad: [
      { op: "launch_tool" },
      { op: "launch_tool", launch: { cwd: "/w", model: "opus" } },
      { op: "launch_tool", launch: { cwd: "/w", continue: true }, agent_id: "" },
    ],
  },
  session_kill: {
    ok: { op: "session_kill", session_id: SID, force: true },
    bad: [
      { op: "session_kill", session_id: "" },
      { op: "session_kill", session_id: SID, force: "yes" },
    ],
  },
  session_restart: {
    ok: {
      op: "session_restart",
      session_id: SID,
      prompt: "再起動した",
      model: "sonnet",
      effort: "high",
    },
    bad: [
      { op: "session_restart" },
      { op: "session_restart", session_id: "" },
      { op: "session_restart", session_id: SID, prompt: "" },
      { op: "session_restart", session_id: SID, prompt: 1 },
      { op: "session_restart", session_id: SID, model: "gpt" },
      { op: "session_restart", session_id: SID, effort: "" },
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
    ok: {
      op: "user_prompt",
      session_id: SID,
      text: " two\nlines ",
      model: "sonnet",
      effort: "low",
    },
    bad: [
      { op: "user_prompt", session_id: SID, text: " \n " },
      { op: "user_prompt", text: "x" },
      { op: "user_prompt", session_id: SID, text: "x", effort: "minimal" },
      { op: "user_prompt", session_id: SID, text: "x", model: "claude-opus-5-5" },
      { op: "user_prompt", session_id: SID, text: "x", effort: null },
    ],
  },
  request_override: {
    ok: { op: "request_override", session_id: SID, model: null, effort: "max" },
    bad: [
      { op: "request_override", model: "opus" },
      { op: "request_override", session_id: SID, effort: "minimal" },
      { op: "request_override", session_id: SID, model: "opus[1m]" },
      { op: "request_override", session_id: SID, effort: 3 },
    ],
  },
  turn_abort: {
    ok: { op: "turn_abort", session_id: SID },
    bad: [{ op: "turn_abort" }, { op: "turn_abort", session_id: "" }],
  },
  btw_ask: {
    ok: { op: "btw_ask", session_id: SID, prompt: "この関数は何をしている?", effort: "high" },
    bad: [
      { op: "btw_ask", session_id: SID },
      { op: "btw_ask", session_id: SID, prompt: "  \n " },
      { op: "btw_ask", session_id: "", prompt: "q" },
      { op: "btw_ask", session_id: SID, prompt: "q", effort: "huge" },
    ],
  },
  btw_cancel: {
    ok: { op: "btw_cancel", id: "8f0e4a2c-1b3d-4e5f-9a7b-0c1d2e3f4a5b" },
    bad: [{ op: "btw_cancel" }, { op: "btw_cancel", id: "" }],
  },
  comment_btw_cancel: {
    ok: { op: "comment_btw_cancel", session_id: SID, cid: "c7k2p" },
    bad: [
      { op: "comment_btw_cancel", session_id: SID },
      { op: "comment_btw_cancel", session_id: "../x", cid: "c7k2p" },
      { op: "comment_btw_cancel", session_id: SID, cid: "C-1" },
    ],
  },
  comment_btw_retry: {
    ok: { op: "comment_btw_retry", session_id: SID, cid: "c7k2p" },
    bad: [
      { op: "comment_btw_retry", session_id: SID },
      { op: "comment_btw_retry", session_id: SID, cid: "" },
    ],
  },
  comment_add: {
    ok: {
      op: "comment_add",
      session_id: SID,
      anchor: { kind: "message", uuid: "u-9", msg_start_with: "この関数は" },
      body: "ここは?",
      btw: false,
      send_now: false,
    },
    bad: [
      {
        op: "comment_add",
        session_id: SID,
        anchor: { kind: "message", uuid: "u-9", msg_start_with: "x" },
        body: " \n",
        btw: false,
        send_now: false,
      },
      {
        op: "comment_add",
        session_id: SID,
        anchor: { kind: "nowhere" },
        body: "x",
        btw: false,
        send_now: true,
      },
      {
        op: "comment_add",
        session_id: SID,
        anchor: { kind: "comment", cid: "C-1" },
        body: "x",
        btw: false,
        send_now: true,
      },
      {
        op: "comment_add",
        session_id: "",
        anchor: { kind: "timing" },
        body: "x",
        btw: false,
        send_now: true,
      },
      // The session id names the comments file: nothing that names a file
      // elsewhere (DR-0062 §8).
      {
        op: "comment_add",
        session_id: "../../escaped",
        anchor: { kind: "message", uuid: "u-9", msg_start_with: "x" },
        body: "x",
        btw: false,
        send_now: false,
      },
      // An effort is a btw's choice, in the launch's words.
      {
        op: "comment_add",
        session_id: SID,
        anchor: { kind: "timing" },
        body: "x",
        btw: true,
        effort: "huge",
        send_now: true,
      },
      // Whether it is a btw is always said.
      {
        op: "comment_add",
        session_id: SID,
        anchor: { kind: "timing" },
        body: "x",
        send_now: true,
      },
      // A quote with no text chosen is no quote.
      {
        op: "comment_add",
        session_id: SID,
        anchor: {
          kind: "selection",
          uuid: "u-9",
          msg_start_with: "x",
          text: "",
          before: "",
          after: "",
        },
        body: "x",
        btw: false,
        send_now: false,
      },
      // A file's lines count from 1.
      {
        op: "comment_add",
        session_id: SID,
        anchor: {
          kind: "file",
          path: "a.md",
          view: "source",
          text: "t",
          before: "",
          after: "",
          line: 0,
          line_text: "t",
        },
        body: "x",
        btw: false,
        send_now: false,
      },
    ],
  },
  comment_update: {
    ok: {
      op: "comment_update",
      session_id: SID,
      cid: "c7k2p",
      seen_updated_at: "2026-11-22T00:00:00.000Z",
      body: "直した",
    },
    bad: [{ op: "comment_update", session_id: SID, cid: "c7k2p", body: "直した" }],
  },
  comment_delete: {
    ok: {
      op: "comment_delete",
      session_id: SID,
      cid: "c7k2p",
      seen_updated_at: "2026-11-22T00:00:00.000Z",
    },
    bad: [{ op: "comment_delete", session_id: SID, cid: "c7k2", seen_updated_at: "x" }],
  },
  comment_resolve: {
    ok: { op: "comment_resolve", session_id: SID, cid: "c7k2p", resolved: true, seen_cid: "c9q4r" },
    bad: [{ op: "comment_resolve", session_id: SID, cid: "c7k2p", resolved: true }],
  },
  queue_send: {
    ok: {
      op: "queue_send",
      session_id: SID,
      items: [
        { kind: "comment", cid: "c7k2p", seen_updated_at: "2026-11-22T00:00:00.000Z" },
        { kind: "draft", id: DRAFT_ID, seen_updated_at: "2026-11-22T00:00:00.000Z" },
      ],
    },
    bad: [
      { op: "queue_send", session_id: SID, items: [] },
      {
        op: "queue_send",
        session_id: SID,
        items: [{ kind: "draft", id: "c7k2p", seen_updated_at: "x" }],
      },
    ],
  },
  unconfirmed_settle: {
    ok: {
      op: "unconfirmed_settle",
      session_id: SID,
      item: { kind: "comment", cid: "c7k2p" },
      action: "back_to_draft",
      seen_updated_at: "2026-11-22T00:00:00.000Z",
    },
    bad: [
      {
        op: "unconfirmed_settle",
        session_id: SID,
        item: { kind: "comment", cid: "c7k2p" },
        action: "forget",
        seen_updated_at: "x",
      },
      {
        op: "unconfirmed_settle",
        session_id: SID,
        item: { kind: "draft", cid: "c7k2p" },
        action: "mark_sent",
        seen_updated_at: "x",
      },
    ],
  },
  prompt_queue_add: {
    ok: {
      op: "prompt_queue_add",
      session_id: SID,
      text: "[FILE1] を見て",
      attachments: [{ n: 1, name: "a.png", path: "/tmp/claude-ccmsg-501/attachment/x.png" }],
    },
    bad: [
      { op: "prompt_queue_add", session_id: SID, text: "  ", attachments: [] },
      {
        op: "prompt_queue_add",
        session_id: SID,
        text: "x",
        attachments: [{ n: 0, name: "a.png", path: "/a.png" }],
      },
      { op: "prompt_queue_add", session_id: "../x", text: "x", attachments: [] },
    ],
  },
  prompt_queue_update: {
    ok: {
      op: "prompt_queue_update",
      session_id: SID,
      id: DRAFT_ID,
      seen_updated_at: "2026-11-22T00:00:00.000Z",
      text: "直した",
      attachments: [],
    },
    bad: [
      {
        op: "prompt_queue_update",
        session_id: SID,
        id: "not-a-uuid",
        seen_updated_at: "x",
        text: "x",
        attachments: [],
      },
    ],
  },
  prompt_queue_delete: {
    ok: { op: "prompt_queue_delete", session_id: SID, id: DRAFT_ID, seen_updated_at: "x" },
    bad: [{ op: "prompt_queue_delete", session_id: SID, id: DRAFT_ID }],
  },
  comment_reply: {
    ok: {
      op: "comment_reply",
      cid: "c7k2p",
      body: "そう、undefined を返す",
      tool_use_id: "toolu_1",
    },
    bad: [
      { op: "comment_reply", cid: "c7k2p", body: "  ", tool_use_id: "toolu_1" },
      { op: "comment_reply", cid: "7k2p", body: "x", tool_use_id: "toolu_1" },
      { op: "comment_reply", cid: "c7k2p", body: "x" },
      { op: "comment_reply", cid: "c7k2p", body: "x", tool_use_id: "" },
    ],
  },
  secret_put: {
    ok: { op: "secret_put", session_id: SID, value: "test-secret-0123" },
    bad: [
      { op: "secret_put", session_id: SID },
      { op: "secret_put", session_id: SID, value: "" },
      { op: "secret_put", session_id: SID, value: 123 },
      { op: "secret_put", value: "test-secret-0123" },
    ],
  },
  secret_take: {
    ok: { op: "secret_take", id: "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f" },
    bad: [{ op: "secret_take" }, { op: "secret_take", id: "" }],
  },
  secret_discard: {
    ok: { op: "secret_discard", session_id: SID },
    bad: [{ op: "secret_discard" }, { op: "secret_discard", session_id: "" }],
  },
  secret_status: {
    ok: { op: "secret_status", session_id: SID },
    bad: [{ op: "secret_status" }, { op: "secret_status", session_id: "" }],
  },
  project_auto_mode_read: {
    ok: { op: "project_auto_mode_read", session_id: SID },
    bad: [{ op: "project_auto_mode_read" }, { op: "project_auto_mode_read", session_id: "" }],
  },
  project_auto_mode_write: {
    ok: {
      op: "project_auto_mode_write",
      session_id: SID,
      section: "soft_deny",
      index: 0,
      before: "Never push to main",
      text: "Never push to main or release",
    },
    bad: [
      { op: "project_auto_mode_write", session_id: SID, text: "x" },
      { op: "project_auto_mode_write", session_id: SID, section: "deny", text: "x" },
      { op: "project_auto_mode_write", session_id: SID, section: "allow", text: "$defaults" },
      { op: "project_auto_mode_write", session_id: SID, section: "allow", text: " $defaults\n" },
      {
        op: "project_auto_mode_write",
        session_id: SID,
        section: "allow",
        text: "x".repeat(AUTO_MODE_ENTRY_MAX_LENGTH + 1),
      },
      { op: "project_auto_mode_write", session_id: SID, section: "allow", index: -1, text: "" },
      { op: "project_auto_mode_write", session_id: SID, section: "allow", index: 0.5, text: "" },
    ],
  },
  auto_mode_defaults_read: {
    ok: { op: "auto_mode_defaults_read", version: "/opt/claude/2.1.330:1763800000000" },
    bad: [{ op: "auto_mode_defaults_read" }, { op: "auto_mode_defaults_read", version: "" }],
  },
  userscript_read: { ok: { op: "userscript_read" }, bad: [] },
  userscript_write: {
    ok: { op: "userscript_write", source: "export async function userscript(util) {}\n" },
    bad: [
      { op: "userscript_write" },
      { op: "userscript_write", source: 1 },
      { op: "userscript_write", source: "x".repeat(USERSCRIPT_MAX_LENGTH + 1) },
    ],
  },
  userscript_load: { ok: { op: "userscript_load" }, bad: [] },
  userscript_delete: { ok: { op: "userscript_delete" }, bad: [] },
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
  // The session is named as the other session ops name it: a non-empty id.
  session_runs_as: {
    ok: { op: "session_runs_as", session_id: SID },
    bad: [{ op: "session_runs_as" }, { op: "session_runs_as", session_id: "" }],
  },
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
  claude_update: { ok: { op: "claude_update" }, bad: [] },
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
  transcript_push: {
    ok: {
      op: "transcript_push",
      rows: [
        {
          uuid: "0fffe202-9b1e-4313-86b2-479d24bd37b0",
          door: "response",
          message: {
            type: "assistant",
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          },
        },
        { uuid: "u2", door: "prompt", agent_id: "a0ea5ee99e172bc5c", message: { type: "user" } },
      ],
    },
    bad: [
      { op: "transcript_push" },
      { op: "transcript_push", rows: [] },
      { op: "transcript_push", rows: [{ uuid: "", door: "prompt", message: {} }] },
      { op: "transcript_push", rows: [{ uuid: "u", message: {} }] },
    ],
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
 * layer did not read. A hello of another major is neither, and fails the
 * test that reads one here. */
function readLine(text: string): Parsed<Request> {
  const got = readRequest(text);
  if (got.kind === "other_major_hello") {
    throw new Error(`read as a hello of another major: ${text.slice(0, 200)}`);
  }
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
    const samples: {
      readonly ok: RequestInput;
      readonly bad: readonly object[];
    } = SAMPLES[op];

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

  // The launch is read whole by its own schema, so a field the launch does
  // not have is refused under the launch's path rather than dropped, and a
  // combination claude refuses is refused on the field to change (DR-0018
  // §3.2).
  test("session_launch refuses a field the launch does not have, and a refused combination", () => {
    expect(
      refusal(
        read({
          op: "session_launch",
          launch: { cwd: "/w", model: "opus", effort: "high", resume_session_id: SID },
        }),
      ),
    ).toContain("launch.resume_session_id");
    expect(
      refusal(read({ op: "session_launch", launch: { cwd: "/w", continue: true, resume: SID } })),
    ).toContain("launch.resume");
  });

  // The prompt of a restart is the person's choice; without one the daemon
  // starts the resumed session with RESTART_PROMPT (DR-0028 「restart」).
  test("session_restart reads without a prompt", () => {
    expect(read({ op: "session_restart", session_id: SID })).toEqual({
      ok: true,
      value: { op: "session_restart", session_id: SID, request_id: "q1" },
    });
  });

  // A quote in a Timeline item (DR-0062 §2): the chosen text, what is
  // around it and the offsets as a hint.
  test("comment_add reads a quote in a Timeline item", () => {
    const anchor = {
      kind: "selection",
      uuid: "u-9",
      msg_start_with: "この関数は",
      text: "null を返す",
      before: "呼び出し側で ",
      after: " ことがあり",
      start: 12,
      end: 20,
    } as const;
    expect(
      read({
        op: "comment_add",
        session_id: SID,
        anchor,
        body: "ここは?",
        btw: false,
        send_now: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        op: "comment_add",
        session_id: SID,
        anchor,
        body: "ここは?",
        btw: false,
        send_now: false,
        request_id: "q1",
      },
    });
  });

  // A bash mode command (`! <text>`, DR-0040 §7) is a user_prompt with
  // `mode: "bash"`; a prompt has no mode, and no other mode is read.
  test("user_prompt reads a bash mode command, and no mode it does not know", () => {
    expect(read({ op: "user_prompt", session_id: SID, text: "ls -la", mode: "bash" })).toEqual({
      ok: true,
      value: {
        op: "user_prompt",
        session_id: SID,
        text: "ls -la",
        mode: "bash",
        request_id: "q1",
      },
    });
    for (const mode of ["prompt", "shell", "", null, 1]) {
      expect(refusal(read({ op: "user_prompt", session_id: SID, text: "ls", mode }))).toContain(
        "mode",
      );
    }
  });
});

describe("readRequest: hello by major", () => {
  test("a hello of the daemon's major is served, whatever its minor", () => {
    const hellos: readonly Extract<RequestInput, { op: "hello" }>[] = [
      { op: "hello", role: "user", protocol: PROTOCOL_VERSION },
      {
        op: "hello",
        role: "user",
        protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 1 },
      },
    ];
    for (const hello of hellos) {
      const got = read(hello);
      if (!got.ok) throw new Error(got.failure.summary);
      expect(got.value).toEqual({ ...hello, request_id: "q1" });
    }
  });

  // The rest of a hello of another major is that major's shape and is not
  // read: a client of another major is told which version to run.
  test("a hello of another major reads as one, whatever else it holds", () => {
    const protocol = { major: PROTOCOL_VERSION.major + 1, minor: 0 };
    expect(
      readRequest(
        line({ op: "hello", role: "session", sid: SID, protocol, cwd: ["/w"], request_id: "q1" }),
      ),
    ).toEqual({
      kind: "other_major_hello",
      hello: { op: "hello", role: "session", sid: SID, protocol, request_id: "q1" },
    });
  });

  // A client from before `major.minor` names no protocol, or the bare number
  // 1: both are major 1, which is not the daemon's.
  test("a hello naming no protocol, or a bare number, is of another major", () => {
    expect(UNANNOUNCED_PROTOCOL_MAJOR).not.toBe(PROTOCOL_VERSION.major);
    expect(readRequest(line({ op: "hello", role: "user", request_id: "q1" }))).toEqual({
      kind: "other_major_hello",
      hello: { op: "hello", role: "user", request_id: "q1" },
    });
    expect(readRequest(line({ op: "hello", role: "user", protocol: 1, request_id: "q1" }))).toEqual(
      {
        kind: "other_major_hello",
        hello: { op: "hello", role: "user", protocol: 1, request_id: "q1" },
      },
    );
  });

  test("what a hello of another major says about its client is of its type", () => {
    const protocol = { major: PROTOCOL_VERSION.major + 1, minor: 0 };
    expect(refusal(read({ op: "hello", protocol, sid: 1 }))).toStartWith("sid: ");
  });

  test("a hello of the daemon's major is read whole: a field of another type is refused", () => {
    expect(
      refusal(read({ op: "hello", role: "observer", protocol: PROTOCOL_VERSION })),
    ).toStartWith("role: ");
    expect(refusal(read({ op: "hello", role: "user", protocol: "2" }))).toStartWith("protocol");
  });
});
