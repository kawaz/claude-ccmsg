import * as fs from "node:fs";
import * as path from "node:path";
import { turnSlice, yieldToEventLoop } from "./event-loop.ts";
import * as v from "valibot";
import {
  ADMIN_ID,
  AssistantMessageSchema,
  AssistantRowSchema,
  CustomTitleRowSchema,
  ErrorCode,
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  MsgEventSchema,
  parseWith,
  RowHeadEntries,
  TranscriptRowLineSchema,
  SESSION_SEARCH_MATCH_SUMMARY_MAX,
  SESSION_SEARCH_RESULT_MAX,
  SESSION_SEARCH_TIMEOUT_DEFAULT_MS,
  clampSessionSearchTimeout,
  parseSearchQueryPatterns,
  type ErrorCode as ErrorCodeType,
  type SearchQueryPattern,
  type SessionSearchHit,
  type SessionSearchMatch,
  type SessionSearchRequest,
  type SessionSearchResponse,
  type UserRow,
} from "@ccmsg/protocol";
import { deriveRepoLocation, isValidSid } from "./virtual-sessions.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const SNIPPET_CONTEXT_CHARS = 80;

/** What the head of a candidate session gives a hit, read from each row of
 * the early window: where the session ran and the title `/rename` gave it (a
 * `custom-title` row's `customTitle`). Only these fields are read, so a row
 * whose other fields are wrong still gives them. */
const SearchHeadLineSchema = jsonText(
  v.looseObject({
    type: v.optional(RowHeadEntries.type),
    cwd: v.optional(RowHeadEntries.cwd),
    customTitle: v.optional(CustomTitleRowSchema.entries.customTitle),
  }),
);

export interface SessionSearchLog {
  error(msg: string): void;
}

export interface CandidateFile {
  sid: string;
  configDir: string;
  file: string;
  projectDirName: string;
  stat: fs.Stats;
}

export interface ListCandidateParams {
  configDirs: readonly string[];
  selectedConfigDirs?: readonly string[];
  sid?: string;
  cwdWords: readonly string[];
  modifiedAfterMs: number;
  /** Transcripts updated after this are left out; absent leaves none out. */
  modifiedBeforeMs?: number;
}

export type SessionSearchResult =
  | { ok: true; data: SessionSearchResponse }
  | { ok: false; code: ErrorCodeType; msg: string };

