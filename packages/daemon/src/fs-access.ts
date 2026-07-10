// Workspace file access (DR-0008): containment-checked fs_list / fs_read.
//
// The browsable universe for a given `sid` is exactly "the realpath of that
// session's cwd" (the root). Every request path is resolved relative to the
// root and must, after resolving symlinks, stay inside it. There is no way
// for a client to name a filesystem root directly — only a connected
// session's sid — so a client can never browse outside sessions it can
// already see peers for.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  FS_READ_MAX_BYTES,
  type FsEntry,
  type FsListResponse,
  type FsReadResponse,
} from "@ccmsg/protocol";

/** Minimal shape fs-access needs from `Daemon.sessions` — kept structural
 *  (rather than importing `Daemon`/`SessionEntry` from server.ts) so this
 *  module has no dependency edge back to the module that imports it. */
export interface SessionLookup {
  get(sid: string): { meta: { cwd: string }; conns: { size: number } } | undefined;
}

export type FsAccessResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; msg: string };

// --- root resolution ---------------------------------------------------

interface RootOk {
  ok: true;
  root: string;
}
interface RootErr {
  ok: false;
  code: ErrorCode;
  msg: string;
}

/** Resolve `sid` to its containment root. Every failure mode here — unknown
 *  sid, sid with no live connection, missing/relative cwd, cwd that no
 *  longer exists on disk — collapses to `session_not_found`: from the
 *  client's point of view there is simply no browsable root for that sid. */
function resolveRoot(sessions: SessionLookup, sid: string): RootOk | RootErr {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) {
    return { ok: false, code: ErrorCode.session_not_found, msg: `session not connected: ${sid}` };
  }
  const cwd = entry.meta.cwd;
  if (!cwd || !path.isAbsolute(cwd)) {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session has no usable cwd: ${sid}`,
    };
  }
  try {
    return { ok: true, root: fs.realpathSync(cwd) };
  } catch {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session cwd not accessible: ${sid}`,
    };
  }
}

// --- containment ---------------------------------------------------------

interface ContainedOk {
  ok: true;
  realPath: string;
}
interface ContainedErr {
  ok: false;
  code: ErrorCode;
  msg: string;
}

/**
 * Resolve `reqPath` (relative to `root`) to a realpath guaranteed to be
 * inside `root`, or a fail-closed error.
 *
 * Three checks, in order:
 *  1. Absolute rejection: the wire contract (FsListRequest/FsReadRequest)
 *     requires `path` to be relative to the session root — there's no
 *     client-facing way to name a filesystem root directly. An absolute
 *     `reqPath` is a contract violation and is rejected unconditionally,
 *     even in the degenerate case where it happens to point at (or under)
 *     `root` itself — `path.resolve(root, absolutePath)` would otherwise
 *     return `absolutePath` unchanged and could pass containment by
 *     coincidence. This check is about the *shape* of the input, not a
 *     ".."-style string blacklist.
 *  2. Lexical: `path.resolve(root, reqPath)` normalizes ".." — this alone
 *     rejects any ".." escape that survives normalization, without
 *     touching the filesystem. (Pure optimization: step 3's realpath walk
 *     would also catch this, just after extra syscalls.)
 *  3. Realpath walk: a lexically-inside path can still escape via a
 *     symlink somewhere in the chain (e.g. `root/link -> /etc`). We walk up
 *     from the full candidate to the nearest *existing* ancestor,
 *     realpath-resolve it, and check containment on the resolved path. This
 *     catches symlink escapes at any depth. If the full candidate existed,
 *     that realpath is the answer. If only an ancestor existed, we report
 *     not_found (but only after confirming the existing ancestor itself
 *     didn't escape root — an escaping ancestor is path_forbidden even if
 *     the leaf doesn't exist, so we never leak "does this exist" information
 *     about paths reachable only through a forbidden symlink).
 *
 * Known limitation (TOCTOU): the realpath walk above and the later
 * `fs.openSync`/`fs.lstatSync` on the resolved path are not atomic — a
 * symlink somewhere in the chain could be repointed between the check and
 * the open. This is only exploitable by a process sharing the daemon's own
 * UID with write access to the containment path, and such a process could
 * already read the filesystem directly without going through the daemon at
 * all. So the gap doesn't cross the trust boundary this check exists to
 * enforce (DR-0008): it doesn't let anyone reach further than they could
 * already reach on their own.
 */
