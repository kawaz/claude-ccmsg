import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_SEARCH_MATCH_SUMMARY_MAX,
  SESSION_SEARCH_RESULT_MAX,
  type JsonObject,
  type SessionSearchRequest,
} from "@ccmsg/protocol";
import {
  SessionSearchRuns,
  sessionSearch,
  sessionSearchTimeoutMs,
  strictMatch,
  type SearchSignal,
} from "../src/session-search.ts";
import {
  assistantContentRow,
  assistantMessage,
  customTitleRow,
  imageBlock,
  line,
  queueOperationRow,
  textBlock,
  toolResultBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { defined } from "./helpers.ts";

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
  rows: JsonObject[],
  project = "-workspace-repos-github-com-owner-project-main",
): string {
  const dir = path.join(config, "projects", project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map(line).join("\n") + "\n");
  return file;
}

function user(content: string, cwd = "/workspace/repos/github.com/owner/project/main") {
  return userContentRow(content, { timestamp: "2026-07-16T01:02:03.000Z", cwd });
}

function agent(content: string, cwd = "/workspace/repos/github.com/owner/project/main") {
  return assistantContentRow([textBlock(content)], { timestamp: "2026-07-16T01:02:04.000Z", cwd });
}

function ccmsg(from: string, msg: string, operation = "enqueue") {
  return queueOperationRow({
    operation,
    content: `<task-notification><event>${JSON.stringify({
      type: "msg",
      mid: 1,
      from,
      ts: "2026-07-16T01:02:05.000Z",
      msg,
    })}</event></task-notification>`,
    timestamp: "2026-07-16T01:02:06.000Z",
  });
}

