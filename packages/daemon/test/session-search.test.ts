import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_SEARCH_MATCH_SUMMARY_MAX,
  SESSION_SEARCH_RESULT_MAX,
  type SessionSearchRequest,
} from "@ccmsg/protocol";
import { sessionSearch, strictMatch } from "../src/session-search.ts";

const roots: string[] = [];
const log = { error(_msg: string): void {} };

function configDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-search-"));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, "projects"));
  return dir;
}

function sid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function writeSession(
  config: string,
  id: string,
  rows: unknown[],
  project = "-workspace-repos-github-com-owner-project-main",
): string {
  const dir = path.join(config, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

function user(content: string, cwd = "/workspace/repos/github.com/owner/project/main") {
  return {
    type: "user",
    message: { role: "user", content },
    timestamp: "2026-07-16T01:02:03.000Z",
    cwd,
  };
}

function agent(content: string, cwd = "/workspace/repos/github.com/owner/project/main") {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: content }] },
    timestamp: "2026-07-16T01:02:04.000Z",
    cwd,
  };
}

function ccmsg(from: string, msg: string, operation = "enqueue") {
  return {
    type: "queue-operation",
    operation,
    content: `<task-notification><event>${JSON.stringify({
      type: "msg",
      mid: 1,
      from,
      ts: "2026-07-16T01:02:05.000Z",
      msg,
    })}</event></task-notification>`,
    timestamp: "2026-07-16T01:02:06.000Z",
  };
}