function words(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function lowerIncludesAll(text: string, needles: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return needles.every((needle) => lower.includes(needle));
}

interface CompiledQueryPattern {
  matcher: RegExp;
  /** Serialized-line substrings, any of which every strict match must contain.
   * null means this pattern cannot safely participate in the JSONL prefilter.
   * Literal-mode patterns carry both the singly-JSON-escaped and doubly-escaped
   * spellings: ccmsg deliveries land as a JSON-encoded event body inside an
   * outer row's `content` string, so their escape-bearing characters (tab,
   * `"`, `\`, ...) appear double-escaped in the raw line and would miss a
   * single-escape needle. Any-match semantics keep the strict decoder as the
   * final authority. */
  prefilters: readonly string[] | null;
}

/** Returns a conservative top-level ASCII-alphanumeric run that every match of
 * `pattern` must contain. Runs inside groups/classes and patterns with a
 * top-level alternation are ignored; a quantified final atom is removed from
 * its run. Returning null only costs performance — strict decoded matching is
 * still authoritative. */
function regexRequiredLiteral(pattern: string): string | null {
  let depth = 0;
  let inClass = false;
  const runs: string[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\") {
      const escapeKind = pattern.charAt(i + 1);
      if (escapeKind === "x") i += 3;
      else if (escapeKind === "u" && pattern[i + 2] === "{") {
        const end = pattern.indexOf("}", i + 3);
        i = end >= 0 ? end : pattern.length;
      } else if (escapeKind === "u") i += 5;
      else if ((escapeKind === "p" || escapeKind === "P") && pattern[i + 2] === "{") {
        const end = pattern.indexOf("}", i + 3);
        i = end >= 0 ? end : pattern.length;
      } else if (escapeKind === "k" && pattern[i + 2] === "<") {
        const end = pattern.indexOf(">", i + 3);
        i = end >= 0 ? end : pattern.length;
      } else if (escapeKind === "c") i += 2;
      else if (escapeKind && /[0-9]/.test(escapeKind)) {
        while (/[0-9]/.test(pattern.charAt(i + 1))) i += 1;
      } else i += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      i = end >= 0 ? end : pattern.length;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && ch === "|") return null;
    if (depth !== 0 || !/[A-Za-z0-9]/.test(ch)) continue;

    const start = i;
    while (/[A-Za-z0-9]/.test(pattern.charAt(i + 1))) i += 1;
    let run = pattern.slice(start, i + 1);
    const next = pattern[i + 1];
    if (next === "?" || next === "*" || next === "+" || next === "{") {
      run = run.slice(0, -1);
    }
    if (run.length > 0) runs.push(run);
  }

  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

function jsonEscape(source: string): string {
  return JSON.stringify(source).slice(1, -1);
}

/** Literal-mode prefilter spellings. A ccmsg delivery serializes its inner
 * event JSON into the outer row's `content` string, so escape-bearing
 * characters (tab, `"`, `\`, ...) reach the raw JSONL line as the
 * doubly-escaped form and would slip past a needle that only spells the
 * single-escape form. Words with no escape-bearing characters collapse to a
 * single unique spelling. */
function literalListFromPlain(word: string): readonly string[] | null {
  const single = jsonEscape(word);
  const double = jsonEscape(single);
  return single === double ? [single] : [single, double];
}

/** Regex prefilter runs are extracted from a top-level ASCII-alphanumeric
 * run, so no escape-bearing character is ever present — the double-escape
 * alternative would be identical and adds no coverage. */
function literalListFromRegex(literal: string | null): readonly string[] | null {
  return literal === null ? null : [literal];
}

function compileQueryClauses(
  clauses: readonly (readonly SearchQueryPattern[])[],
  caseSensitive: boolean,
  regex: boolean,
): { ok: true; clauses: CompiledQueryPattern[][] } | { ok: false; msg: string } {
  const compiledClauses: CompiledQueryPattern[][] = [];
  for (const clause of clauses) {
    const compiled: CompiledQueryPattern[] = [];
    for (const pattern of clause) {
      if (pattern.error !== null) {
        return {
          ok: false,
          msg: `session_search query contains an invalid regular expression: ${pattern.error}`,
        };
      }
      const literals = regex
        ? literalListFromRegex(regexRequiredLiteral(pattern.source))
        : literalListFromPlain(
            pattern.text.split(/\s+/v).sort((a, b) => b.length - a.length)[0] ?? "",
          );
      compiled.push({
        matcher: new RegExp(pattern.source, pattern.flags),
        prefilters:
          literals === null
            ? null
            : caseSensitive
              ? literals
              : literals.map((literal) => literal.toLowerCase()),
      });
    }
    compiledClauses.push(compiled);
  }
  return { ok: true, clauses: compiledClauses };
}

function patternIndex(text: string, pattern: CompiledQueryPattern): number {
  return pattern.matcher.exec(text)?.index ?? -1;
}

function roughPathToken(value: string): string {
  return value.toLowerCase().replace(/[-/._\s]/g, "");
}

function roughCwdMatches(projectDirName: string, cwdWords: readonly string[]): boolean {
  if (cwdWords.length === 0) return true;
  const haystack = roughPathToken(projectDirName);
  return cwdWords.every((word) => haystack.includes(roughPathToken(word)));
}

/** Metadata-stage enumeration. The flattened project directory name is only a
 * lossy prefilter (`/`, `.`, and `_` can all become `-`); final cwd truth is
 * always checked against the first absolute top-level cwd inside the JSONL. */
export async function listCandidateFiles(params: ListCandidateParams): Promise<CandidateFile[]> {
  const detected = new Set(params.configDirs);
  const selected = params.selectedConfigDirs
    ? new Set(params.selectedConfigDirs.filter((dir) => detected.has(dir)))
    : detected;
  const sidNeedle = params.sid?.toLowerCase();
  const candidates: CandidateFile[] = [];

  for (const configDir of [...selected].sort()) {
    const projects = path.join(configDir, "projects");
    let projectEntries: fs.Dirent[];
    try {
      projectEntries = await fs.promises.readdir(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      if (!roughCwdMatches(projectEntry.name, params.cwdWords)) continue;
      const projectDir = path.join(projects, projectEntry.name);
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      // A config dir holds one project directory per session cwd, each with a
      // stat per transcript; yielding per directory keeps the metadata sweep
      // from monopolizing the loop on a large `~/.claude` tree.
      await yieldToEventLoop();
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sid = entry.name.slice(0, -".jsonl".length);
        if (!isValidSid(sid)) continue;
        if (sidNeedle && !sid.toLowerCase().includes(sidNeedle)) continue;
        const file = path.join(projectDir, entry.name);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs < params.modifiedAfterMs) continue;
        if (params.modifiedBeforeMs !== undefined && stat.mtimeMs > params.modifiedBeforeMs) {
          continue;
        }
        candidates.push({ sid, configDir, file, projectDirName: projectEntry.name, stat });
      }
    }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
  return candidates;
}

/** Windows the launch-context probe reads from a transcript's end, tried in
 * order. The first covers what a transcript's last records normally are (an
 * assistant row sits within a few kilobytes of the end unless the session
 * stopped mid-tool-output); the second is the give-up bound — a session whose
 * final quarter-megabyte holds no main-context assistant row simply reports
 * nothing, rather than letting one candidate re-read an arbitrarily large file. */
const LAUNCH_CONTEXT_WINDOWS = [64 * 1024, 256 * 1024] as const;

/** What a session was last running as, as raw transcript spellings. Absent
 * fields mean "not established" rather than "default": the launcher only seeds
 * a field it actually read. */
export interface SessionLaunchContext {
  model?: string;
  effort?: string;
}

/** The model/effort of the newest main-context assistant record in `file`.
 *
 * Read from the end rather than from the forward scan that produces the rest of
 * a hit: with an empty query that scan stops as soon as it has the cwd (in the
 * first records), while "what this session runs as" is a property of its latest
 * turn — a session whose model was switched mid-run must resume as what it is
 * now, not as what it started as. Sidechain rows are subagent turns with their
 * own model, and `<synthetic>` rows are the harness reporting an error, so
 * neither says anything about the session itself (same rule as
 * session-status.ts' context fold). */
export async function readSessionLaunchContext(file: string): Promise<SessionLaunchContext> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return {};
  }
  const handle = await fs.promises.open(file, "r");
  try {
    for (const window of LAUNCH_CONTEXT_WINDOWS) {
      const start = Math.max(0, size - window);
      const length = size - start;
      if (length <= 0) return {};
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const text = buffer.toString("utf-8", 0, bytesRead);
      const lines = text.split("\n");
      // A window that starts mid-file opens inside a record; that partial line
      // is unparseable and belongs to the next, wider window.
      if (start > 0) lines.shift();
      for (const line of lines.toReversed()) {
        const context = launchContextFromRow(line);
        if (context) return context;
      }
      if (start === 0) return {};
    }
    return {};
  } finally {
    await handle.close();
  }
}