async function search(config: string, req: Partial<SessionSearchRequest>) {
  const result = await sessionSearch({ op: "session_search", ...req }, log, [config]);
  if (!result.ok) throw new Error(`${result.code}: ${result.msg}`);
  return result.data;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("session_search three-stage filtering", () => {
  // Each non-blank query line is one clause, and the clauses are OR-ed: a
  // session hits as soon as any single clause is satisfied. Match summaries
  // retain the contributing message rows.
  test("multiline query lines are OR-ed", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      user("alpha first"),
      user("alpha second"),
      user("alpha third"),
      user("alpha fourth"),
      user("beta only"),
    ]);
    writeSession(config, sid(2), [user("alpha only")]);
    writeSession(config, sid(3), [user("beta only")]);
    writeSession(config, sid(4), [user("neither word here")]);

    const result = await search(config, { query: "alpha\n\n beta" });
    expect(result.hits.map((hit) => hit.sid).sort()).toEqual([sid(1), sid(2), sid(3)].sort());
    // Summaries are the newest matching rows, newest first, capped at
    // SESSION_SEARCH_MATCH_SUMMARY_MAX (3).
    expect(
      result.hits.find((hit) => hit.sid === sid(1))?.matches.map((match) => match.text),
    ).toEqual(["beta only", "alpha fourth", "alpha third"]);
  });

  // A clause's AND terms are collected session-wide, so two words typed on one
  // line may land on two different messages of the same session.
  test("whitespace AND terms may be satisfied by separate messages", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha first"), user("beta later")]);
    writeSession(config, sid(2), [user("alpha only")]);

    const result = await search(config, { query: "alpha beta" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.hits[0]?.matches.map((match) => match.text)).toEqual([
      "beta later",
      "alpha first",
    ]);
  });

  // A query word only counts when it appears in an enabled role. The agent row
  // cannot complete the clause's AND while target_agent is disabled.
  test("AND terms respect role toggles per matching message", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("alpha from user"), agent("beta from agent")]);

    const result = await search(config, {
      query: "alpha beta",
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
    expect(result.hits[0]?.matches.map((match) => match.text)).toEqual(["single needle"]);
  });

  test("plain query uses whitespace AND within a line and newline OR between lines", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("foo and bar together")]);
    writeSession(config, sid(2), [user("buz alone")]);
    writeSession(config, sid(3), [user("foo without the rest of its clause")]);

    const result = await search(config, { query: "foo bar\nbuz" });
    expect(result.hits.map((hit) => hit.sid).sort()).toEqual([sid(1), sid(2)].sort());
  });

  test("quoted phrases stay one term and normalize internal whitespace", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("foo\t  bar here")]);
    writeSession(config, sid(2), [user("foo between bar")]);

    const result = await search(config, { query: '"foo   bar "\nbuz' });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  test("repeated whitespace only separates and trims plain AND terms", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("buz alone")]);
    writeSession(config, sid(2), [user("foo only")]);

    const result = await search(config, { query: "foo   bar \n  buz" });
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
  // JSONL lines, but decoded RegExp matching remains authoritative. Each line
  // is one pattern, and the lines are OR-ed.
  test("regex mode applies one pattern per line, OR-ed between lines", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("foo bar"), user("unrelated")]);
    writeSession(config, sid(2), [user("foo or bar"), user("buz elsewhere")]);
    writeSession(config, sid(3), [user("foo or bar"), user("nothing else")]);

    const result = await search(config, { query: "foo bar\nbuz", regex: true });
    expect(result.hits.map((hit) => hit.sid).sort()).toEqual([sid(1), sid(2)].sort());
    expect(result.hits.find((hit) => hit.sid === sid(1))?.matches).toHaveLength(1);
  });

  test("regex mode does not trim spaces from a line", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("x foo y")]);
    writeSession(config, sid(2), [user("foo")]);

    const result = await search(config, { query: " foo ", regex: true });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  // The returned summary preserves matched whitespace so the webui can apply
  // the same regex to it and highlight an explicit newline match.
  test("regex summaries preserve whitespace used by the strict match", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("before foo\nbar after")]);

    const result = await search(config, { query: "foo\\nbar", regex: true });
    expect(result.hits[0]?.matches[0]?.text).toContain("foo\nbar");
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
    expect(result.ended_by).toBe("all");
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
    const result = await sessionSearch({ op: "session_search", query: "(", regex: true }, log, [
      config,
    ]);
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
    expect(agentOnly.hits[0]?.matches.map((match) => match.role)).toEqual(["agent"]);

    const userOnly = await search(config, {
      query: "shared needle",
      target_user: true,
      target_agent: false,
    });
    expect(userOnly.hits[0]?.matches.map((match) => match.role)).toEqual(["user"]);
  });

  // Guarantees attachment-bearing prompts stay searchable: pasting an image
  // makes Claude Code write content as an array whose text blocks hold the
  // typed words (observed in real transcripts), and that text must match like
  // a plain string prompt. tool_result-only arrays must stay unsearchable.
  test("user prompts with attachments match via their text blocks", () => {
    const withImage = line(
      userContentRow([textBlock("attachment needle words"), imageBlock()], {
        timestamp: "2026-07-16T01:02:03.000Z",
      }),
    );
    expect(
      strictMatch(withImage, {
        queryWords: ["attachment", "needle"],
        targetUser: true,
        targetAgent: true,
      }),
    ).toMatchObject({ role: "user" });

    const toolResultOnly = line(userContentRow([toolResultBlock("attachment needle words")]));
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
    const meta = line(userContentRow("meta needle body", { isMeta: true }));
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
    expect(result.hits[0]?.matches.map((match) => match.role)).toEqual(["agent", "user"]);
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
    const enqueued = line(
      queueOperationRow({
        operation: "enqueue",
        content: `<task-notification>\n<summary>Monitor event</summary>\n<event>${body}</event>\n</task-notification>`,
        timestamp: "2026-07-16T02:00:02.000Z",
      }),
    );

    const userHit = strictMatch(enqueued, {
      queryWords: ["batch", "needle"],
      targetUser: true,
      targetAgent: false,
    });
    expect(userHit).toMatchObject({ role: "user", timestamp: "2026-07-16T02:00:00.000Z" });

    const agentHit = strictMatch(enqueued, {
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
      {
        ...user("ignored"),
        message: { role: "user", content: defined(delivery.content, "the delivery's content") },
      },
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
    expect(asAgent.hits[0]?.matches).toHaveLength(1);
    expect(asAgent.hits[0]?.matches[0]?.role).toBe("agent");
  });

  // Guarantees literal-mode prefilter finds escape-bearing needles inside
  // ccmsg deliveries. The event JSON gets serialized into the outer row's
  // `content` string, so a tab / `"` / `\` in the message reaches the raw
  // JSONL line double-escaped. A single-escape-only needle would miss it.
  test("literal query with escape-bearing chars matches ccmsg double-escaped payload", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      ccmsg("u1", "tabbed col1\tcol2 value"),
      ccmsg("u1", "path C:\\Users\\me\\file"),
    ]);
    writeSession(config, sid(2), [user("unrelated transcript")]);

    const tabHit = await search(config, { query: "col1\tcol2" });
    expect(tabHit.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    const backslashHit = await search(config, { query: "C:\\Users" });
    expect(backslashHit.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
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
  // Guarantees both DoS response caps: the answer holds at most 50 sessions,
  // saying so and how far it read, and a fourth matching message never expands
  // the per-file summary past three. Every match here is older than every
  // transcript's last write, so any unread one could still hold a newer match
  // and all 51 are read.
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
    expect(result.ended_by).toBe("hit_limit");
    expect(result.files_total).toBe(SESSION_SEARCH_RESULT_MAX + 1);
    expect(result.files_searched).toBe(SESSION_SEARCH_RESULT_MAX + 1);
    expect(result.hits[0]?.matches).toHaveLength(SESSION_SEARCH_MATCH_SUMMARY_MAX);
  });

  // Structural prefilter false positives are decoded and discarded without a
  // fixed candidate-count cutoff, so a real message after 200 such rows is not
  // hidden and the scan is reported as complete.
  test("many prefilter false positives do not hide a later strict match", async () => {
    const config = configDir();
    const structural = Array.from({ length: 201 }, (_, index) =>
      user(`ordinary ${index}`, "/workspace/prefilter-overflow"),
    );
    writeSession(config, sid(1), [...structural, user("prefilter-overflow actual message")]);

    const result = await search(config, { query: "prefilter-overflow" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.ended_by).toBe("all");
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
    expect(result.ended_by).toBe("all");
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
    const known = defined(
      result.hits.find((hit) => hit.sid === sid(1)),
      "known",
    );
    const unknown = defined(
      result.hits.find((hit) => hit.sid === sid(2)),
      "unknown",
    );
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

  // `/rename` writes a `custom-title` record; a session never renamed has no
  // such record at all, and title must degrade to null rather than a guess.
  test("title is the session's custom-title record, null when never renamed", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      user("hello"),
      customTitleRow({ customTitle: "renamed once", sessionId: sid(1) }),
      user("hello again"),
    ]);
    writeSession(config, sid(2), [user("no rename here")]);

    const result = await search(config, {});
    const bySid = new Map(result.hits.map((hit) => [hit.sid, hit.title]));
    expect(bySid.get(sid(1))).toBe("renamed once");
    expect(bySid.get(sid(2))).toBeNull();
  });

  // The value re-affirms on later lines rather than accumulating a rename
  // history; the first record found already reflects the title as of that
  // point.
  test("title takes the first custom-title record's value", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      customTitleRow({ customTitle: "first title", sessionId: sid(1) }),
      user("hello"),
      customTitleRow({ customTitle: "first title", sessionId: sid(1) }),
    ]);

    const result = await search(config, {});
    expect(result.hits[0]?.title).toBe("first title");
  });
});

