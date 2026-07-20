import * as fs from "node:fs";
import * as path from "node:path";
import {
  ADMIN_ID,
  ErrorCode,
  SESSION_SEARCH_MATCH_SUMMARY_MAX,
  SESSION_SEARCH_RESULT_MAX,
  parseSearchQueryPatterns,
  type ErrorCode as ErrorCodeType,
  type SearchQueryPattern,
  type SessionSearchHit,
  type SessionSearchMatch,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ccmsg/protocol";
import { detectConfigDirs } from "./agents.ts";
import { deriveRepoLocation, isValidSid } from "./virtual-sessions.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const REQUEST_SCAN_MAX_BYTES = 256 * 1024 * 1024;
const SNIPPET_CONTEXT_CHARS = 80;

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
}

export type SessionSearchResult =
  | { ok: true; data: SessionSearchResponse }
  | { ok: false; code: ErrorCodeType; msg: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function lowerIncludesAll(text: string, needles: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return needles.every((needle) => lower.includes(needle));
}

interface CompiledQueryPattern {
  matcher: RegExp;
  /** Serialized-line substring that every strict match must contain. null means
   * this pattern cannot safely participate in the JSONL prefilter. */
  prefilter: string | null;
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
    const ch = pattern[i]!;
    if (ch === "\\") {
      const escapeKind = pattern[i + 1];
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
        while (i + 1 < pattern.length && /[0-9]/.test(pattern[i + 1]!)) i += 1;
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
    while (i + 1 < pattern.length && /[A-Za-z0-9]/.test(pattern[i + 1]!)) i += 1;
    let run = pattern.slice(start, i + 1);
    const next = pattern[i + 1];
    if (next === "?" || next === "*" || next === "+" || next === "{") {
      run = run.slice(0, -1);
    }
    if (run.length > 0) runs.push(run);
  }

  return runs.sort((a, b) => b.length - a.length)[0] ?? null;
}

function compileQueryGroups(
  groups: readonly (readonly SearchQueryPattern[])[],
  caseSensitive: boolean,
  regex: boolean,
): { ok: true; groups: CompiledQueryPattern[][] } | { ok: false; msg: string } {
  const compiledGroups: CompiledQueryPattern[][] = [];
  for (const group of groups) {
    const compiled: CompiledQueryPattern[] = [];
    for (const pattern of group) {
      if (pattern.error !== null) {
        return {
          ok: false,
          msg: `session_search query contains an invalid regular expression: ${pattern.error}`,
        };
      }
      const literal = regex
        ? regexRequiredLiteral(pattern.source)
        : JSON.stringify(
            pattern.text.split(/\s+/v).sort((a, b) => b.length - a.length)[0] ?? "",
          ).slice(1, -1);
      compiled.push({
        matcher: new RegExp(pattern.source, pattern.flags),
        prefilter: literal === null ? null : caseSensitive ? literal : literal.toLowerCase(),
      });
    }
    compiledGroups.push(compiled);
  }
  return { ok: true, groups: compiledGroups };
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
export function listCandidateFiles(params: ListCandidateParams): CandidateFile[] {
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
      projectEntries = fs.readdirSync(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      if (!roughCwdMatches(projectEntry.name, params.cwdWords)) continue;
      const projectDir = path.join(projects, projectEntry.name);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sid = entry.name.slice(0, -".jsonl".length);
        if (!isValidSid(sid)) continue;
        if (sidNeedle && !sid.toLowerCase().includes(sidNeedle)) continue;
        const file = path.join(projectDir, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs < params.modifiedAfterMs) continue;
        candidates.push({ sid, configDir, file, projectDirName: projectEntry.name, stat });
      }
    }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
  return candidates;
}

interface ScanResult {
  matches: SessionSearchMatch[];
  matchedGroupCount: number;
  cwd: string | null;
  firstTimestamp: string | null;
  bytesRead: number;
  truncated: boolean;
}

function linePassesPrefilter(
  line: string,
  groups: readonly (readonly CompiledQueryPattern[])[],
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
  // Session-wide AND permits different groups to match different rows, so a
  // row survives when any OR alternative in any group may match it. A pattern
  // without a safe literal admits every row to the strict stage.
  return groups.some((group) =>
    group.some((pattern) => pattern.prefilter === null || haystack.includes(pattern.prefilter)),
  );
}

function scanCandidateFile(
  file: string,
  groups: readonly (readonly CompiledQueryPattern[])[],
  targetUser: boolean,
  targetAgent: boolean,
  caseSensitive: boolean,
  maxBytes: number,
): ScanResult {
  const size = fs.statSync(file).size;
  const limit = Math.min(size, Math.max(0, maxBytes));
  const matches: SessionSearchMatch[] = [];
  const seen = new Set<string>();
  const matchedGroupIndexes = new Set<number>();
  let cwd: string | null = null;
  let firstTimestamp: string | null = null;
  let offset = 0;
  let carry = Buffer.alloc(0);
  const fd = fs.openSync(file, "r");

  const inspect = (line: string): void => {
    if (groups.length > 0 && linePassesPrefilter(line, groups, caseSensitive)) {
      forEachSearchableMessage(line, targetUser, targetAgent, (role, text, timestamp) => {
        const matchingPatterns: CompiledQueryPattern[] = [];
        let newlyMatchedGroup = false;
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
          const matchingPattern = groups[groupIndex]!.find(
            (pattern) => patternIndex(text, pattern) >= 0,
          );
          if (matchingPattern === undefined) continue;
          if (!matchedGroupIndexes.has(groupIndex)) newlyMatchedGroup = true;
          matchedGroupIndexes.add(groupIndex);
          matchingPatterns.push(matchingPattern);
        }
        const allGroupsMatched = matchedGroupIndexes.size === groups.length;
        if (
          matchingPatterns.length === 0 ||
          matches.length >= SESSION_SEARCH_MATCH_SUMMARY_MAX ||
          (!newlyMatchedGroup && !allGroupsMatched)
        ) {
          return;
        }
        const match: SessionSearchMatch = {
          role,
          text: snippet(text, matchingPatterns),
          ...(timestamp ? { timestamp } : {}),
        };
        const key = `${match.role}\0${match.timestamp ?? ""}\0${match.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push(match);
        }
      });
    }
    if (cwd !== null && firstTimestamp !== null) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(row)) return;
    if (cwd === null && typeof row.cwd === "string" && path.isAbsolute(row.cwd)) cwd = row.cwd;
    if (firstTimestamp === null && typeof row.timestamp === "string") {
      const parsed = Date.parse(row.timestamp);
      if (Number.isFinite(parsed)) firstTimestamp = new Date(parsed).toISOString();
    }
  };

  try {
    while (offset < limit) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const read = fs.readSync(fd, chunk, 0, toRead, offset);
      if (read === 0) break;
      offset += read;
      const data =
        carry.length === 0
          ? chunk.subarray(0, read)
          : Buffer.concat([carry, chunk.subarray(0, read)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        inspect(data.toString("utf-8", start, newline));
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
      // Once metadata is known, an empty query needs no more rows. A non-empty
      // query may stop only after every session-wide AND clause has matched and
      // the summary cap is full: after that neither hit eligibility nor the
      // bounded response can change. If either condition is incomplete, keep
      // scanning to avoid dropping a later clause or summary row.
      if (
        cwd !== null &&
        firstTimestamp !== null &&
        (groups.length === 0 ||
          (matchedGroupIndexes.size === groups.length &&
            matches.length >= SESSION_SEARCH_MATCH_SUMMARY_MAX))
      ) {
        break;
      }
    }
    if (carry.length > 0 && offset === size) inspect(carry.toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  return {
    matches,
    matchedGroupCount: matchedGroupIndexes.size,
    cwd,
    firstTimestamp,
    bytesRead: offset,
    truncated: offset >= limit && limit < size,
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
  groups: readonly (readonly CompiledQueryPattern[])[];
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
function userText(row: Record<string, unknown>): string | undefined {
  if (row.isMeta === true) return undefined;
  const message = row.message;
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const texts = message.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => block.text)
    .filter((value): value is string => typeof value === "string");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

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
    let event: unknown;
    try {
      event = JSON.parse(eventLine);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "msg" || typeof event.msg !== "string") continue;
    const role = event.from === ADMIN_ID ? "user" : "agent";
    if (role === "user" ? !targetUser : !targetAgent) continue;
    visit(role, event.msg, typeof event.ts === "string" ? event.ts : undefined);
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
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(row)) return;

  const timestamp = typeof row.timestamp === "string" ? row.timestamp : undefined;
  if (row.type === "user") {
    const text = userText(row);
    if (text === undefined) return;
    if (text.startsWith("<task-notification>")) {
      forEachCcmsgMessage(text, targetUser, targetAgent, visit);
    } else if (targetUser) {
      visit("user", text, timestamp);
    }
    return;
  }
  if (row.type === "assistant") {
    if (!targetAgent) return;
    const message = row.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    const texts = message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => block.text)
      .filter((value): value is string => typeof value === "string");
    if (texts.length > 0) visit("agent", texts.join("\n"), timestamp);
    return;
  }
  if (row.type === "queue-operation" && row.operation === "enqueue") {
    if (typeof row.content === "string") {
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
      !params.groups.every((group) => group.some((pattern) => patternIndex(text, pattern) >= 0))
    ) {
      return;
    }
    result = {
      role,
      text: snippet(text, params.groups.flat()),
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
  const compiled = compileQueryGroups(parsed.groups, caseSensitive, regex);
  if (!compiled.ok) return undefined;
  return strictMatchCompiled(line, {
    groups: compiled.groups,
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
      groups: CompiledQueryPattern[][];
      cwdWords: string[];
      targetUser: boolean;
      targetAgent: boolean;
      caseSensitive: boolean;
      mtimeMs: number;
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
  const caseSensitive = req.case_sensitive ?? false;
  const regex = req.regex ?? false;
  const parsed = parseSearchQueryPatterns(req.query ?? "", { caseSensitive, regex });
  const compiled = compileQueryGroups(parsed.groups, caseSensitive, regex);
  if (!compiled.ok) return compiled;
  return {
    ok: true,
    groups: compiled.groups,
    cwdWords: words(req.cwd).map((word) => word.toLowerCase()),
    targetUser: req.target_user ?? true,
    targetAgent: req.target_agent ?? true,
    caseSensitive,
    mtimeMs,
  };
}

export async function sessionSearch(
  req: SessionSearchRequest,
  log: SessionSearchLog,
  configDirs: readonly string[] = detectConfigDirs(),
): Promise<SessionSearchResult> {
  // Yield once so server.ts can install its FIFO reply gate before the bounded
  // synchronous scan starts. The scan itself stays synchronous to match the
  // daemon's existing filesystem code and avoid interleaved mutable state.
  await Promise.resolve();
  const validated = validateRequest(req);
  if (!validated.ok) {
    return { ok: false, code: ErrorCode.invalid_args, msg: validated.msg };
  }
  const candidates = listCandidateFiles({
    configDirs,
    selectedConfigDirs: req.config_dirs,
    sid: req.sid,
    cwdWords: validated.cwdWords,
    modifiedAfterMs: Date.now() - validated.mtimeMs,
  });

  const hits: SessionSearchHit[] = [];
  let scannedBytes = 0;
  let truncated = false;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]!;
    const remaining = REQUEST_SCAN_MAX_BYTES - scannedBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let scan: ScanResult;
    try {
      scan = scanCandidateFile(
        candidate.file,
        validated.groups,
        validated.targetUser,
        validated.targetAgent,
        validated.caseSensitive,
        remaining,
      );
    } catch (error) {
      log.error(`session_search: failed reading ${candidate.file}: ${String(error)}`);
      continue;
    }
    scannedBytes += scan.bytesRead;
    // A file cut by the remaining request-wide byte budget marks the response
    // incomplete but does not erase hits already found in that prefix.
    if (scan.truncated) truncated = true;
    if (validated.cwdWords.length > 0) {
      if (scan.cwd === null || !lowerIncludesAll(scan.cwd, validated.cwdWords)) {
        continue;
      }
    }

    const matches = scan.matches;
    if (validated.groups.length > 0 && scan.matchedGroupCount < validated.groups.length) {
      continue;
    }

    const location = scan.cwd ? deriveRepoLocation(scan.cwd) : null;
    hits.push({
      sid: candidate.sid,
      config_dir: candidate.configDir,
      file: candidate.file,
      cwd: scan.cwd,
      repo: location?.repo ?? null,
      ws: location?.ws ?? null,
      created_at: scan.firstTimestamp ?? candidate.stat.birthtime.toISOString(),
      updated_at: candidate.stat.mtime.toISOString(),
      size: candidate.stat.size,
      matches,
    });
    if (hits.length >= SESSION_SEARCH_RESULT_MAX) {
      if (candidateIndex + 1 < candidates.length) truncated = true;
      break;
    }
  }

  return { ok: true, data: { ok: true, hits, truncated } };
}
