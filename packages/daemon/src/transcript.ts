// Session transcript access (DR-0009 / DR-0021): byte-offset paginated reads
// of a connected session's hello-validated transcript, or a user-role historical
// sid resolved below detected config dirs. There is no client-supplied path:
// connected reads use the announced file and historical reads require a complete
// UUID basename, so neither path exposes a traversal surface.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  parseWith,
  TRANSCRIPT_READ_MAX_BYTES,
  TRANSCRIPT_READ_OLDER_MAX_BYTES,
  TranscriptRowTimestampLineSchema,
  type TranscriptReadResponse,
} from "@ccmsg/protocol";
import { resolveVirtualTranscript } from "./virtual-sessions.ts";
import { resolveAgentTranscript } from "./agent-transcripts.ts";
import { yieldToEventLoop } from "./event-loop.ts";

/** Minimal shape transcript-read needs from `Daemon.sessions` — kept structural
 *  (same rationale as fs-access.ts's SessionLookup) so this module has no
 *  dependency edge back to server.ts. */
export interface SessionLookup {
  get(sid: string): { meta: { transcript_path?: string } } | undefined;
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
export function validateTranscriptPath(
  sid: string,
  transcriptPath: string | undefined,
): string | undefined {
  if (transcriptPath === undefined || transcriptPath === "") return undefined;
  if (!path.isAbsolute(transcriptPath)) return undefined;
  if (path.extname(transcriptPath) !== ".jsonl") return undefined;
  if (path.basename(transcriptPath) !== `${sid}.jsonl`) return undefined;
  return transcriptPath;
}

/**
 * Hello-time adoption: the announced path when it validates, otherwise the
 * session's own `<configDir>/projects/<project>/<sid>.jsonl` looked up on disk.
 *
 * The lookup is how a session's transcript is found: nothing tells the hooks
 * module the transcript's path (DR-0039 Consequences), so a session's hello
 * announces none unless the CCMSG_TRANSCRIPT_PATH override does.
 *
 * Trust-wise this is narrower than the announced path, not wider: nothing here
 * comes from the client except the sid, the sid must be a complete UUID, and
 * the only file that can be adopted is the one whose basename is `<sid>.jsonl`
 * below a config dir's `projects/` — the same shape
 * {@link validateTranscriptPath} pins the announced path to. Not found (the
 * transcript has not been created yet, or lives outside the scanned dirs)
 * degrades exactly like a rejected announcement: undefined, hello still fine.
 */
export async function adoptTranscriptPath(
  sid: string,
  announced: string | undefined,
  configDirs?: readonly string[],
): Promise<string | undefined> {
  const validated = validateTranscriptPath(sid, announced);
  if (validated) return validated;
  // `undefined` falls through to resolveVirtualTranscript's own default
  // (daemon-detected config dirs); tests pass fixture dirs explicitly.
  const virtual = await resolveVirtualTranscript(sid, configDirs);
  return virtual?.file;
}

export interface TranscriptResolveOptions {
  /** Historical fallback, passed by the user-role read paths (transcript_read,
   * fork_origin, session_dump_file, session_status). A session-role conn never
   * gets it: its own contract is the connected session it announced. */
  allowVirtual?: boolean;
  /** Test seam; production omits this and uses daemon-detected config dirs. */
  configDirs?: readonly string[];
}

export type TranscriptResolveResult =
  | { ok: true; file: string }
  | { ok: false; code: ErrorCode; msg: string };

/** Connected-session resolution: pure in-memory, so callers that must not
 * yield — the tail Watch lifecycle and the session-errors watch sync, both of
 * which run inside fs.watch/poll callbacks — keep their re-entrancy-free
 * shape. Callers that also want the historical fallback use
 * {@link resolveTranscript}, which touches disk and is therefore async. */
export function resolveConnectedTranscript(
  sessions: SessionLookup,
  sid: string,
): TranscriptResolveResult {
  const entry = sessions.get(sid);
  if (!entry) {
    return { ok: false, code: ErrorCode.session_not_found, msg: `unknown session: ${sid}` };
  }
  const file = entry.meta.transcript_path;
  if (!file) {
    return { ok: false, code: ErrorCode.not_found, msg: `session has no transcript: ${sid}` };
  }
  return { ok: true, file };
}

export async function resolveTranscript(
  sessions: SessionLookup,
  sid: string,
  opts: TranscriptResolveOptions = {},
): Promise<TranscriptResolveResult> {
  const connected = resolveConnectedTranscript(sessions, sid);
  if (connected.ok || !opts.allowVirtual) return connected;
  if (connected.code !== ErrorCode.session_not_found) return connected;
  const virtual = await resolveVirtualTranscript(sid, opts.configDirs);
  if (virtual) return { ok: true, file: virtual.file };
  return connected;
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
 * The `after` read: complete lines from `after` on, oldest first, up to `cap`
 * bytes — what a reader whose cache ends at `after` is missing.
 *
 * `after` has to be where a line starts (byte 0, or just past a newline) for
 * the file to continue from it. When it is not — past the file's end (the
 * file was replaced or cut short) or inside a line — the reply holds no lines
 * and is anchored at the file's end, a `start` other than `after`, which is
 * how the reader learns its cache cannot be continued and reads the tail
 * again instead.
 *
 * Trailing trim as in the `before` read: a last line still being written
 * (no newline yet) is left for later, so `end` stays on a line boundary. A
 * window holding no newline at all is either that (it reaches the file's end:
 * an empty page at `after`) or one line longer than the cap, which, as in
 * `readSoftCapLine`, is returned whole when its newline turns up within
 * TRANSCRIPT_LINE_SCAN_MAX more bytes, and otherwise reported as a file that
 * does not continue from `after` (its content is not buffered without bound).
 */
function readForward(
  file: string,
  sid: string,
  after: number,
  cap: number,
  size: number,
): TranscriptResult<Omit<TranscriptReadResponse, "ok">> {
  const discontinued: TranscriptResult<Omit<TranscriptReadResponse, "ok">> = {
    ok: true,
    data: { sid, lines: [], start: size, end: size, size },
  };
  if (after > size) return discontinued;
  const fd = fs.openSync(file, "r");
  try {
    if (after > 0 && readWindow(fd, after - 1, after)[0] !== 0x0a) return discontinued;
    const windowEnd = Math.min(size, after + cap);
    let data = readWindow(fd, after, windowEnd);
    let lastNl = data.lastIndexOf(0x0a);
    if (lastNl === -1 && windowEnd < size) {
      let scanned = 0;
      let scanFrom = windowEnd;
      while (lastNl === -1 && scanned < TRANSCRIPT_LINE_SCAN_MAX && scanFrom < size) {
        const chunk = readWindow(fd, scanFrom, Math.min(size, scanFrom + cap));
        const idx = chunk.indexOf(0x0a);
        if (idx !== -1) lastNl = scanFrom - after + idx;
        scanned += chunk.length;
        scanFrom += chunk.length;
        if (chunk.length === 0) break;
      }
      if (lastNl === -1) return discontinued;
      data = readWindow(fd, after, after + lastNl + 1);
    }
    if (lastNl === -1)
      return { ok: true, data: { sid, lines: [], start: after, end: after, size } };
    const lines = data.subarray(0, lastNl).toString("utf-8").split("\n");
    return { ok: true, data: { sid, lines, start: after, end: after + lastNl + 1, size } };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `before`/`max_bytes` paginated read of `sid`'s announced transcript.
 *
 * Byte-offset windowing with line-boundary alignment, so a multi-hundred-MB
 * transcript never needs a full scan or a line index:
 *  - target end = `before` (clamped to the current file size) or file size
 *    when `before` is absent (tail read).
 *  - raw window = [max(0, end - cap), end), cap = max_bytes clamped to
 *    TRANSCRIPT_READ_OLDER_MAX_BYTES when `before` is given (paging older)
 *    and to TRANSCRIPT_READ_MAX_BYTES otherwise (the tail, and `after`).
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
export interface TranscriptReadAgentOptions {
  /** DR-0025 Phase 1: subagent / workflow-agent id (`a<...>`). See
   * agent-transcripts.ts `AGENT_ID_RE` for the accepted shape. Mutually
   * exclusive with `teammate`. */
  agentId?: string;
  /** DR-0025 Phase 1: workflow run id (`wf_XXXXXXXX-XXX`) that owns the
   * `agentId`. Absent = direct subagent under `<sid>/subagents/`. */
  runId?: string;
  /** DR-0025 Phase 1: teammate name (resolved via `agent-*.meta.json`
   * scan). Mutually exclusive with `agentId`. */
  teammate?: string;
}

/** Which slice of the transcript to read: lines ending at or before `before`
 * (absent: the file's end), or lines starting at or after `after`. At most
 * `maxBytes` of them, clamped to TRANSCRIPT_READ_OLDER_MAX_BYTES with `before`
 * and to TRANSCRIPT_READ_MAX_BYTES otherwise. */
export interface TranscriptReadRange {
  before?: number;
  after?: number;
  maxBytes?: number;
}

export async function transcriptRead(
  sessions: SessionLookup,
  sid: string,
  range: TranscriptReadRange,
  opts: TranscriptResolveOptions & TranscriptReadAgentOptions = {},
): Promise<TranscriptResult<Omit<TranscriptReadResponse, "ok">>> {
  const { before, after, maxBytes } = range;
  const resolved = await resolveTranscript(sessions, sid, opts);
  if (!resolved.ok) return resolved;
  // DR-0025 Phase 1: if the caller asked for an agent/teammate transcript,
  // swap the session's own file for the resolved sibling before the byte-
  // paging read. The regex-validated ids never enter path.join without
  // clearing AGENT_ID_RE / RUN_ID_RE / TEAMMATE_NAME_RE first.
  const wantsAgent =
    opts.agentId !== undefined || opts.runId !== undefined || opts.teammate !== undefined;
  let readFile = resolved.file;
  if (wantsAgent) {
    const agent = await resolveAgentTranscript(resolved.file, {
      agentId: opts.agentId,
      runId: opts.runId,
      teammate: opts.teammate,
    });
    if (!agent.ok) return agent;
    readFile = agent.file;
  }

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
  if (after !== undefined && (!Number.isFinite(after) || after < 0)) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read after must be a non-negative number",
    };
  }
  if (after !== undefined && before !== undefined) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read takes before or after, not both",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(readFile);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }

  const size = stat.size;
  const limit = before === undefined ? TRANSCRIPT_READ_MAX_BYTES : TRANSCRIPT_READ_OLDER_MAX_BYTES;
  const cap = Math.min(maxBytes ?? limit, limit);
  if (after !== undefined) return readForward(readFile, sid, after, cap, size);
  const targetEnd = before === undefined ? size : Math.min(before, size);
  const rawStart = Math.max(0, targetEnd - cap);

  if (targetEnd <= rawStart) {
    // before === 0 (or an otherwise empty window): nothing precedes it.
    return { ok: true, data: { sid, lines: [], start: targetEnd, end: targetEnd, size } };
  }

  const fd = fs.openSync(readFile, "r");
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

// ---------------------------------------------------------------------------
// Reading a live session's lines on (transcript-relay.ts, DR-0045 §2 / §3):
// the pieces of the file read the relay shares with the one-shot reads.
// ---------------------------------------------------------------------------

export interface TranscriptLog {
  info(msg: string): void;
  error(msg: string): void;
}

/** Minimal shape this module needs from a wire connection — kept structural
 *  (same rationale as SessionLookup above) so this module has no dependency
 *  edge back to server.ts. Transport-level Conn.write() implementations
 *  (UDS/WS) already guard against a closing socket, so no try/catch here. */
export interface TranscriptConn {
  write(line: string): void;
}

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Scan complete lines from the start of a transcript up to `endOffset`
 * (the file's size when omitted) without loading the file whole: the relay's
 * catch-up read and session_status's one-shot read.
 *
 * A scan walks the whole transcript, so it hands the event loop a turn per
 * chunk (DR-0029): one session's catch-up must not stall every other
 * client's WS delivery. */
export async function scanTranscriptLines(
  file: string,
  endOffset: number | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  const limit = endOffset ?? (await fs.promises.stat(file)).size;
  const handle = await fs.promises.open(file, "r");
  let offset = 0;
  let carry = Buffer.alloc(0);
  try {
    while (offset < limit) {
      // Splitting and folding a chunk is pure CPU, so the loop has to re-enter
      // the loop itself rather than relying on the read's IO wait.
      await yieldToEventLoop();
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead: n } = await handle.read(chunk, 0, toRead, offset);
      if (n === 0) break;
      offset += n;
      const data =
        carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        onLine(data.toString("utf-8", start, newline));
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
  } finally {
    await handle.close();
  }
}

/** The timestamp of the last of `lines` that carries one, for the trace. */
export function extractEntryTimestamp(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    // A row that does not read is still delivered; it simply has no entry timestamp.
    const row = parseWith(TranscriptRowTimestampLineSchema, lines[i]);
    if (row.ok && row.value.timestamp !== undefined) return row.value.timestamp;
  }
  return undefined;
}

/**
 * Read `[from, to)` of `file` and trim to the last complete line boundary —
 * mirrors transcriptRead's trailing-trim rule but for a forward-growing
 * incremental read instead of a backward-paginated one: any trailing partial
 * line (the writer mid-append) is dropped and left for the next check
 * (`end` stays at `from` in that case, signaling "nothing complete yet").
 */
export function readCompleteLines(
  file: string,
  from: number,
  to: number,
): { lines: string[]; end: number } {
  const fd = fs.openSync(file, "r");
  try {
    const raw = readWindow(fd, from, to);
    if (raw.length === 0) return { lines: [], end: from };
    let data = raw;
    let end = to;
    if (data[data.length - 1] !== 0x0a) {
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) return { lines: [], end: from }; // no complete line yet; defer entirely
      end = from + lastNl + 1;
      data = data.subarray(0, lastNl + 1);
    }
    const lines = data.length === 0 ? [] : data.toString("utf-8").split("\n").slice(0, -1);
    return { lines, end };
  } finally {
    fs.closeSync(fd);
  }
}