// kawaz 2026-11-24 (DR-0021 §2.3): the answer is ordered by each session's
// newest matched message, newest first, and that message's time is the hit's
// time; within a session the summarized matches are the newest, newest first.
describe("session_search order by the newest match", () => {
  const PROJECT_CWD = "/workspace/repos/github.com/owner/project/main";
  const at = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
  const userAt = (content: string, timestamp: string) =>
    userContentRow(content, { timestamp, cwd: PROJECT_CWD });

  test("sessions are ordered by their newest match, not by their last write", async () => {
    const config = configDir();
    // Written to most recently, but its match is three days old.
    writeAged(
      config,
      sid(1),
      [userAt("ordneedle early", at(3 * DAY)), userAt("unrelated", at(HOUR))],
      HOUR,
    );
    writeAged(config, sid(2), [userAt("ordneedle recent", at(2 * HOUR))], 2 * HOUR);
    writeAged(config, sid(3), [userAt("ordneedle middle", at(DAY))], DAY);

    const result = await search(config, { query: "ordneedle" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(2), sid(3), sid(1)]);
  });

  test("a hit's time is its newest matched message, not a later unmatched one", async () => {
    const config = configDir();
    const older = at(5 * HOUR);
    const newest = at(3 * HOUR);
    writeAged(
      config,
      sid(1),
      [
        userAt("timeneedle one", older),
        userAt("timeneedle two", newest),
        userAt("nothing to see", at(HOUR)),
      ],
      HOUR,
    );

    const hit = defined((await search(config, { query: "timeneedle" })).hits[0], "hit");
    expect(hit.latest_match_at).toBe(newest);
    expect(hit).not.toHaveProperty("created_at");
  });

  test("the summary holds the newest matches, newest first", async () => {
    const config = configDir();
    writeAged(
      config,
      sid(1),
      [1, 2, 3, 4, 5].map((n) => userAt(`sumneedle ${n}`, at((10 - n) * HOUR))),
      HOUR,
    );

    const hit = defined((await search(config, { query: "sumneedle" })).hits[0], "hit");
    expect(hit.matches.map((match) => match.text)).toEqual([
      "sumneedle 5",
      "sumneedle 4",
      "sumneedle 3",
    ]);
  });

  // A transcript written to after the newest matches but whose own match is
  // old is read first; it must not take the place of an older-written
  // transcript holding a newer match.
  test("at the hit limit the newest matches are kept", async () => {
    const config = configDir();
    for (let i = 1; i <= SESSION_SEARCH_RESULT_MAX; i++) {
      writeAged(config, sid(i), [userAt("capneedle", at(10 * DAY + i * HOUR))], HOUR);
    }
    const newestMatch = sid(SESSION_SEARCH_RESULT_MAX + 1);
    writeAged(config, newestMatch, [userAt("capneedle", at(3 * HOUR))], 3 * HOUR);

    const result = await search(config, { query: "capneedle", mtime_within: "30d" });
    expect(result.hits).toHaveLength(SESSION_SEARCH_RESULT_MAX);
    expect(result.hits[0]?.sid).toBe(newestMatch);
    // The oldest match of the first 50 written is the one left out.
    expect(result.hits.map((hit) => hit.sid)).not.toContain(sid(SESSION_SEARCH_RESULT_MAX));
    expect(result.ended_by).toBe("hit_limit");
    expect(result.files_searched).toBe(SESSION_SEARCH_RESULT_MAX + 1);
  });

  // A transcript's messages are no newer than its last write: once 50 matches
  // are newer than the next transcript's last write, it and the rest are left
  // unread.
  test("once nothing unread can hold a newer match, the search ends", async () => {
    const config = configDir();
    for (let i = 1; i <= SESSION_SEARCH_RESULT_MAX; i++) {
      writeAged(config, sid(i), [userAt("boundneedle", at(HOUR))], HOUR);
    }
    writeAged(config, sid(SESSION_SEARCH_RESULT_MAX + 1), [userAt("boundneedle", at(DAY))], DAY);

    const result = await search(config, { query: "boundneedle" });
    expect(result.hits).toHaveLength(SESSION_SEARCH_RESULT_MAX);
    expect(result.ended_by).toBe("hit_limit");
    expect(result.files_total).toBe(SESSION_SEARCH_RESULT_MAX + 1);
    expect(result.files_searched).toBe(SESSION_SEARCH_RESULT_MAX);
  });

  test("with an empty query a hit's time is the transcript's last write", async () => {
    const config = configDir();
    writeAged(config, sid(1), [userAt("anything", at(5 * HOUR))], 2 * HOUR);

    const hit = defined((await search(config, {})).hits[0], "hit");
    expect(hit.latest_match_at).toBe(hit.updated_at);
  });
});