async function search(config: string, req: Partial<SessionSearchRequest>) {
  const result = await sessionSearch({ op: "session_search", ...req }, log, [config]);
  if (!result.ok) throw new Error(`${result.code}: ${result.msg}`);
  return result.data;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("session_search three-stage filtering", () => {
  // Guarantees the public query meaning: all words must occur in one human
  // message; distributing the words across separate lines is not an AND hit.
  test("query words use message-local AND semantics", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha only"), user("alpha and beta together")]);
    writeSession(config, sid(2), [user("alpha only"), user("beta only")]);

    const result = await search(config, { query: "alpha beta" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.hits[0]!.matches).toHaveLength(1);
  });

  // Guarantees both independent role toggles. The same query text is present on
  // both sides so only role classification can decide which summary survives.
  test("target_user and target_agent independently filter matches", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("shared needle user"), agent("shared needle agent")]);

    const agentOnly = await search(config, {
      query: "shared needle",
      target_user: false,
      target_agent: true,
    });
    expect(agentOnly.hits[0]!.matches.map((match) => match.role)).toEqual(["agent"]);

    const userOnly = await search(config, {
      query: "shared needle",
      target_user: true,
      target_agent: false,
    });
    expect(userOnly.hits[0]!.matches.map((match) => match.role)).toEqual(["user"]);
  });

  // Guarantees attachment-bearing prompts stay searchable: pasting an image
  // makes Claude Code write content as an array whose text blocks hold the
  // typed words (observed in real transcripts), and that text must match like
  // a plain string prompt. tool_result-only arrays must stay unsearchable.
  test("user prompts with attachments match via their text blocks", () => {
    const withImage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "attachment needle words" },
          { type: "image", source: { type: "base64", data: "x" } },
        ],
      },
      timestamp: "2026-07-16T01:02:03.000Z",
    });
    expect(
      strictMatch(withImage, {
        queryWords: ["attachment", "needle"],
        targetUser: true,
        targetAgent: true,
      }),
    ).toMatchObject({ role: "user" });

    const toolResultOnly = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "attachment needle words" }],
      },
    });
    expect(
      strictMatch(toolResultOnly, {
        queryWords: ["attachment", "needle"],
        targetUser: true,
        targetAgent: true,
      }),
    ).toBeUndefined();
  });

  // Guarantees harness-injected user rows (isMeta:true — skill bodies, command
  // caveats, "Continue from where you left off") are not reported as something
  // the user typed.
  test("isMeta user rows are excluded from user matches", () => {
    const meta = JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta needle body" },
    });
    expect(
      strictMatch(meta, { queryWords: ["meta", "needle"], targetUser: true, targetAgent: true }),
    ).toBeUndefined();
  });

  // Guarantees the observed queue-operation shape: only enqueue is searchable,
  // u1 is normalized to user, and every other ccmsg member id to agent.
  test("ccmsg enqueue messages normalize role from event.from", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      ccmsg("u1", "ccmsg role needle user"),
      ccmsg("a1", "ccmsg role needle agent"),
      ccmsg("u1", "ccmsg role needle duplicate", "dequeue"),
      ccmsg("a1", "ccmsg role needle duplicate", "remove"),
    ]);

    const result = await search(config, { query: "ccmsg role needle" });
    expect(result.hits[0]!.matches.map((match) => match.role)).toEqual(["user", "agent"]);
  });

  // Guarantees the real Monitor-delivery shape: the <event> body is a JSONL
  // batch (kind/title/member lines before the msg, non-JSON reply-hint text
  // after) rather than a single JSON object, and role toggles select which msg
  // line inside one batch is reported.
  test("ccmsg multi-line event bodies match their msg line", () => {
    const body = [
      JSON.stringify({ type: "kind", kind: "1on1" }),
      JSON.stringify({ type: "member", id: "a1", sid: "s" }),
      JSON.stringify({
        type: "msg",
        mid: 1,
        from: "u1",
        ts: "2026-07-16T02:00:00.000Z",
        msg: "batch needle from user",
      }),
      JSON.stringify({
        type: "msg",
        mid: 2,
        from: "a1",
        ts: "2026-07-16T02:00:01.000Z",
        msg: "batch needle from agent",
      }),
      "返信: この room に post せず、通常のアシスタント応答で返す",
    ].join("\n");
    const line = JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>\n<summary>Monitor event</summary>\n<event>${body}</event>\n</task-notification>`,
      timestamp: "2026-07-16T02:00:02.000Z",
    });

    const userHit = strictMatch(line, {
      queryWords: ["batch", "needle"],
      targetUser: true,
      targetAgent: false,
    });
    expect(userHit).toMatchObject({ role: "user", timestamp: "2026-07-16T02:00:00.000Z" });

    const agentHit = strictMatch(line, {
      queryWords: ["batch", "needle"],
      targetUser: false,
      targetAgent: true,
    });
    expect(agentHit).toMatchObject({ role: "agent", timestamp: "2026-07-16T02:00:01.000Z" });
  });

  // Guarantees a consumed ccmsg delivery (the task-notification body landing in
  // a user row after dequeue) keeps its true author: an agent-authored post is
  // reported as agent, not as "the user typed this", and the duplicate pair
  // (enqueue row + consumed user row) collapses into one summary entry.
  test("task-notification user rows classify by ccmsg author and dedupe", async () => {
    const config = configDir();
    const delivery = ccmsg("a1", "consumed needle from agent");
    writeSession(config, sid(1), [
      delivery,
      { ...user("ignored"), message: { role: "user", content: delivery.content } },
    ]);

    const asUser = await search(config, {
      query: "consumed needle",
      target_user: true,
      target_agent: false,
    });
    expect(asUser.hits).toHaveLength(0);

    const asAgent = await search(config, {
      query: "consumed needle",
      target_user: false,
      target_agent: true,
    });
    expect(asAgent.hits[0]!.matches).toHaveLength(1);
    expect(asAgent.hits[0]!.matches[0]!.role).toBe("agent");
  });

  // Guarantees the strict third stage removes a grep hit from a structural field
  // (cwd) when the actual user message does not contain the query.
  test("strict field parsing removes structural prefilter false positives", () => {
    const line = JSON.stringify({
      ...user("ordinary message", "/workspace/structural-needle"),
    });
    expect(
      strictMatch(line, {
        queryWords: ["structural-needle"],
        targetUser: true,
        targetAgent: true,
      }),
    ).toBeUndefined();
  });

  // Guarantees the metadata-stage default is five days and an explicit broader
  // duration re-admits the same unchanged transcript.
  test("mtime default and override bound candidate files", async () => {
    const config = configDir();
    const file = writeSession(config, sid(1), [user("old transcript")]);
    const old = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(file, old, old);

    expect((await search(config, {})).hits).toHaveLength(0);
    expect((await search(config, { mtime_within: "30d" })).hits.map((hit) => hit.sid)).toEqual([
      sid(1),
    ]);
  });

  // Guarantees sid filtering is a case-insensitive substring match rather than
  // requiring the caller to already know the complete UUID.
  test("sid accepts a UUID substring", async () => {
    const config = configDir();
    writeSession(config, sid(0xabc), [user("one")]);
    writeSession(config, sid(0xdef), [user("two")]);

    const result = await search(config, { sid: "00000abc" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(0xabc)]);
  });

  // Guarantees flattened project names are only a coarse prefilter. Underscore
  // spelling is recovered and finally judged against the top-level JSONL cwd.
  test("cwd words AND is decided by restored cwd", async () => {
    const config = configDir();
    const cwd = "/workspace/path/special_word";
    writeSession(config, sid(1), [user("cwd case", cwd)], "-workspace-path-special-word");
    writeSession(
      config,
      sid(2),
      [user("cwd case", "/workspace/path/other_word")],
      "-workspace-path-special-word-other",
    );

    const result = await search(config, { cwd: "path special_word" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });
});

describe("session_search result metadata and limits", () => {
  // Guarantees both DoS response caps: a 51st matching file marks truncation,
  // and a fourth matching message never expands the per-file summary past three.
  test("result and match-summary caps truncate boundedly", async () => {
    const config = configDir();
    for (let i = 1; i <= SESSION_SEARCH_RESULT_MAX + 1; i++) {
      writeSession(config, sid(i), [
        user("limit needle one"),
        user("limit needle two"),
        user("limit needle three"),
        user("limit needle four"),
      ]);
    }

    const result = await search(config, { query: "limit needle" });
    expect(result.hits).toHaveLength(SESSION_SEARCH_RESULT_MAX);
    expect(result.truncated).toBe(true);
    expect(result.hits[0]!.matches).toHaveLength(SESSION_SEARCH_MATCH_SUMMARY_MAX);
  });

  // Guarantees the per-file grep candidate cap never masquerades as a complete
  // negative result: excess structural hits mark the overall response truncated.
  test("prefilter candidate overflow is reported as truncated", async () => {
    const config = configDir();
    const structural = Array.from({ length: 201 }, (_, index) =>
      user(`ordinary ${index}`, "/workspace/prefilter-overflow"),
    );
    writeSession(config, sid(1), [...structural, user("prefilter-overflow actual message")]);

    const result = await search(config, { query: "prefilter-overflow" });
    expect(result.hits).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  // Guarantees one noisy transcript is not a wall: a file that overflows its
  // per-file grep candidate cap marks the response truncated but scanning
  // continues, so a genuine match in an older file is still returned.
  test("per-file overflow does not abort scanning later candidates", async () => {
    const config = configDir();
    const structural = Array.from({ length: 201 }, (_, index) =>
      user(`ordinary ${index}`, "/workspace/wall-needle"),
    );
    const noisy = writeSession(config, sid(1), structural);
    writeSession(config, sid(2), [user("wall-needle real message")]);
    // Make the noisy file the newest so it is scanned first.
    const newer = new Date(Date.now() + 60_000);
    fs.utimesSync(noisy, newer, newer);

    const result = await search(config, { query: "wall-needle" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(2)]);
    expect(result.truncated).toBe(true);
  });

  // Guarantees metadata lines with null/no timestamp do not become creation
  // time: the first parseable timestamp-bearing line is authoritative.
  test("created_at uses the first timestamp-bearing row", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      { type: "last-prompt", timestamp: null },
      { type: "custom-title", title: "x" },
      user("created timestamp"),
    ]);

    const result = await search(config, {});
    expect(result.hits[0]!.created_at).toBe("2026-07-16T01:02:03.000Z");
  });

  // Guarantees repo/workspace labels are heuristic annotations only: the known
  // layout yields owner/repo + remaining path, while an arbitrary cwd stays null.
  test("repo and ws derive only from the repos path convention", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      user("known", "/x/repos/github.com/owner/repo/worktrees/feature"),
    ]);
    writeSession(
      config,
      sid(2),
      [user("unknown", "/opt/arbitrary/project")],
      "-opt-arbitrary-project",
    );

    const result = await search(config, {});
    const known = result.hits.find((hit) => hit.sid === sid(1))!;
    const unknown = result.hits.find((hit) => hit.sid === sid(2))!;
    expect(known.repo).toBe("owner/repo");
    expect(known.ws).toBe(path.join("worktrees", "feature"));
    expect(unknown.repo).toBeNull();
    expect(unknown.ws).toBeNull();
  });

  // Guarantees client-provided config dirs are intersected with the detected
  // set, so an arbitrary path never becomes a search root.
  test("config_dirs cannot widen beyond detected dirs", async () => {
    const detected = configDir();
    const outside = configDir();
    writeSession(detected, sid(1), [user("inside")]);
    writeSession(outside, sid(2), [user("outside")]);

    const result = await sessionSearch({ op: "session_search", config_dirs: [outside] }, log, [
      detected,
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.hits).toEqual([]);
  });
});