/** An assistant row, read for what it ran as: whose turn it is (a
 * subagent's, on a sidechain), its model, and its effort. */
const LaunchContextLineSchema = jsonText(
  v.looseObject({
    type: AssistantRowSchema.entries.type,
    isSidechain: AssistantRowSchema.entries.isSidechain,
    message: v.looseObject({ model: AssistantMessageSchema.entries.model }),
    effort: AssistantRowSchema.entries.effort,
  }),
);

/** One transcript line's launch context, or undefined when the line is not a main-context assistant record. `effort` is a row-level field (not part of `message`) that CC versions before 2.1.212 never wrote, so a row can name a model and no effort. The whole read of a session's transcript when the daemon first knows it takes its model and effort from here too (transcript-facts.ts). */
export function launchContextFromRow(line: string): SessionLaunchContext | undefined {
  const read = parseWith(LaunchContextLineSchema, line);
  if (!read.ok) return undefined;
  const { isSidechain, message, effort } = read.value;
  if (isSidechain || message.model === "<synthetic>") return undefined;
  return { model: message.model, ...(effort !== undefined ? { effort } : {}) };
}

interface ScanResult {
  /** The newest SESSION_SEARCH_MATCH_SUMMARY_MAX messages carrying a query
   * term, newest first. */
  matches: SessionSearchMatch[];
  /** The newest time among every message carrying a query term (not only the
   * summarized ones), in ms; null when none carried a time. */
  latestMatchMs: number | null;
  /** True once some clause had every one of its AND terms matched somewhere in
   * the session (always true for an empty query). */
  queryMatched: boolean;
  cwd: string | null;
  title: string | null;
}

/** What a search reads to know it was asked to end: an AbortSignal, or a
 * test's own object. */
export interface SearchSignal {
  readonly aborted: boolean;
}

const NEVER: SearchSignal = { aborted: false };

/** The search each connection runs now. A connection's next search stops the
 * one it already runs: the webui drops the answer of a search it ran again,
 * so the scan would only keep reading for nobody. A search for one whole
 * session id (SessionView's lookup of an ended session, one file) is left
 * out of this, or it would stop the Session Search panel's search running on
 * the same connection. */