// What a hit says a resume of it would run as. Read from the file's end, not
// from the forward scan that, for an empty query, stops as soon as the cwd is
// known: the answer is a property of the session's latest turn.
describe("session_search launch context", () => {
  /** An assistant row run as `model`, at `effort` (none when not given: the
   * CC versions before 2.1.212 wrote none). */
  function agentRun(model: string, effort?: string, extra: JsonObject = {}): JsonObject {
    const { effort: _effort, ...row } = assistantContentRow([textBlock("ok")], {
      message: assistantMessage({ model, content: [textBlock("ok")] }),
      timestamp: "2026-07-16T01:02:07.000Z",
      cwd: "/workspace/repos/github.com/owner/project/main",
      ...extra,
    });
    return effort === undefined ? row : { ...row, effort };
  }

  // A session whose model was switched mid-run must resume as what it is now.
  test("model and effort come from the newest assistant row", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      user("hello"),
      agentRun("claude-sonnet-5", "low"),
      user("switch"),
      agentRun("claude-opus-5[1m]", "high"),
    ]);

    const result = await search(config, {});
    expect(result.hits[0]).toMatchObject({ model: "claude-opus-5[1m]", effort: "high" });
  });

  // A sidechain row is a subagent's turn with its own model, and a
  // `<synthetic>` row is the harness reporting an error — neither says what
  // the session itself runs as (same rule as session-status.ts' context fold).
  test("sidechain and synthetic rows are skipped", async () => {
    const config = configDir();
    writeSession(config, sid(1), [
      agentRun("claude-fable-5", "xhigh"),
      agentRun("claude-haiku-4-5", "low", { isSidechain: true }),
      agentRun("<synthetic>"),
    ]);

    const result = await search(config, {});
    expect(result.hits[0]).toMatchObject({ model: "claude-fable-5", effort: "xhigh" });
  });

  // `effort` is a row-level field older CC versions never wrote; its absence
  // must not cost the model too.
  test("a row without effort still answers the model", async () => {
    const config = configDir();
    writeSession(config, sid(1), [agentRun("claude-fable-5")]);

    const hit = defined((await search(config, {})).hits[0], "hit");
    expect(hit.model).toBe("claude-fable-5");
    expect(hit.effort).toBeUndefined();
  });

  // Nothing to read means nothing is claimed: the launcher then keeps its own
  // declared defaults rather than being handed a guess.
  test("a transcript with no assistant row answers neither", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("hello"), user("anyone there")]);

    const hit = defined((await search(config, {})).hits[0], "hit");
    expect(hit.model).toBeUndefined();
    expect(hit.effort).toBeUndefined();
  });

  // The probe widens its window once (64 KiB → 256 KiB) before giving up, so a
  // long tool-output tail does not hide the turn that produced it.
  test("an assistant row past the first window is still found", async () => {
    const config = configDir();
    const filler = Array.from({ length: 100 }, () => user("x".repeat(1000)));
    writeSession(config, sid(1), [agentRun("claude-opus-5", "high"), ...filler]);

    expect((await search(config, {})).hits[0]).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
    });
  });

  // Past the give-up bound the probe stops rather than re-reading an
  // arbitrarily large file per hit.
  test("an assistant row past the give-up bound is not searched for", async () => {
    const config = configDir();
    const filler = Array.from({ length: 300 }, () => user("x".repeat(1000)));
    writeSession(config, sid(1), [agentRun("claude-opus-5", "high"), ...filler]);

    expect(defined((await search(config, {})).hits[0], "the hit").model).toBeUndefined();
  });
});