function resolveContained(root: string, reqPath: string): ContainedOk | ContainedErr {
  if (path.isAbsolute(reqPath)) {
    return { ok: false, code: ErrorCode.path_forbidden, msg: `path must be relative: ${reqPath}` };
  }
  const raw = reqPath === "." ? "" : reqPath;
  const candidate = path.resolve(root, raw);
  // `root + path.sep` would double up to "//" when root is itself the
  // filesystem root (e.g. a session cwd of "/"), making every direct child
  // fail the startsWith check. Only append the separator if root doesn't
  // already end with one.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;

  if (candidate !== root && !candidate.startsWith(prefix)) {
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `path escapes session root: ${reqPath}`,
    };
  }

  let cursor = candidate;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(cursor);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        // permission denied / not-a-directory-in-path / etc — fail closed
        // rather than let filesystem errors leak structure information.
        return {
          ok: false,
          code: ErrorCode.path_forbidden,
          msg: `cannot resolve path: ${reqPath}`,
        };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        // walked all the way to "/" and nothing existed (root itself must
        // exist, since resolveRoot realpath'd it, so this is unreachable
        // in practice; kept as a fail-closed terminator).
        return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
      }
      cursor = parent;
      continue;
    }
    if (real !== root && !real.startsWith(prefix)) {
      return {
        ok: false,
        code: ErrorCode.path_forbidden,
        msg: `path escapes session root: ${reqPath}`,
      };
    }
    if (cursor !== candidate) {
      // an ancestor existed (and stayed in-root) but the full candidate didn't
      return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
    }
    return { ok: true, realPath: real };
  }
}

// --- fs_list ---------------------------------------------------------------

function compareEntries(a: FsEntry, b: FsEntry): number {
  // dirs first (DR-0008: fs_list ordering), then name ascending (plain
  // codepoint order — deliberately not locale-aware, so results are
  // identical across test/CI/user locales).
  if (a.type === "dir" && b.type !== "dir") return -1;
  if (a.type !== "dir" && b.type === "dir") return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function lstatType(stat: fs.Stats): FsEntry["type"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

export function fsList(
  sessions: SessionLookup,
  sid: string,
  reqPath: string | undefined,
): FsAccessResult<Omit<FsListResponse, "ok">> {
  const rootResult = resolveRoot(sessions, sid);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.root;

  if (reqPath !== undefined && typeof reqPath !== "string") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_list path must be a string" };
  }

  const resolved = resolveContained(root, reqPath ?? "");
  if (!resolved.ok) return resolved;

  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(resolved.realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath ?? ""}` };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_list target is not a directory" };
  }

  const names = fs.readdirSync(resolved.realPath);
  const entries: FsEntry[] = names.map((name) => {
    const full = path.join(resolved.realPath, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      // vanished between readdir and lstat (race with external mutation) —
      // report as "other" rather than dropping the entry silently.
      return { name, type: "other" as const };
    }
    const type = lstatType(stat);
    const entry: FsEntry = { name, type, mtime: stat.mtime.toISOString() };
    if (type === "file") entry.size = stat.size;
    return entry;
  });
  entries.sort(compareEntries);

  const relPath = path.relative(root, resolved.realPath);
  return { ok: true, data: { sid, path: relPath, entries } };
}

// --- fs_read -----------------------------------------------------------

export function fsRead(
  sessions: SessionLookup,
  sid: string,
  reqPath: string,
): FsAccessResult<Omit<FsReadResponse, "ok">> {
  const rootResult = resolveRoot(sessions, sid);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.root;

  if (typeof reqPath !== "string" || reqPath === "") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_read requires path" };
  }

  const resolved = resolveContained(root, reqPath);
  if (!resolved.ok) return resolved;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved.realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_read target is not a regular file" };
  }

  const size = stat.size;
  const toRead = Math.min(size, FS_READ_MAX_BYTES);
  const buf = Buffer.alloc(toRead);
  const fd = fs.openSync(resolved.realPath, "r");
  let readTotal = 0;
  try {
    while (readTotal < toRead) {
      const n = fs.readSync(fd, buf, readTotal, toRead - readTotal, readTotal);
      if (n === 0) break; // file shrank concurrently; stop rather than loop forever
      readTotal += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  const content = buf.subarray(0, readTotal);

  // binary sniff: NUL byte anywhere in the first 8 KiB of what was actually read.
  const sniffLen = Math.min(content.length, 8192);
  let binary = false;
  for (let i = 0; i < sniffLen; i++) {
    if (content[i] === 0) {
      binary = true;
      break;
    }
  }

  const relPath = path.relative(root, resolved.realPath);
  return {
    ok: true,
    data: {
      sid,
      path: relPath,
      size,
      truncated: size > FS_READ_MAX_BYTES,
      binary,
      content: binary ? "" : content.toString("utf-8"),
    },
  };
}
