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

// request_id is the 2-phase wire correlation id; sessionSearch (the scan under
// test) never reads it — only server.ts's ack/result-event envelope does.
async function search(config: string, req: Partial<SessionSearchRequest>) {
  const result = await sessionSearch(
    { op: "session_search", request_id: "test-request", ...req },
    log,
    [config],
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.msg}`);
  return result.data;
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("session_search three-stage filtering", () => {
  // Each non-blank query line is one session-wide AND clause. Separate
  // messages may satisfy separate clauses, while a session missing any clause
  // must not hit. Match summaries retain the contributing message rows.
  test("multiline query patterns use session-wide AND semantics", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      user("alpha first"),
      user("alpha second"),
      user("alpha third"),
      user("alpha fourth"),
      user("beta only"),
    ]);
    writeSession(config, sid(2), [user("alpha only")]);
    writeSession(config, sid(3), [user("alpha and beta together")]);

    const result = await search(config, { query: "alpha\n\n beta" });
    expect(result.hits.map((hit) => hit.sid)).toEqual(expect.arrayContaining([sid(1), sid(3)]));
    expect(result.hits).toHaveLength(2);
    expect(
      result.hits.find((hit) => hit.sid === sid(1))!.matches.map((match) => match.text),
    ).toEqual(["alpha first", "beta only"]);
    expect(result.hits.find((hit) => hit.sid === sid(3))!.matches).toHaveLength(1);
  });

  // A query word only counts when it appears in an enabled role. The agent row
  // cannot complete the session-wide AND while target_agent is disabled.
  test("session-wide AND respects role toggles per matching message", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha from user"), agent("beta from agent")]);

    const result = await search(config, {
      query: "alpha\nbeta",
      target_user: true,
      target_agent: false,
    });
    expect(result.hits).toHaveLength(0);
  });

  // A one-clause query keeps its existing behavior: one enabled message match
  // admits the session and produces that message as the summary.
  test("single query pattern behavior is unchanged", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("ordinary"), user("single needle")]);
    writeSession(config, sid(2), [user("ordinary only")]);

    const result = await search(config, { query: "single" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.hits[0]!.matches.map((match) => match.text)).toEqual(["single needle"]);
  });

  // Spaces inside one query line are literal content, not an implicit pattern
  // separator; only newlines create additional AND clauses.
  test("one query line remains one literal phrase", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha beta")]);
    writeSession(config, sid(2), [user("alpha and beta")]);

    const result = await search(config, { query: "alpha beta" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // case_sensitive defaults false for compatibility, while true applies to
  // both the serialized-line prefilter and decoded strict match.
  test("case_sensitive controls literal matching", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("MixedCase needle")]);

    expect((await search(config, { query: "mixedcase" })).hits).toHaveLength(1);
    expect((await search(config, { query: "mixedcase", case_sensitive: true })).hits).toHaveLength(
      0,
    );
    expect((await search(config, { query: "MixedCase", case_sensitive: true })).hits).toHaveLength(
      1,
    );
  });

  // A regex with required top-level ASCII literals may use them to prune raw
  // JSONL lines, but decoded RegExp matching remains authoritative. Separate
  // messages may satisfy separate regex clauses within the same session.
  test("regex mode applies AND semantics across the session", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha middle omega"), user("count 1234")]);
    writeSession(config, sid(2), [user("alpha omega without digits")]);

    const result = await search(config, { query: "alpha.*omega\n\\d{4}", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.hits[0]!.matches).toHaveLength(2);
  });

  // The returned summary preserves matched whitespace so the webui can apply
  // the same regex to it and highlight an explicit newline match.
  test("regex summaries preserve whitespace used by the strict match", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("before foo\nbar after")]);

    const result = await search(config, { query: "foo\\nbar", regex: true });
    expect(result.hits[0]!.matches[0]!.text).toContain("foo\nbar");
  });

  // case_sensitive applies to RegExp flags too, not only literal indexOf mode.
  test("case_sensitive controls regex matching", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("MixedCase")]);

    expect((await search(config, { query: "mixedcase", regex: true })).hits).toHaveLength(1);
    expect(
      (await search(config, { query: "mixedcase", regex: true, case_sensitive: true })).hits,
    ).toHaveLength(0);
  });

  // Top-level alternatives do not share either branch's literals. The
  // approximation must skip them so the second branch remains searchable.
  test("regex alternation does not create a false-negative prefilter", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("omega")]);

    const result = await search(config, { query: "alpha|omega", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // Patterns made entirely from escape syntax have no safe raw-JSON literal
  // fragment. The daemon must skip that clause's prefilter and decode every
  // line, including a real hit after 250 non-matching rows.
  test("regex without a safe literal fragment falls back to strict scanning of all lines", async () => {
    const config = configDir();
    const rows = Array.from({ length: 250 }, (_, index) => user(`ordinary ${index}`));
    writeSession(config, sid(1), [...rows, user("value 1234 at the end")]);

    const result = await search(config, { query: "\\d{4}", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.truncated).toBe(false);
  });

  // Hex escapes are deliberately not treated as literal prefilter text: the
  // raw pattern spelling "\\x66" is absent from decoded "foo", yet strict
  // matching must still find it (no prefilter false negative).
  test("regex escape spelling never becomes a false-negative prefilter", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("foo")]);

    const result = await search(config, { query: "\\x66", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // A named backreference's identifier is regex syntax, not message text.
  // The prefilter must not require the group name to appear in the decoded hit.
  test("regex named-backreference syntax is not treated as literal text", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("foofoo")]);

    const result = await search(config, {
      query: "(?<word>foo)\\k<word>",
      regex: true,
    });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // Quantifier digits describe repetition and are not required message text.
  // Treating the "2" in .{2} as a literal prefilter would drop every valid hit.
  test("regex quantifier syntax is never mistaken for required literal text", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("ab")]);

    const result = await search(config, { query: ".{2}", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // Unicode-aware case-insensitive RegExp matching treats long-s as ASCII s.
  // The raw-line approximation must apply the same ASCII-target fold (long-s
  // is unchanged by toLowerCase) or it would reject a strict match before
  // decoding. KELVIN SIGN is the other ASCII-target simple fold; toLowerCase
  // already maps it to "k".
  test("case-insensitive regex prefilter preserves Unicode fold matches", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("ſoo")]);
    writeSession(config, sid(2), [user("Kelvin scale")]);

    expect((await search(config, { query: "soo", regex: true })).hits.map((h) => h.sid)).toEqual([
      sid(1),
    ]);
    expect((await search(config, { query: "kelvin", regex: true })).hits.map((h) => h.sid)).toEqual(
      [sid(2)],
    );
  });

  // Unicode normalization must NOT be part of the prefilter haystack: NFD
  // text ("e" + combining acute) keeps a raw "cafe" run that /cafe/iu strict-
  // matches, but NFC/NFKC composition would erase it and reject the line
  // before decoding (prefilter false negative).
  test("regex prefilter does not normalize away NFD combining sequences", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("see cafe\u0301 here")]);

    expect((await search(config, { query: "cafe", regex: true })).hits.map((h) => h.sid)).toEqual([
      sid(1),
    ]);
    expect(
      (await search(config, { query: "cafe", regex: true, case_sensitive: true })).hits.map(
        (h) => h.sid,
      ),
    ).toEqual([sid(1)]);
  });

  // Invalid regex is a request error rather than an empty successful result,
  // so callers can distinguish bad input from a valid no-hit search.
  test("invalid regex returns invalid_args", async () => {
    const config = configDir();
    const result = await sessionSearch(
      { op: "session_search", request_id: "test-request", query: "(", regex: true },
      log,
      [config],
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_args" });
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
  // batch rather than a single JSON object, and role toggles select which msg
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

  // Structural prefilter false positives are decoded and discarded without a
  // fixed candidate-count cutoff, so a real message after 200 such rows is not
  // hidden and the complete scan is not reported as truncated.
  test("many prefilter false positives do not hide a later strict match", async () => {
    const config = configDir();
    const structural = Array.from({ length: 201 }, (_, index) =>
      user(`ordinary ${index}`, "/workspace/prefilter-overflow"),
    );
    writeSession(config, sid(1), [...structural, user("prefilter-overflow actual message")]);

    const result = await search(config, { query: "prefilter-overflow" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.truncated).toBe(false);
  });

  // A noisy transcript with only structural prefilter hits is not a wall: the
  // scanner finishes it and continues to an older candidate with a real match.
  test("prefilter false positives do not abort scanning later candidates", async () => {
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
    expect(result.truncated).toBe(false);
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

    const result = await sessionSearch(
      { op: "session_search", request_id: "test-request", config_dirs: [outside] },
      log,
      [detected],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.hits).toEqual([]);
  });
});