// DR-0029: an IO-bearing request must not monopolize the event loop. The scan
// reads the transcript in SCAN_CHUNK_BYTES (4 MiB) reads and passes the loop
// whenever it has held it for its time slice, so a multi-chunk file is the
// smallest fixture that can distinguish yielding during the scan from a single
// yield at entry.
describe("session_search event loop yielding", () => {
  // Self-rescheduling setImmediate: each tick proves the loop completed a turn
  // while the scan was in flight. A microtask-only yield (or a fully
  // synchronous scan) drains before the immediates phase and starves this.
  function startTicker(): { stop: () => number } {
    let ticks = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    return {
      stop: () => {
        running = false;
        return ticks;
      },
    };
  }

  test("a multi-chunk scan lets other event loop work run and still matches", async () => {
    const config = configDir();
    // ~9 MiB of filler spans three 4 MiB chunks; the needle sits last so a
    // dropped chunk carry-over or an early break would lose it.
    const filler = Array.from({ length: 9000 }, () => user("x".repeat(1000)));
    writeSession(config, sid(1), [...filler, user("chunkstraddlingneedle")]);

    const ticker = startTicker();
    const result = await search(config, { query: "chunkstraddlingneedle" });
    const ticks = ticker.stop();

    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.hits[0]?.matches[0]?.text).toBe("chunkstraddlingneedle");
    // One turn per chunk boundary at minimum; the pre-scan and per-project-dir
    // yields push the real count higher.
    expect(ticks).toBeGreaterThanOrEqual(3);
  });
});

