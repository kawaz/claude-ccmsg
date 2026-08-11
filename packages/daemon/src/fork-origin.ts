// Where a forked transcript stops being a copy of its ancestor.
//
// `claude --fork-session` writes a self-contained file: the ancestor's records
// are duplicated with their `uuid` and `timestamp` intact and only `sessionId`
// rewritten to the new sid (docs/findings/2026-08-11-checkpoint-rewind.md §5).
// That rewrite is total — the copied rows carry the NEW sid too — so no field
// inside the file distinguishes a copied row from an original one, and the seam
// can only be found by comparing against the sibling transcripts in the same
// project directory.
//
// Measured against the 21 transcripts of this repo's own project directory: the
// rule below finds all three forks with their exact seams and reports nothing
// for the 16 ordinary sessions. Candidates rejected there, so they are not
// retried here: the `last-prompt`/`leafUuid` header (present in ordinary
// sessions, and its uuid points into the init block, not the seam), a row's
// `sessionId` (rewritten on copies), the hook-written `session_id` (lags the
// seam by 14 rows and only exists when hooks ran), and "timestamps older than
// the file's birthtime" (false positives on ordinary sessions, and it puts the
// seam at row 8 of a fork whose real seam is row 32).
import * as fs from "node:fs";
import * as path from "node:path";
import { yieldToEventLoop } from "./event-loop.ts";
import type { ForkOrigin } from "@ccmsg/protocol";
import { isValidSid } from "./virtual-sessions.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** Per-file ceiling on the uuid sweep. A transcript past this size stops being
 * scanned and simply yields no seam, rather than reading hundreds of MB to
 * decorate one divider. */
const SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** Head budget for "what is this file's first uuid". The first record carrying
 * one sits within the init block in every transcript observed; a file whose
 * head holds no uuid inside this budget is treated as having none. */
const HEAD_SCAN_MAX_BYTES = 256 * 1024;

export interface ForkOriginLog {
  error(msg: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowUuid(line: string): string | undefined {
  // Cheap reject first: most of the bytes in a transcript are inside a handful
  // of huge tool-result rows, and parsing those to learn they have no uuid is
  // the dominant cost of the sweep.
  if (!line.includes('"uuid"')) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(row)) return undefined;
  return typeof row.uuid === "string" && row.uuid !== "" ? row.uuid : undefined;
}

/** Streams `file`, handing each row's uuid to `onUuid`. Stops early when
 * `onUuid` returns false. Resolves false when the byte ceiling was hit before
 * the end (the sweep is then incomplete, not merely empty). */
async function scanUuids(
  file: string,
  onUuid: (uuid: string) => boolean,
  maxBytes: number,
): Promise<boolean> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return false;
  }
  const limit = Math.min(size, maxBytes);
  const handle = await fs.promises.open(file, "r");
  let offset = 0;
  let carry = Buffer.alloc(0);
  try {
    while (offset < limit) {
      // Parsing a chunk is pure CPU, so the loop re-enters the event loop
      // itself rather than relying on the read's IO wait (DR-0029).
      await yieldToEventLoop();
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(chunk, 0, toRead, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const data =
        carry.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        const uuid = rowUuid(data.toString("utf-8", start, newline));
        start = newline + 1;
        if (uuid !== undefined && !onUuid(uuid)) return true;
      }
      carry = data.subarray(start);
    }
    // A file whose final row has no trailing newline still ends in a record.
    if (carry.length > 0) {
      const uuid = rowUuid(carry.toString("utf-8"));
      if (uuid !== undefined && !onUuid(uuid)) return true;
    }
  } finally {
    await handle.close();
  }
  return limit >= size;
}

async function firstUuid(file: string): Promise<string | undefined> {
  let found: string | undefined;
  await scanUuids(
    file,
    (uuid) => {
      found = uuid;
      return false;
    },
    HEAD_SCAN_MAX_BYTES,
  );
  return found;
}

async function uuidSequence(file: string): Promise<string[] | null> {
  const sequence: string[] = [];
  const complete = await scanUuids(file, (uuid) => (sequence.push(uuid), true), SCAN_MAX_BYTES);
  return complete ? sequence : null;
}

async function uuidSet(file: string): Promise<Set<string> | null> {
  const set = new Set<string>();
  const complete = await scanUuids(file, (uuid) => (set.add(uuid), true), SCAN_MAX_BYTES);
  return complete ? set : null;
}

function birthMs(stat: fs.Stats): number {
  return stat.birthtimeMs || stat.ctimeMs;
}

