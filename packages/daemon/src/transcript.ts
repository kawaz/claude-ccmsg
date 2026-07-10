// Session transcript access (DR-0009): byte-offset paginated reads of a
// connected session's single announced Claude Code transcript jsonl. Unlike
// fs-access.ts there is no client-supplied path — the daemon only ever serves
// the one file a session announced (and this module validated) at hello time,
// so no traversal surface exists at all.
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TRANSCRIPT_READ_MAX_BYTES, type TranscriptReadResponse } from "@ccmsg/protocol";

/** Minimal shape transcript-read needs from `Daemon.sessions` — kept structural
 *  (same rationale as fs-access.ts's SessionLookup) so this module has no
 *  dependency edge back to server.ts. */
export interface SessionLookup {
  get(sid: string): { meta: { transcript_path?: string }; conns: { size: number } } | undefined;
}

export type TranscriptResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; msg: string };

/**
 * Backward-scan budget (DR-0009 addendum) for locating the start of a "soft
 * cap" line — one whose own body exceeds a single window's cap
 * (TRANSCRIPT_READ_MAX_BYTES). Local to this module, not a protocol constant:
 * it's purely an internal knob for how far transcriptRead is willing to look
 * before giving up on retrieving a monster line's content (see
 * `readSoftCapLine`). Additional to (not counting) the original cap-sized
 * window already read.
 */
const TRANSCRIPT_LINE_SCAN_MAX = 4 * 1024 * 1024;

/**
 * Hello-time validation (DR-0009): a session's self-declared transcript_path is
 * adopted only if it is an absolute path, ends in ".jsonl", and its basename is
 * exactly "<sid>.jsonl". Any violation returns undefined (silent no-op) — the
 * hello itself still succeeds, the session just gets no Timeline view. This is
 * the entire trust boundary: a client can never name an arbitrary file, only
 * the one whose name is pinned to its own sid.
 */
export function validateTranscriptPath(sid: string, transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return undefined;
  if (!path.isAbsolute(transcriptPath)) return undefined;
  if (path.extname(transcriptPath) !== ".jsonl") return undefined;
  if (path.basename(transcriptPath) !== `${sid}.jsonl`) return undefined;
  return transcriptPath;
}

function resolveTranscript(
  sessions: SessionLookup,
  sid: string,
): { ok: true; file: string } | { ok: false; code: ErrorCode; msg: string } {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) {
    return { ok: false, code: ErrorCode.session_not_found, msg: `session not connected: ${sid}` };
  }
  const file = entry.meta.transcript_path;
  if (!file) {
    return { ok: false, code: ErrorCode.not_found, msg: `session has no transcript: ${sid}` };
  }
  return { ok: true, file };
}