export class SessionSearchRuns<Owner extends object> {
  readonly #running = new Map<Owner, AbortController>();

  /** The stop of `owner`'s new search, stopping the search it runs now. */
  begin(owner: Owner): AbortSignal {
    this.stop(owner);
    const run = new AbortController();
    this.#running.set(owner, run);
    return run.signal;
  }

  /** `owner`'s search whose stop is `signal` ended. */
  end(owner: Owner, signal: AbortSignal): void {
    if (this.#running.get(owner)?.signal === signal) this.#running.delete(owner);
  }

  /** Stop the search `owner` runs now (it began another, or its connection
   * closed). */
  stop(owner: Owner): void {
    this.#running.get(owner)?.abort();
    this.#running.delete(owner);
  }
}

function linePassesPrefilter(
  line: string,
  clauses: readonly (readonly CompiledQueryPattern[])[],
  caseSensitive: boolean,
): boolean {
  // Case-insensitive regex prefilter fragments are ASCII-alphanumeric-only
  // (regexRequiredLiteral), so the haystack must fold every character that
  // RegExp "iu" simple-case-folds onto ASCII: toLowerCase covers KELVIN SIGN
  // (U+212A → k), and LATIN SMALL LETTER LONG S (U+017F, unchanged by
  // toLowerCase, folds to "s") is replaced explicitly. Unicode normalization
  // (NFKC/NFKD) must NOT be applied here: composing an NFD sequence
  // (U+0065 U+0301) into U+00E9 removes the raw "e" that a /cafe/iu strict match
  // depends on, creating a prefilter false negative.
  const haystack = caseSensitive ? line : line.toLowerCase().replaceAll("ſ", "s");
  // A clause's AND terms are collected session-wide, so different terms may
  // land on different rows: a row survives when any term of any clause may
  // match it. A pattern without a safe literal admits every row to the strict
  // stage.
  return clauses.some((clause) =>
    clause.some(
      (pattern) =>
        pattern.prefilters === null ||
        pattern.prefilters.some((needle) => haystack.includes(needle)),
    ),
  );
}

async function scanCandidateFile(
  file: string,
  clauses: readonly (readonly CompiledQueryPattern[])[],
  targetUser: boolean,
  targetAgent: boolean,
  caseSensitive: boolean,
  stop: SearchSignal,
): Promise<ScanResult | null> {
  const size = (await fs.promises.stat(file)).size;
  // The newest messages carrying a query term so far, oldest first: a later
  // one pushes the oldest out, so the whole file read leaves the newest.
  const recent: { match: SessionSearchMatch; key: string }[] = [];
  let latestMatchMs: number | null = null;
  // Each clause with the indexes of its AND terms seen anywhere in this session.
  const clauseProgress = clauses.map((clause) => ({ clause, matched: new Set<number>() }));
  const someClauseComplete = (): boolean =>
    clauseProgress.some(({ clause, matched }) => matched.size === clause.length);
  let cwd: string | null = null;
  // Best-effort within the part of the file read for the rest of the hit (see
  // the `title` field's doc comment on SessionSearchHit): the stop condition
  // below deliberately stays keyed on cwd only, so a session with no
  // `custom-title` ever ends an empty query's scan as soon as its cwd is known
  // — title just rides along on whatever gets read anyway.
  let title: string | null = null;
  let offset = 0;
  let carry = Buffer.alloc(0);
  const handle = await fs.promises.open(file, "r");

  const inspect = (line: string): void => {
    if (clauses.length > 0 && linePassesPrefilter(line, clauses, caseSensitive)) {
      forEachSearchableMessage(line, targetUser, targetAgent, (role, text, timestamp) => {
        const matchingPatterns: CompiledQueryPattern[] = [];
        for (const { clause, matched } of clauseProgress) {
          for (const [termIndex, pattern] of clause.entries()) {
            if (patternIndex(text, pattern) < 0) continue;
            matched.add(termIndex);
            matchingPatterns.push(pattern);
          }
        }
        // Every message carrying a query term counts toward the session's
        // newest match and is summary-worthy: a session only reaches the
        // response once some clause is complete, so rows from a clause that
        // never completes are discarded with the whole candidate rather than
        // needing a per-row eligibility rule here.
        if (matchingPatterns.length === 0) return;
        const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
        if (Number.isFinite(at) && (latestMatchMs === null || at > latestMatchMs)) {
          latestMatchMs = at;
        }
        const match: SessionSearchMatch = {
          role,
          text: snippet(text, matchingPatterns),
          ...(timestamp ? { timestamp } : {}),
        };
        // A ccmsg delivery can be written twice (its enqueue row and the user
        // row that consumed it). Only the kept messages reach the response, so
        // only they are checked for the same message.
        const key = `${match.role}\0${match.timestamp ?? ""}\0${match.text}`;
        if (recent.some((kept) => kept.key === key)) return;
        recent.push({ match, key });
        if (recent.length > SESSION_SEARCH_MATCH_SUMMARY_MAX) recent.shift();
      });
    }
    // title is intentionally excluded from the outer per-chunk stop condition
    // (see its declaration above) but must still be tried here: this guard
    // only skips JSON.parse on lines already resident in memory from a chunk
    // read the outer condition would fetch anyway, so keeping it open for
    // title costs no extra disk I/O — only a little more CPU on data already
    // in hand.
    if (cwd !== null && title !== null) return;
    const read = parseWith(SearchHeadLineSchema, line);
    if (!read.ok) return;
    const row = read.value;
    if (cwd === null && row.cwd !== undefined && path.isAbsolute(row.cwd)) cwd = row.cwd;
    // `/rename` writes `{"type":"custom-title","customTitle":"...",...}`
    // records; the same value tends to repeat on later lines (a context
    // re-affirmation, not a rename-in-place), so the first one found already
    // reflects the title as of that point.
    if (
      title === null &&
      row.type === "custom-title" &&
      row.customTitle !== undefined &&
      row.customTitle !== ""
    ) {
      title = row.customTitle;
    }
  };

  const slice = turnSlice();
  try {
    while (offset < size) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, size - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead: read } = await handle.read(chunk, 0, toRead, offset);
      // A stopped search ends where it awaited, not at the file's end: its
      // answer is not waited for (SessionSearchRuns).
      if (stop.aborted) return null;
      if (read === 0) break;
      offset += read;
      const data =
        carry.length === 0
          ? chunk.subarray(0, read)
          : Buffer.concat([carry, chunk.subarray(0, read)]);
      let start = 0;
      for (;;) {
        // Parsing and matching lines is pure CPU, so the loop must re-enter
        // the event loop itself rather than relying on the read's IO wait.
        if (slice.spent()) {
          await slice.pass();
          if (stop.aborted) return null;
        }
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        inspect(data.toString("utf-8", start, newline));
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      // Once the cwd is known, an empty query needs no more rows. A non-empty
      // query reads the whole file: its newest match may be on the last line.
      if (cwd !== null && clauses.length === 0) break;
    }
    if (carry.length > 0 && offset === size) inspect(carry.toString("utf-8"));
  } finally {
    await handle.close();
  }
  return {
    matches: recent.map((kept) => kept.match).toReversed(),
    latestMatchMs,
    queryMatched: clauses.length === 0 || someClauseComplete(),
    cwd,
    title,
  };
}