/** A signal that reads not aborted the first `times` times it is read, and
 * aborted from then on: a deterministic stand-in for a timer or a stop. */
function abortedAfter(times: number): SearchSignal & { reads: () => number } {
  let reads = 0;
  return {
    get aborted(): boolean {
      reads += 1;
      return reads > times;
    },
    reads: () => reads,
  };
}

/** Write a session updated `ageMs` ago. */
function writeAged(config: string, id: string, rows: JsonObject[], ageMs: number): string {
  const file = writeSession(config, id, rows);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// DR-0021 §2.2: the window is mtime_within..mtime_until, read newest first
// until it is read through, the timeout runs out, or 50 sessions matched; the
// answer says how far it read.
describe("session_search window and timeout", () => {
  test("mtime_until leaves out transcripts updated more recently", async () => {
    const config = configDir();
    writeAged(config, sid(1), [user("windowneedle")], HOUR);
    writeAged(config, sid(2), [user("windowneedle")], 2 * DAY);
    writeAged(config, sid(3), [user("windowneedle")], 10 * DAY);

    const result = await search(config, {
      query: "windowneedle",
      mtime_within: "5d",
      mtime_until: "1d",
    });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(2)]);
    expect(result.files_total).toBe(1);
  });

  test("an empty window is refused before anything is read", async () => {
    const config = configDir();
    writeAged(config, sid(1), [user("x")], HOUR);
    for (const until of ["5d", "7d"]) {
      const result = await sessionSearch(
        { op: "session_search", mtime_within: "5d", mtime_until: until },
        log,
        [config],
      );
      expect(result).toMatchObject({ ok: false, code: "invalid_args" });
      if (!result.ok) expect(result.msg).toContain("is not newer than mtime_within");
    }
  });

  test("timeout_ms is clamped to 1000..15000, 3000 when absent", () => {
    const at = (timeout_ms?: number): number =>
      sessionSearchTimeoutMs({
        op: "session_search",
        ...(timeout_ms === undefined ? {} : { timeout_ms }),
      });
    expect(at()).toBe(3000);
    expect(at(10)).toBe(1000);
    expect(at(-5)).toBe(1000);
    expect(at(5000)).toBe(5000);
    expect(at(999_999)).toBe(15000);
  });

  // The timeout is read before each transcript: the one being read when it
  // runs out is read to its end (its last line still matches), the next is not
  // opened, and the answer says how far the search got.
  test("a search that runs out of time ends at a file boundary and says how far it read", async () => {
    const config = configDir();
    const filler = Array.from({ length: 9000 }, () => user("x".repeat(1000)));
    const newest = writeAged(config, sid(1), [...filler, user("timeneedle")], HOUR);
    writeAged(config, sid(2), [user("timeneedle")], 2 * HOUR);
    writeAged(config, sid(3), [user("timeneedle")], 3 * HOUR);
    // Not out of time before the first transcript, out of time from then on.
    const timeout = abortedAfter(1);

    const result = await sessionSearch(
      { op: "session_search", query: "timeneedle" },
      log,
      [config],
      {
        timeout,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
    expect(result.data.ended_by).toBe("timeout");
    expect(result.data.files_total).toBe(3);
    expect(result.data.files_searched).toBe(1);
    expect(result.data.oldest_searched_mtime).toBe(fs.statSync(newest).mtime.toISOString());
  });

  test("more time reaches further, and a window read through says so", async () => {
    const config = configDir();
    writeAged(config, sid(1), [user("timeneedle")], HOUR);
    writeAged(config, sid(2), [user("timeneedle")], 2 * HOUR);
    const oldest = writeAged(config, sid(3), [user("timeneedle")], 3 * HOUR);

    const short = await sessionSearch(
      { op: "session_search", query: "timeneedle" },
      log,
      [config],
      {
        timeout: abortedAfter(2),
      },
    );
    const long = await sessionSearch({ op: "session_search", query: "timeneedle" }, log, [config], {
      timeout: abortedAfter(Number.MAX_SAFE_INTEGER),
    });

    expect(short.ok && short.data.files_searched).toBe(2);
    expect(short.ok && short.data.ended_by).toBe("timeout");
    expect(long.ok && long.data.hits.map((hit) => hit.sid)).toEqual([sid(1), sid(2), sid(3)]);
    expect(long.ok && long.data.ended_by).toBe("all");
    expect(long.ok && long.data.files_searched).toBe(3);
    expect(long.ok && long.data.oldest_searched_mtime).toBe(
      fs.statSync(oldest).mtime.toISOString(),
    );
  });

  test("an empty window reads nothing and says it read it all", async () => {
    const config = configDir();
    const result = await search(config, { query: "nothing" });
    expect(result).toMatchObject({
      hits: [],
      files_total: 0,
      files_searched: 0,
      oldest_searched_mtime: null,
      ended_by: "all",
    });
  });

  // SessionView's lookup of an ended session: a whole sid narrows the window
  // to its file before anything is read, so the one answer is the whole search.
  test("a lookup by a whole session id is read through in one answer", async () => {
    const config = configDir();
    for (let i = 1; i <= 5; i++) writeAged(config, sid(i), [user(`lookup ${i}`)], i * HOUR);

    const result = await search(config, { sid: sid(4), mtime_within: "36500d" });
    expect(result.hits.map((hit) => hit.sid)).toEqual([sid(4)]);
    expect(result).toMatchObject({ files_total: 1, files_searched: 1, ended_by: "all" });
  });
});

// A connection's next search stops the one it runs (DR-0021 §3.1): the asker
// dropped the earlier answer, so its scan stops instead of reading on for
// nobody. Searches of other connections are left alone.
describe("session_search stopping", () => {
  test("a connection's next search stops its running one, which says it was superseded", async () => {
    const config = configDir();
    writeSession(config, sid(1), [user("stopneedle")]);
    const runs = new SessionSearchRuns<object>();
    const conn = {};
    const req: SessionSearchRequest = { op: "session_search", query: "stopneedle" };

    const first = sessionSearch(req, log, [config], { stop: runs.begin(conn) });
    const second = sessionSearch(req, log, [config], { stop: runs.begin(conn) });

    expect(await first).toMatchObject({ ok: false, code: "search_superseded" });
    const answered = await second;
    expect(answered.ok && answered.data.hits.map((hit) => hit.sid)).toEqual([sid(1)]);
  });

  test("searches of different connections do not stop each other", () => {
    const runs = new SessionSearchRuns<object>();
    const a = runs.begin({});
    const b = runs.begin({});
    expect(a.aborted).toBe(false);
    expect(b.aborted).toBe(false);
  });

  test("an ended search's end does not forget the search that replaced it", () => {
    const runs = new SessionSearchRuns<object>();
    const conn = {};
    const first = runs.begin(conn);
    const second = runs.begin(conn);
    expect(first.aborted).toBe(true);
    runs.end(conn, first);
    runs.begin(conn);
    expect(second.aborted).toBe(true);
  });

  test("stopping a connection stops its running search", () => {
    const runs = new SessionSearchRuns<object>();
    const conn = {};
    const run = runs.begin(conn);
    runs.stop(conn);
    expect(run.aborted).toBe(true);
  });

  // The stop is read after each read of a transcript, so a search stopped in
  // the middle of a large one ends there rather than at its end.
  test("a search stopped mid-file ends at its next read", async () => {
    const config = configDir();
    const filler = Array.from({ length: 9000 }, () => user("x".repeat(1000)));
    writeSession(config, sid(1), [...filler, user("midfileneedle")]);
    // Not stopped when read before the file is opened, stopped from then on.
    const stop = abortedAfter(1);

    const result = await sessionSearch(
      { op: "session_search", query: "midfileneedle" },
      log,
      [config],
      { stop },
    );

    expect(result).toMatchObject({ ok: false, code: "search_superseded" });
    expect(stop.reads()).toBe(2);
  });
});