export interface ForkOriginOptions {
  /** Test seam; production omits this and uses the file's birthtime. Creation
   * order is the only thing that says which of two files holding the same
   * records is the ancestor, and no portable call fakes it: `utimes`
   * backdates birthtime on macOS but leaves it alone on Linux, so tests state
   * the order outright instead of staging it on disk. */
  createdAt?: (file: string, stat: fs.Stats) => number;
}

/**
 * Resolves the seam for the transcript at `file`, or null when there is none to
 * show — the session is not a fork, or it is one whose ancestor file no longer
 * exists. Those two are deliberately one answer: once the ancestor is gone,
 * nothing on disk distinguishes them, and a viewer can draw nothing either way.
 */
export async function resolveForkOrigin(
  file: string,
  log: ForkOriginLog,
  opts: ForkOriginOptions = {},
): Promise<ForkOrigin | null> {
  const createdAt = opts.createdAt ?? ((_file, stat) => birthMs(stat));
  const head = await firstUuid(file);
  if (head === undefined) return null;

  let selfStat: fs.Stats;
  try {
    selfStat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  const selfBirth = createdAt(file, selfStat);

  const dir = path.dirname(file);
  const self = path.basename(file);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Narrowing stage. Sharing a first uuid means the two files' first records
  // are the same record, which only happens by duplication; requiring the
  // candidate to be older then fixes which of the pair is the ancestor. An
  // ordinary session matches nothing here and costs one head read per sibling.
  const candidates: { sid: string; file: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    if (entry.name === self) continue;
    const sid = entry.name.slice(0, -".jsonl".length);
    if (!isValidSid(sid)) continue;
    const sibling = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(sibling);
    } catch {
      continue;
    }
    if (createdAt(sibling, stat) >= selfBirth) continue;
    await yieldToEventLoop();
    try {
      if ((await firstUuid(sibling)) !== head) continue;
    } catch (error) {
      log.error(`fork_origin: failed reading ${sibling}: ${String(error)}`);
      continue;
    }
    candidates.push({ sid, file: sibling });
  }
  if (candidates.length === 0) return null;

  const sequence = await uuidSequence(file);
  if (sequence === null || sequence.length === 0) return null;

  // Membership, not positional equality: the ancestor file also holds rows the
  // fork did not copy (sidechain/subagent rows interleave into the parent but
  // not into the forked message array), so the copied run matches a *subset* of
  // the ancestor in order, and comparing the two sequences index-by-index
  // diverges almost immediately (17 rows instead of 1717 on this repo's data).
  let best: { sid: string; copied: number } | null = null;
  for (const candidate of candidates) {
    let ancestor: Set<string> | null;
    try {
      ancestor = await uuidSet(candidate.file);
    } catch (error) {
      log.error(`fork_origin: failed reading ${candidate.file}: ${String(error)}`);
      continue;
    }
    if (ancestor === null) continue;
    let copied = 0;
    while (copied < sequence.length && ancestor.has(sequence[copied]!)) copied += 1;
    // Sibling forks of one ancestor share a prefix too, so several candidates
    // can match; the longest run is the nearest ancestor and the true seam.
    if (copied > 0 && (best === null || copied > best.copied)) {
      best = { sid: candidate.sid, copied };
    }
  }
  if (best === null) return null;
  // The whole file being copied would mean no forked turns exist yet; there is
  // no seam to draw below the last row.
  if (best.copied >= sequence.length) return null;
  return { sid: best.sid, boundary_uuid: sequence[best.copied - 1]!, copied: best.copied };
}

/**
 * Per-transcript memo of the resolution. The key deliberately omits size and
 * mtime: a session appends for as long as it runs, and appending cannot move a
 * seam that sits in the copied prefix, so keying on either would re-read the
 * ancestor on every poll of a live session. Identity is dev/ino/birthtime,
 * which an append leaves alone.
 */
export function createForkOriginCache(): {
  resolve(file: string, log: ForkOriginLog, opts?: ForkOriginOptions): Promise<ForkOrigin | null>;
} {
  const memo = new Map<string, Promise<ForkOrigin | null>>();
  return {
    async resolve(file, log, opts) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        return null;
      }
      const key = `${stat.dev}:${stat.ino}:${birthMs(stat)}`;
      const cached = memo.get(key);
      if (cached) return await cached;
      // The promise is memoized before it settles so concurrent viewers of one
      // session share a single sweep instead of racing two.
      const pending = resolveForkOrigin(file, log, opts).catch((error: unknown) => {
        memo.delete(key);
        throw error;
      });
      memo.set(key, pending);
      return await pending;
    },
  };
}
