import * as fs from "node:fs";
import * as path from "node:path";
import {
  ADMIN_ID,
  ErrorCode,
  SESSION_SEARCH_MATCH_SUMMARY_MAX,
  SESSION_SEARCH_RESULT_MAX,
  type ErrorCode as ErrorCodeType,
  type SessionSearchHit,
  type SessionSearchMatch,
  type SessionSearchRequest,
  type SessionSearchResponse,
} from "@ccmsg/protocol";
import { detectConfigDirs } from "./agents.ts";
import { deriveRepoLocation, isValidSid } from "./virtual-sessions.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const PREFILTER_LINE_MAX = 200;
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
  lines: string[];
  cwd: string | null;
  firstTimestamp: string | null;
  bytesRead: number;
  truncated: boolean;
}

function prefilterNeedles(queryWords: readonly string[]): string[] {
  // JSON strings escape quotes/backslashes. Searching the serialized spelling
  // avoids false negatives in the grep stage; strictMatch still decides against
  // the decoded target text and removes structural-field false positives.
  return queryWords.map((word) => JSON.stringify(word).slice(1, -1).toLowerCase());
}

function scanCandidateFile(
  file: string,
  queryWords: readonly string[],
  maxBytes: number,
): ScanResult {
  const size = fs.statSync(file).size;
  const limit = Math.min(size, Math.max(0, maxBytes));
  const needles = prefilterNeedles(queryWords);
  const lines: string[] = [];
  let cwd: string | null = null;
  let firstTimestamp: string | null = null;
  let offset = 0;
  let carry = Buffer.alloc(0);
  let candidateOverflow = false;
  const fd = fs.openSync(file, "r");

  const inspect = (line: string): void => {
    if (needles.length > 0) {
      const lower = line.toLowerCase();
      if (needles.every((needle) => lower.includes(needle))) {
        if (lines.length < PREFILTER_LINE_MAX) lines.push(line);
        else candidateOverflow = true;
      }
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
      if (lines.length >= PREFILTER_LINE_MAX && cwd !== null && firstTimestamp !== null) {
        break;
      }
      if (queryWords.length === 0 && cwd !== null && firstTimestamp !== null) break;
    }
    if (carry.length > 0 && offset === size) inspect(carry.toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  return {
    lines,
    cwd,
    firstTimestamp,
    bytesRead: offset,
    truncated:
      (offset >= limit && limit < size) ||
      candidateOverflow ||
      (lines.length >= PREFILTER_LINE_MAX && offset < size),
  };
}

/** Grep-stage helper: case-insensitive, all words must occur on one JSONL line. */
export function prefilterLines(file: string, queryWords: readonly string[]): string[] {
  return scanCandidateFile(
    file,
    queryWords.map((word) => word.toLowerCase()),
    REQUEST_SCAN_MAX_BYTES,
  ).lines;
}

export interface StrictMatchParams {
  queryWords: readonly string[];
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

function snippet(text: string, queryWords: readonly string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  let index = -1;
  for (const word of queryWords) {
    const found = lower.indexOf(word);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return compact.slice(0, SNIPPET_CONTEXT_CHARS * 2);
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(compact.length, index + SNIPPET_CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
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

/** Match ccmsg deliveries inside a task-notification body. The observed
 * <event> body is a small JSONL batch (kind/title/member/msg stream lines plus
 * non-JSON reply-hint trailer text), not always a single JSON object — parse
 * per line and return the first `type:"msg"` event that passes the role toggle
 * (`from:"u1"` normalizes to user, every other member id to agent) and the
 * query. */
function ccmsgEventMatch(
  content: string,
  params: StrictMatchParams,
): SessionSearchMatch | undefined {
  const eventBody = tagBody(content, "event");
  if (!eventBody) return undefined;
  for (const eventLine of eventBody.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(eventLine);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "msg" || typeof event.msg !== "string") continue;
    const role = event.from === ADMIN_ID ? "user" : "agent";
    if (role === "user" ? !params.targetUser : !params.targetAgent) continue;
    if (!lowerIncludesAll(event.msg, params.queryWords)) continue;
    return {
      role,
      text: snippet(event.msg, params.queryWords),
      ...(typeof event.ts === "string" ? { timestamp: event.ts } : {}),
    };
  }
  return undefined;
}

/** Strict-stage field extraction. queue-operation events and user rows that
 * carry a consumed task-notification both route their ccmsg payload through
 * ccmsgEventMatch — a task-notification landing in a user row is a harness
 * delivery, not something the user typed, so treating its whole body as a
 * user message would misclassify agent-authored ccmsg posts. dequeue/remove
 * queue rows are intentionally ignored (the enqueue row already carries the
 * same payload). */
export function strictMatch(
  line: string,
  params: StrictMatchParams,
): SessionSearchMatch | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(row)) return undefined;

  let role: "user" | "agent";
  let text: string;
  let timestamp = typeof row.timestamp === "string" ? row.timestamp : undefined;

  if (row.type === "user") {
    const extracted = userText(row);
    if (extracted === undefined) return undefined;
    if (extracted.startsWith("<task-notification>")) {
      return ccmsgEventMatch(extracted, params);
    }
    role = "user";
    text = extracted;
  } else if (row.type === "assistant") {
    const message = row.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
    const texts = message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => block.text)
      .filter((value): value is string => typeof value === "string");
    if (texts.length === 0) return undefined;
    role = "agent";
    text = texts.join("\n");
  } else if (row.type === "queue-operation") {
    if (row.operation !== "enqueue" || typeof row.content !== "string") return undefined;
    return ccmsgEventMatch(row.content, params);
  } else {
    return undefined;
  }

  if (role === "user" ? !params.targetUser : !params.targetAgent) return undefined;
  if (!lowerIncludesAll(text, params.queryWords)) return undefined;
  return {
    role,
    text: snippet(text, params.queryWords),
    ...(timestamp ? { timestamp } : {}),
  };
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
      queryWords: string[];
      cwdWords: string[];
      targetUser: boolean;
      targetAgent: boolean;
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
  return {
    ok: true,
    queryWords: words(req.query).map((word) => word.toLowerCase()),
    cwdWords: words(req.cwd).map((word) => word.toLowerCase()),
    targetUser: req.target_user ?? true,
    targetAgent: req.target_agent ?? true,
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
      scan = scanCandidateFile(candidate.file, validated.queryWords, remaining);
    } catch (error) {
      log.error(`session_search: failed reading ${candidate.file}: ${String(error)}`);
      continue;
    }
    scannedBytes += scan.bytesRead;
    // Per-file truncation (a noisy transcript overflowing the per-file grep
    // candidate cap, or a file cut by the remaining budget) marks the response
    // incomplete but must NOT abort the remaining candidates — one noisy file
    // would otherwise hide every older session. Only the global scan budget
    // (checked at the top of the loop) and the result cap stop the walk.
    if (scan.truncated) truncated = true;
    if (validated.cwdWords.length > 0) {
      if (scan.cwd === null || !lowerIncludesAll(scan.cwd, validated.cwdWords)) {
        continue;
      }
    }

    const matches: SessionSearchMatch[] = [];
    // The same ccmsg delivery appears twice in a transcript (the
    // queue-operation enqueue row, then the consumed task-notification user
    // row), so identical summaries are collapsed to keep the small summary
    // budget for distinct messages.
    const seen = new Set<string>();
    if (validated.queryWords.length > 0) {
      for (const line of scan.lines) {
        const match = strictMatch(line, {
          queryWords: validated.queryWords,
          targetUser: validated.targetUser,
          targetAgent: validated.targetAgent,
        });
        if (!match) continue;
        const key = `${match.role} ${match.timestamp ?? ""} ${match.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(match);
        if (matches.length >= SESSION_SEARCH_MATCH_SUMMARY_MAX) break;
      }
      if (matches.length === 0) {
        continue;
      }
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