export interface StrictMatchParams {
  queryWords: readonly string[];
  targetUser: boolean;
  targetAgent: boolean;
  caseSensitive?: boolean;
  regex?: boolean;
}

interface CompiledStrictMatchParams {
  clauses: readonly (readonly CompiledQueryPattern[])[];
  targetUser: boolean;
  targetAgent: boolean;
}

function tagBody(content: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = content.indexOf(open);
  const end = content.lastIndexOf(close);
  if (start < 0 || end < start + open.length) return undefined;
  return content.slice(start + open.length, end);
}

function snippet(text: string, patterns: readonly CompiledQueryPattern[]): string {
  const source = text.trim();
  let index = -1;
  for (const pattern of patterns) {
    const found = patternIndex(source, pattern);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return source.slice(0, SNIPPET_CONTEXT_CHARS * 2);
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(source.length, index + SNIPPET_CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

/** Extract the human-authored text of a user row. Claude Code writes plain
 * prompts as a content string, and attachment-bearing prompts (images pasted
 * into the terminal) as a content array whose text blocks carry the typed
 * words — both observed in real transcripts. `isMeta:true` rows are excluded:
 * those text blocks are harness injections (skill bodies, command caveats),
 * not something the user said. tool_result-only arrays yield no text. */
function userText(row: UserRow): string | undefined {
  if (row.isMeta === true) return undefined;
  const content = row.message.content;
  if (typeof content === "string") return content;
  const texts = content.flatMap((block) =>
    isKnownContentBlock(block) && block.type === "text" ? [block.text] : [],
  );
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** A ccmsg message event, as one line of a task notification's `<event>`
 * body carries it (the subscribe stream's form of a room's msg event). Only
 * the fields a search reads. */
const CcmsgMsgEventLineSchema = jsonText(
  v.looseObject({
    type: MsgEventSchema.entries.type,
    msg: MsgEventSchema.entries.msg,
    from: v.optional(MsgEventSchema.entries.from),
    ts: v.optional(MsgEventSchema.entries.ts),
  }),
);

/** Visit searchable ccmsg deliveries inside a task-notification body. The
 * observed <event> body is a small JSONL batch (kind/title/member/msg stream
 * lines plus non-JSON reply-hint trailer text), not always a single JSON
 * object. `from:"u1"` normalizes to user and every other member id to agent. */
function forEachCcmsgMessage(
  content: string,
  targetUser: boolean,
  targetAgent: boolean,
  visit: (role: "user" | "agent", text: string, timestamp: string | undefined) => void,
): void {
  const eventBody = tagBody(content, "event");
  if (!eventBody) return;
  for (const eventLine of eventBody.split("\n")) {
    const read = parseWith(CcmsgMsgEventLineSchema, eventLine);
    if (!read.ok) continue;
    const event = read.value;
    const role = event.from === ADMIN_ID ? "user" : "agent";
    if (role === "user" ? !targetUser : !targetAgent) continue;
    visit(role, event.msg, event.ts);
  }
}

/** Strict-stage field extraction. queue-operation events and user rows that
 * carry a consumed task-notification both route their ccmsg payload through
 * forEachCcmsgMessage — a task-notification landing in a user row is a harness
 * delivery, not something the user typed, so treating its whole body as a
 * user message would misclassify agent-authored ccmsg posts. dequeue/remove
 * queue rows are intentionally ignored (the enqueue row already carries the
 * same payload). */
function forEachSearchableMessage(
  line: string,
  targetUser: boolean,
  targetAgent: boolean,
  visit: (role: "user" | "agent", text: string, timestamp: string | undefined) => void,
): void {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok) return;
  const row = read.value;
  if (!isKnownTranscriptRow(row)) return;

  if (row.type === "user") {
    const text = userText(row);
    if (text === undefined) return;
    if (text.startsWith("<task-notification>")) {
      forEachCcmsgMessage(text, targetUser, targetAgent, visit);
    } else if (targetUser) {
      visit("user", text, row.timestamp);
    }
    return;
  }
  if (row.type === "assistant") {
    if (!targetAgent) return;
    const texts = row.message.content.flatMap((block) =>
      isKnownContentBlock(block) && block.type === "text" ? [block.text] : [],
    );
    if (texts.length > 0) visit("agent", texts.join("\n"), row.timestamp);
    return;
  }
  if (row.type === "queue-operation" && row.operation === "enqueue") {
    if (row.content !== undefined) {
      forEachCcmsgMessage(row.content, targetUser, targetAgent, visit);
    }
  }
}

function strictMatchCompiled(
  line: string,
  params: CompiledStrictMatchParams,
): SessionSearchMatch | undefined {
  let result: SessionSearchMatch | undefined;
  forEachSearchableMessage(line, params.targetUser, params.targetAgent, (role, text, timestamp) => {
    if (
      result !== undefined ||
      !params.clauses.some((clause) => clause.every((pattern) => patternIndex(text, pattern) >= 0))
    ) {
      return;
    }
    result = {
      role,
      text: snippet(text, params.clauses.flat()),
      ...(timestamp ? { timestamp } : {}),
    };
  });
  return result;
}

export function strictMatch(
  line: string,
  params: StrictMatchParams,
): SessionSearchMatch | undefined {
  const caseSensitive = params.caseSensitive ?? false;
  const regex = params.regex ?? false;
  const parsed = parseSearchQueryPatterns(params.queryWords.join("\n"), {
    caseSensitive,
    regex,
  });
  const compiled = compileQueryClauses(parsed.clauses, caseSensitive, regex);
  if (!compiled.ok) return undefined;
  return strictMatchCompiled(line, {
    clauses: compiled.clauses,
    targetUser: params.targetUser,
    targetAgent: params.targetAgent,
  });
}

function parseMtimeWithin(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const match = /^(\d+)([mhd])$/.exec(raw);
  if (!match) return undefined;
  const count = Number(match[1]);
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const duration = count * unit;
  return Number.isSafeInteger(duration) ? duration : undefined;
}

function validateRequest(req: SessionSearchRequest):
  | {
      ok: true;
      clauses: CompiledQueryPattern[][];
      cwdWords: string[];
      targetUser: boolean;
      targetAgent: boolean;
      caseSensitive: boolean;
      mtimeMs: number;
      untilMs: number;
    }
  | { ok: false; msg: string } {
  if (req.query !== undefined && typeof req.query !== "string") {
    return { ok: false, msg: "session_search query must be a string" };
  }
  if (req.cwd !== undefined && typeof req.cwd !== "string") {
    return { ok: false, msg: "session_search cwd must be a string" };
  }
  if (req.sid !== undefined && typeof req.sid !== "string") {
    return { ok: false, msg: "session_search sid must be a string" };
  }
  if (req.case_sensitive !== undefined && typeof req.case_sensitive !== "boolean") {
    return { ok: false, msg: "session_search case_sensitive must be a boolean" };
  }
  if (req.regex !== undefined && typeof req.regex !== "boolean") {
    return { ok: false, msg: "session_search regex must be a boolean" };
  }
  if (req.target_user !== undefined && typeof req.target_user !== "boolean") {
    return { ok: false, msg: "session_search target_user must be a boolean" };
  }
  if (req.target_agent !== undefined && typeof req.target_agent !== "boolean") {
    return { ok: false, msg: "session_search target_agent must be a boolean" };
  }
  if (
    req.config_dirs !== undefined &&
    (!Array.isArray(req.config_dirs) || req.config_dirs.some((dir) => typeof dir !== "string"))
  ) {
    return { ok: false, msg: "session_search config_dirs must be a string array" };
  }
  const mtimeMs = parseMtimeWithin(req.mtime_within ?? "5d");
  if (mtimeMs === undefined) {
    return { ok: false, msg: "session_search mtime_within must match <number>[mhd]" };
  }
  const untilMs = parseMtimeWithin(req.mtime_until ?? "0d");
  if (untilMs === undefined) {
    return { ok: false, msg: "session_search mtime_until must match <number>[mhd]" };
  }
  if (untilMs >= mtimeMs) {
    return {
      ok: false,
      msg: `session_search mtime_until (${req.mtime_until ?? "0d"}) is not newer than mtime_within (${req.mtime_within ?? "5d"}): no transcript can be in between`,
    };
  }
  const caseSensitive = req.case_sensitive ?? false;
  const regex = req.regex ?? false;
  const parsed = parseSearchQueryPatterns(req.query ?? "", { caseSensitive, regex });
  const compiled = compileQueryClauses(parsed.clauses, caseSensitive, regex);
  if (!compiled.ok) return compiled;
  return {
    ok: true,
    clauses: compiled.clauses,
    cwdWords: words(req.cwd).map((word) => word.toLowerCase()),
    targetUser: req.target_user ?? true,
    targetAgent: req.target_agent ?? true,
    caseSensitive,
    mtimeMs,
    untilMs,
  };
}

/** How long `req` may read (`timeout_ms` clamped, its default when absent).
 * The daemon clamps whatever a client asks. */
export function sessionSearchTimeoutMs(req: SessionSearchRequest): number {
  return clampSessionSearchTimeout(req.timeout_ms ?? SESSION_SEARCH_TIMEOUT_DEFAULT_MS);
}

/** What ends a search before it read its whole window. */
export interface SessionSearchSignals {
  /** Its time is up (default: `sessionSearchTimeoutMs` from now). Read before
   * each transcript: one being read is read to its end. */
  timeout?: SearchSignal;
  /** It was stopped (SessionSearchRuns). Read after each read and each turn
   * the scan hands the event loop, and it ends there. */
  stop?: SearchSignal;
}

/** A matched session before its launch context is read: the hit's time
 * (`latest_match_at`) in ms, to order and bound the answer by. */
interface PendingHit {
  hit: Omit<SessionSearchHit, "model" | "effort">;
  latestMatchMs: number;
}

/** Search the transcripts the request's metadata (config dirs, cwd, sid, the
 * mtime window) selects, newest update first, until every one is read, the
 * timeout runs out, or SESSION_SEARCH_RESULT_MAX sessions matched and no
 * transcript left can hold a newer match (DR-0021 §2.2). Nothing bounds how
 * much is read otherwise. The answer is the matched sessions with the newest
 * match first, at most SESSION_SEARCH_RESULT_MAX of them. */
export async function sessionSearch(
  req: SessionSearchRequest,
  log: SessionSearchLog,
  /** The `.claude*` dirs of the daemon's HOME (detectConfigDirs). */
  configDirs: readonly string[],
  signals: SessionSearchSignals = {},
): Promise<SessionSearchResult> {
  const timeout = signals.timeout ?? AbortSignal.timeout(sessionSearchTimeoutMs(req));
  const stop = signals.stop ?? NEVER;
  // Yield before any filesystem work so server.ts can install its FIFO reply
  // gate. The scan below keeps yielding per time slice, so a long search no longer
  // blocks other clients' deliveries (DR-0029).
  await yieldToEventLoop();
  const validated = validateRequest(req);
  if (!validated.ok) {
    return { ok: false, code: ErrorCode.invalid_args, msg: validated.msg };
  }
  const now = Date.now();
  const candidates = await listCandidateFiles({
    configDirs,
    selectedConfigDirs: req.config_dirs,
    sid: req.sid,
    cwdWords: validated.cwdWords,
    modifiedAfterMs: now - validated.mtimeMs,
    ...(validated.untilMs > 0 ? { modifiedBeforeMs: now - validated.untilMs } : {}),
  });

  // The matched sessions with the newest match first, never more than
  // SESSION_SEARCH_RESULT_MAX: one that falls off the end is `cut`.
  const pending: PendingHit[] = [];
  let cut = false;
  let searched = 0;
  let endedBy: SessionSearchResponse["ended_by"] = "all";

  for (const candidate of candidates) {
    if (stop.aborted) return stoppedResult();
    // A transcript's messages are no newer than its last write, and the rest
    // are older still: once the answer is full, the first that cannot beat its
    // last entry ends the search.
    const last = pending[SESSION_SEARCH_RESULT_MAX - 1];
    if (last !== undefined && candidate.stat.mtimeMs <= last.latestMatchMs) {
      endedBy = "hit_limit";
      break;
    }
    if (timeout.aborted) {
      endedBy = "timeout";
      break;
    }
    let scan: ScanResult | null;
    try {
      scan = await scanCandidateFile(
        candidate.file,
        validated.clauses,
        validated.targetUser,
        validated.targetAgent,
        validated.caseSensitive,
        stop,
      );
    } catch (error) {
      log.error(`session_search: failed reading ${candidate.file}: ${String(error)}`);
      searched += 1;
      continue;
    }
    if (scan === null) return stoppedResult();
    searched += 1;
    if (validated.cwdWords.length > 0) {
      if (scan.cwd === null || !lowerIncludesAll(scan.cwd, validated.cwdWords)) {
        continue;
      }
    }
    if (!scan.queryMatched) {
      continue;
    }

    // An empty query matches every message, and the newest is the
    // transcript's last write; a match carrying no time falls back the same.
    const latestMatchMs = scan.latestMatchMs ?? candidate.stat.mtimeMs;
    const location = scan.cwd ? deriveRepoLocation(scan.cwd) : null;
    const at = pending.findIndex((held) => held.latestMatchMs < latestMatchMs);
    pending.splice(at < 0 ? pending.length : at, 0, {
      latestMatchMs,
      hit: {
        sid: candidate.sid,
        config_dir: candidate.configDir,
        file: candidate.file,
        cwd: scan.cwd,
        repo: location?.repo ?? null,
        ws: location?.ws ?? null,
        latest_match_at: new Date(latestMatchMs).toISOString(),
        updated_at: candidate.stat.mtime.toISOString(),
        size: candidate.stat.size,
        matches: scan.matches,
        title: scan.title,
      },
    });
    if (pending.length > SESSION_SEARCH_RESULT_MAX) {
      pending.pop();
      cut = true;
    }
  }
  if (cut) endedBy = "hit_limit";

  const hits: SessionSearchHit[] = [];
  for (const { hit } of pending) {
    // Only a session the answer holds is probed: the tail read answers "what
    // would resuming this session run as", which nothing needs for a session
    // the response drops.
    let context: SessionLaunchContext;
    try {
      context = await readSessionLaunchContext(hit.file);
    } catch (error) {
      log.error(`session_search: failed reading ${hit.file} tail: ${String(error)}`);
      context = {};
    }
    hits.push({ ...hit, ...context });
  }

  const oldest = searched > 0 ? candidates[searched - 1] : undefined;
  return {
    ok: true,
    data: {
      ok: true,
      hits,
      files_total: candidates.length,
      files_searched: searched,
      oldest_searched_mtime: oldest ? oldest.stat.mtime.toISOString() : null,
      ended_by: endedBy,
    },
  };
}

function stoppedResult(): SessionSearchResult {
  return {
    ok: false,
    code: ErrorCode.search_superseded,
    msg: "session_search stopped: a later session_search on the same connection replaced it",
  };
}