function readWindow(fd: number, rawStart: number, rawEnd: number): Buffer {
  const toRead = rawEnd - rawStart;
  if (toRead <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(toRead);
  let readTotal = 0;
  while (readTotal < toRead) {
    const n = fs.readSync(fd, buf, readTotal, toRead - readTotal, rawStart + readTotal);
    if (n === 0) break; // file shrank concurrently; stop rather than loop forever
    readTotal += n;
  }
  return buf.subarray(0, readTotal);
}

/**
 * Handles the "soft cap" case: `targetEnd` is *verified* (by the caller,
 * before calling this) to be the genuine end of a line whose own body is
 * larger than a single cap-sized window — the leading-trim's only newline in
 * [rawStart, targetEnd) sits on the window's very last byte, so a plain
 * subarray-past-it would yield an empty page anchored at `targetEnd` itself,
 * making the next `before` identical to this one (STUCK, DR-0009 addendum).
 *
 * Recovers by scanning further back in `cap`-sized chunks — bounded by
 * TRANSCRIPT_LINE_SCAN_MAX total additional bytes — for the newline that
 * starts this line. Two outcomes:
 *  - found (incl. hitting byte 0, which trivially starts the file's first
 *    line): return the *entire* line as a single soft-cap line, uncapped by
 *    max_bytes — this one line is the sole exception to the byte cap.
 *  - not found within budget (a truly monstrous line): give up on this
 *    line's content (`lines: []`) rather than buffering it without bound,
 *    but still guarantee progress — `start` becomes wherever the scan
 *    stopped, which is always strictly less than `targetEnd` (the scan
 *    always consumes at least one `cap`-sized chunk before giving up).
 */
function readSoftCapLine(
  fd: number,
  rawStart: number,
  targetEnd: number,
  cap: number,
  sid: string,
  size: number,
): TranscriptResult<Omit<TranscriptReadResponse, "ok">> {
  let scanLimit = rawStart;
  let scanned = 0;
  let lineStart: number | undefined;

  while (lineStart === undefined) {
    if (scanLimit === 0) {
      lineStart = 0; // reached byte 0: this line is the file's first line
      break;
    }
    if (scanned >= TRANSCRIPT_LINE_SCAN_MAX) break; // give up: exceeded scan budget
    const chunkSize = Math.min(cap, scanLimit, TRANSCRIPT_LINE_SCAN_MAX - scanned);
    const chunkStart = scanLimit - chunkSize;
    const chunk = readWindow(fd, chunkStart, scanLimit);
    const idx = chunk.lastIndexOf(0x0a);
    if (idx !== -1) {
      lineStart = chunkStart + idx + 1;
      break;
    }
    scanned += chunkSize;
    scanLimit = chunkStart;
  }

  if (lineStart === undefined) {
    return { ok: true, data: { sid, lines: [], start: scanLimit, end: scanLimit, size } };
  }

  const lineBuf = readWindow(fd, lineStart, targetEnd);
  const text = lineBuf.toString("utf-8");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { ok: true, data: { sid, lines: [line], start: lineStart, end: targetEnd, size } };
}

/**
 * `before`/`max_bytes` paginated read of `sid`'s announced transcript.
 *
 * Byte-offset windowing with line-boundary alignment, so a multi-hundred-MB
 * transcript never needs a full scan or a line index:
 *  - target end = `before` (clamped to the current file size) or file size
 *    when `before` is absent (tail read).
 *  - raw window = [max(0, end - cap), end), cap = max_bytes clamped to
 *    TRANSCRIPT_READ_MAX_BYTES.
 *  - leading trim: unless the window starts at true byte 0, its first bytes
 *    may be the tail of a line that began earlier — drop up to and including
 *    the first newline.
 *  - trailing trim: the window's tail can be an unterminated partial line
 *    only at the live tail (end === size) while the writer is mid-append —
 *    drop back to the last newline.
 *  - both trims only ever cut at a literal 0x0A byte, which in valid UTF-8
 *    never occurs as part of a multi-byte sequence (continuation/lead bytes
 *    are all >= 0x80) — so this is always safe against multi-byte content
 *    straddling a chunk boundary.
 *
 * If a window (after trims) contains no complete line at all — the window is
 * smaller than a single line — this returns an empty page anchored so that
 * passing the returned `start` back as the next `before` keeps moving strictly
 * backward (guaranteed progress even in that degenerate case).
 *
 * Soft-cap addendum (DR-0009): the degenerate case above splits in two
 * depending on *why* the window held no complete line. If the window's tail
 * genuinely isn't a line boundary (no 0x0A anywhere), the plain anchor above
 * is correct and cheap. But if the window's *only* 0x0A is its own last byte
 * — i.e. `targetEnd` is verified to be a real line's end, and that line's
 * body alone is >= a full cap — anchoring at `targetEnd` itself would make
 * the next `before` identical to this one (STUCK: an infinite empty-page
 * loop, since `[targetEnd - cap, targetEnd)` re-reads byte-for-byte the same
 * window forever). That case instead scans further back (see
 * `readSoftCapLine`) and returns the whole oversized line as one soft-cap
 * line, uncapped by `max_bytes`.
 */
export function transcriptRead(
  sessions: SessionLookup,
  sid: string,
  before: number | undefined,
  maxBytes: number | undefined,
): TranscriptResult<Omit<TranscriptReadResponse, "ok">> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;

  if (
    before !== undefined &&
    (typeof before !== "number" || !Number.isFinite(before) || before < 0)
  ) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read before must be a non-negative number",
    };
  }
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0)
  ) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read max_bytes must be a positive number",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.file);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }

  const size = stat.size;
  const cap = Math.min(maxBytes ?? TRANSCRIPT_READ_MAX_BYTES, TRANSCRIPT_READ_MAX_BYTES);
  const targetEnd = before === undefined ? size : Math.min(before, size);
  const rawStart = Math.max(0, targetEnd - cap);

  if (targetEnd <= rawStart) {
    // before === 0 (or an otherwise empty window): nothing precedes it.
    return { ok: true, data: { sid, lines: [], start: targetEnd, end: targetEnd, size } };
  }

  const fd = fs.openSync(resolved.file, "r");
  try {
    const raw = readWindow(fd, rawStart, targetEnd);

    let data = raw;
    let start = rawStart;
    if (rawStart > 0) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        // no line boundary anywhere in this window: anchor the empty page at
        // rawStart so `before: start` on the next call scans strictly further back.
        return { ok: true, data: { sid, lines: [], start: rawStart, end: rawStart, size } };
      }
      if (nl === data.length - 1) {
        // The window's only newline is its own last byte: targetEnd is a
        // genuine line end, but that line's body alone fills (or exceeds) the
        // whole cap. See readSoftCapLine / module doc "soft-cap addendum".
        return readSoftCapLine(fd, rawStart, targetEnd, cap, sid, size);
      }
      data = data.subarray(nl + 1);
      start = rawStart + nl + 1;
    }

    let end = targetEnd;
    if (data.length > 0 && data[data.length - 1] !== 0x0a) {
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        return { ok: true, data: { sid, lines: [], start, end: start, size } };
      }
      end = start + lastNl + 1;
      data = data.subarray(0, lastNl + 1);
    }

    // Invariant at this point: data.length === 0, or data's last byte is 0x0a —
    // so split-and-drop-trailing-empty always yields only complete lines.
    const lines = data.length === 0 ? [] : data.toString("utf-8").split("\n").slice(0, -1);

    return { ok: true, data: { sid, lines, start, end, size } };
  } finally {
    fs.closeSync(fd);
  }
}
