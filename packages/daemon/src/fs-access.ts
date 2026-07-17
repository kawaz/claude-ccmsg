// Workspace file access (DR-0008 / DR-0019 / DR-0024): containment-checked
// fs_list / fs_read, transcript-allowlisted fs_read_external, inbox-only fs_write.
//
// fs_list/fs_read resolve paths from the browsable containment root
// (`repo_root ?? cwd`). fs_write instead resolves its request path from the
// session's cwd so a new inbox memo belongs to that working copy, then applies
// the same realpath containment boundary before creating anything. Clients
// cannot name either filesystem base directly — only a session sid. DR-0024's
// sole absolute-path surface accepts exact files already recorded in that sid's
// folded transcript allowlist, never an arbitrary path or directory prefix.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ErrorCode,
  FS_READ_MAX_BYTES,
  type FsEntry,
  type FsListResponse,
  type FsReadResponse,
  type FsWriteResponse,
} from "@ccmsg/protocol";
import {
  getSessionStatus,
  type SessionStatusLookup,
  type SessionStatusStore,
} from "./session-status.ts";
import { resolveVirtualRoot } from "./virtual-sessions.ts";

/** Minimal shape fs-access needs from `Daemon.sessions` — kept structural
 *  (rather than importing `Daemon`/`SessionEntry` from server.ts) so this
 *  module has no dependency edge back to the module that imports it. */
export interface SessionLookup extends SessionStatusLookup {
  get(sid: string):
    | {
        meta: { cwd: string; repo_root?: string; transcript_path?: string };
        conns: { size: number };
      }
    | undefined;
}

/**
 * Hello-time validation (DR-0008 addendum): a session's self-declared
 * `repo_root` is adopted only if ALL of the following hold — any failure
 * returns `undefined` (silent no-op, fail-open): hello still succeeds, and
 * fs_list/fs_read simply keep using cwd as the containment root, same as a
 * session that never announced one.
 *
 *  1. absolute path (same shape requirement as fs_list/fs_read's own `path`
 *     contract — no client-facing way to name a root via a relative string).
 *  2. `cwd` itself is present/absolute and realpath-resolvable — the "widen
 *     the root" request is meaningless without a real anchor to widen from.
 *  3. `repo_root` is realpath-resolvable (the container directory must
 *     actually exist on this machine right now).
 *  4. realpath(repo_root) is a *strict* ancestor of realpath(cwd) — not cwd
 *     itself. This is the crux of DR-0008's containment guarantee: the
 *     announced root may only ever *widen* browsing to siblings of the
 *     session's own workspace, never point somewhere unrelated to where the
 *     session actually is.
 *  5. realpath(repo_root) is neither "/" nor `$HOME` nor any ancestor of
 *     `$HOME` (e.g. `/Users` above `$HOME=/Users/kawaz`) — all of these are
 *     catastrophically wide containers (the entire filesystem / the user's
 *     whole home directory / everything alongside it), and accepting any of
 *     them would defeat the "sibling workspaces of this repo" scoping
 *     DR-0008 intends. `$HOME` is resolved via `os.homedir()` (not an env
 *     var) so a spoofed `HOME` in the session's environment can't be used to
 *     pick a different exclusion target than the daemon process's own actual
 *     home; it's also realpath'd before comparison so a symlinked home
 *     doesn't slip past the ancestor check.
 */
export function validateRepoRoot(cwd: unknown, repoRootCandidate: unknown): string | undefined {
  if (typeof repoRootCandidate !== "string" || repoRootCandidate === "") return undefined;
  if (!path.isAbsolute(repoRootCandidate)) return undefined;
  if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) return undefined;

  let realRoot: string;
  let realCwd: string;
  try {
    realRoot = fs.realpathSync(repoRootCandidate);
    realCwd = fs.realpathSync(cwd);
  } catch {
    return undefined;
  }

  if (realRoot === "/") return undefined;
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = "";
  }
  // realRoot must not be $HOME itself, nor an ancestor of $HOME (e.g. "/Users"
  // sitting above "/Users/kawaz") — an ancestor-or-self check, not just "===".
  if (home !== "" && (home === realRoot || home.startsWith(realRoot + path.sep))) return undefined;

  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realRoot === realCwd || !realCwd.startsWith(prefix)) return undefined;

  return realRoot;
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

export interface FsAccessOptions {
  /** Historical fallback is passed only by user-role fs_list/fs_read. fs_write
   * deliberately omits it, so an unconnected session can never be modified. */
  allowVirtual?: boolean;
  /** Test seam; production omits this and uses daemon-detected config dirs. */
  configDirs?: readonly string[];
}

/** Resolve `sid` to its containment root: the session's accepted `repo_root`
 *  (DR-0008 addendum) when present — widening browsing to sibling
 *  workspaces/worktrees — else its plain `cwd`, exactly as before that
 *  addendum. Historical user-role reads may fall back to the cwd-derived virtual
 *  root; connected sessions retain the existing contract unchanged. */
function resolveRoot(
  sessions: SessionLookup,
  sid: string,
  opts: FsAccessOptions = {},
): RootOk | RootErr {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) {
    if (opts.allowVirtual) return resolveVirtualRoot(sid, opts.configDirs);
    return { ok: false, code: ErrorCode.session_not_found, msg: `session not connected: ${sid}` };
  }
  const base = entry.meta.repo_root ?? entry.meta.cwd;
  if (!base || !path.isAbsolute(base)) {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session has no usable cwd: ${sid}`,
    };
  }
  try {
    return { ok: true, root: fs.realpathSync(base) };
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
 * Resolve `reqPath` relative to `requestBase` (the containment root by
 * default) to a realpath guaranteed to be inside `root`, or a fail-closed
 * error. fs_write passes the session cwd as `requestBase`; readers keep the
 * default so their visible tree remains root-relative.
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
 *  2. Lexical: `path.resolve(requestBase, reqPath)` normalizes ".." — this alone
 *     rejects any ".." escape that survives normalization, without
 *     touching the filesystem. (Pure optimization: step 3's realpath walk
 *     would also catch this, just after extra syscalls.)
 *  3. Realpath walk: a lexically-inside path can still escape via a
 *     symlink somewhere in the chain (e.g. `root/link -> /etc`). We walk up
 *     from the full candidate to the nearest *existing* ancestor,
 *     realpath-resolve it, and check containment on the resolved path. This
 *     catches symlink escapes at any depth. If the full candidate existed,
 *     that realpath is the answer. If only an ancestor existed, readers get
 *     not_found; a create-only caller instead receives the existing
 *     ancestor's realpath joined with the missing lexical remainder — a
 *     realpath-normalized location, so downstream policy checks (fs_write's
 *     docs/inbox prefix) can't be redirected by an in-root symlink sitting
 *     between the root and the leaf. An escaping ancestor is always
 *     path_forbidden, so we never leak "does this exist" information about
 *     paths reachable only through a forbidden symlink.
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
function resolveContained(
  root: string,
  reqPath: string,
  allowMissing = false,
  requestBase = root,
): ContainedOk | ContainedErr {
  if (path.isAbsolute(reqPath)) {
    return { ok: false, code: ErrorCode.path_forbidden, msg: `path must be relative: ${reqPath}` };
  }
  const raw = reqPath === "." ? "" : reqPath;
  const candidate = path.resolve(requestBase, raw);
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
      // An ancestor existed and stayed in-root, but the full candidate didn't.
      // Read/list callers keep the existing not_found contract. A create-only
      // caller gets realpath(ancestor) + the missing lexical remainder — NOT
      // the raw lexical candidate — so an in-root symlink between root and
      // leaf (e.g. docs/inbox -> src) is already resolved in the returned
      // path and downstream policy checks judge the true write location.
      if (allowMissing) {
        return { ok: true, realPath: path.join(real, path.relative(cursor, candidate)) };
      }
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
  opts: FsAccessOptions = {},
): FsAccessResult<Omit<FsListResponse, "ok">> {
  const rootResult = resolveRoot(sessions, sid, opts);
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

// --- fs_read / fs_read_external ---------------------------------------

/** Shared regular-file read after each operation has completed its own
 * authorization. DR-0024 intentionally reuses the byte cap/binary contract but
 * not fs_read's containment grant: fs_read_external reaches this helper only
 * after an exact transcript allowlist match and a fresh realpath check. */
function readRegularFile(
  sid: string,
  realPath: string,
  responsePath: string,
  requestPath: string,
): FsAccessResult<Omit<FsReadResponse, "ok">> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${requestPath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_read target is not a regular file" };
  }

  const size = stat.size;
  const toRead = Math.min(size, FS_READ_MAX_BYTES);
  const buf = Buffer.alloc(toRead);
  const fd = fs.openSync(realPath, "r");
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

  return {
    ok: true,
    data: {
      sid,
      path: responsePath,
      size,
      truncated: size > FS_READ_MAX_BYTES,
      binary,
      content: binary ? "" : content.toString("utf-8"),
    },
  };
}

export function fsRead(
  sessions: SessionLookup,
  sid: string,
  reqPath: string,
  opts: FsAccessOptions = {},
): FsAccessResult<Omit<FsReadResponse, "ok">> {
  const rootResult = resolveRoot(sessions, sid, opts);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.root;

  if (typeof reqPath !== "string" || reqPath === "") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_read requires path" };
  }

  const resolved = resolveContained(root, reqPath);
  if (!resolved.ok) return resolved;
  return readRegularFile(sid, resolved.realPath, path.relative(root, resolved.realPath), reqPath);
}

/** DR-0024 external-file authorization. The request must name one absolute path
 * whose normalized spelling is an exact external_files entry for this sid; no
 * prefix or directory grant exists. realpath is repeated immediately before the
 * read so a path/ancestor replaced with a symlink after transcript folding is
 * rejected when its target no longer equals an allowlist entry. Other realpath
 * failures fail closed without leaking filesystem structure. The remaining
 * realpath→lstat/open TOCTOU gap has the same-UID limitation documented for
 * resolveContained: a process able to win it can already read the target directly. */
export function fsReadExternal(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  reqPath: string,
): FsAccessResult<Omit<FsReadResponse, "ok">> {
  if (typeof reqPath !== "string" || reqPath === "" || !path.isAbsolute(reqPath)) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "fs_read_external requires an absolute path",
    };
  }

  const status = getSessionStatus(statusStore, sessions, sid);
  if (!status.ok) return status;
  const allowlist = new Set(status.data.external_files ?? []);
  const normalized = path.normalize(reqPath);
  if (!allowlist.has(normalized)) {
    return { ok: false, code: ErrorCode.path_forbidden, msg: `path not allowed: ${reqPath}` };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(reqPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
    }
    return { ok: false, code: ErrorCode.path_forbidden, msg: `cannot resolve path: ${reqPath}` };
  }
  if (!allowlist.has(realPath)) {
    return { ok: false, code: ErrorCode.path_forbidden, msg: `path not allowed: ${reqPath}` };
  }

  return readRegularFile(sid, realPath, reqPath, reqPath);
}

// --- fs_list_workspace / fs_read_workspace (DR-0026) ------------------

/** Resolve `reqPath` against the session's workspace_folders allowlist:
 * accept any absolute path whose realpath is either exactly one of the
 * folder roots or lies inside one (directory-prefix grant). Returns the
 * realpath on success and the matched folder root (used by fs_list_workspace
 * to compute a relative response path when useful). The client may name the
 * folder root itself; walking `..` out of the folder is rejected because the
 * realpath is checked, not the input string.
 *
 * Failure modes:
 *  - malformed input (non-string / empty / relative) → invalid_args
 *  - path exists but its realpath is outside every allowed folder → path_forbidden
 *  - path does not exist → not_found (fresh realpath failure with ENOENT
 *    doesn't tell us whether the ancestor is in the allowlist either, so we
 *    walk up to the nearest existing ancestor and check *its* realpath —
 *    only if that ancestor is allowlisted do we return not_found for the
 *    leaf; otherwise it's still path_forbidden, so a nonexistent leaf under
 *    a forbidden directory can't be probed via "does this exist" oracles).
 *  - other realpath errors (EACCES, ENOTDIR mid-chain) → path_forbidden */
function resolveWorkspaceContained(
  allowlist: readonly string[],
  reqPath: unknown,
): ContainedOk | ContainedErr {
  if (typeof reqPath !== "string" || reqPath === "") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "workspace path must be a string" };
  }
  if (!path.isAbsolute(reqPath)) {
    return { ok: false, code: ErrorCode.invalid_args, msg: "workspace path must be absolute" };
  }
  if (allowlist.length === 0) {
    return { ok: false, code: ErrorCode.path_forbidden, msg: `path not allowed: ${reqPath}` };
  }

  const insideAny = (candidate: string): boolean => {
    for (const folder of allowlist) {
      if (candidate === folder) return true;
      const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  };

  // Walk up from the requested path to the nearest existing ancestor, then
  // realpath that ancestor and check containment. Mirrors resolveContained
  // (fs_list/fs_read) but the containment set is now the allowlist instead
  // of a single root.
  let cursor = path.normalize(reqPath);
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(cursor);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        return {
          ok: false,
          code: ErrorCode.path_forbidden,
          msg: `cannot resolve path: ${reqPath}`,
        };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return { ok: false, code: ErrorCode.path_forbidden, msg: `path not allowed: ${reqPath}` };
      }
      cursor = parent;
      continue;
    }
    if (!insideAny(real)) {
      return { ok: false, code: ErrorCode.path_forbidden, msg: `path not allowed: ${reqPath}` };
    }
    if (cursor !== path.normalize(reqPath)) {
      // The full path did not exist; the nearest existing ancestor is
      // allowlisted, so treat the leaf as a genuine not_found rather than
      // leaking existence info via path_forbidden — this matches
      // fs_list/fs_read's not_found for missing paths inside their root.
      return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
    }
    return { ok: true, realPath: real };
  }
}

/** Pull the workspace_folders allowlist for a session from the folded status
 * snapshot. Called by both fs_list_workspace and fs_read_workspace so the two
 * ops share a single source of truth — the snapshot is what the client also
 * received to render the workspace section, so denies here can never surprise
 * a client that used a UI-visible folder. */
function getWorkspaceAllowlist(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
): { ok: true; folders: string[] } | { ok: false; code: ErrorCode; msg: string } {
  const status = getSessionStatus(statusStore, sessions, sid);
  if (!status.ok) return status;
  const folders = (status.data.workspace_folders ?? []).map((f) => f.path);
  return { ok: true, folders };
}

export function fsListWorkspace(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  reqPath: string,
): FsAccessResult<Omit<FsListResponse, "ok">> {
  const allow = getWorkspaceAllowlist(sessions, statusStore, sid);
  if (!allow.ok) return allow;
  const resolved = resolveWorkspaceContained(allow.folders, reqPath);
  if (!resolved.ok) return resolved;

  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(resolved.realPath);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `not found: ${reqPath}` };
  }
  if (!dirStat.isDirectory()) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "fs_list_workspace target is not a directory",
    };
  }

  const names = fs.readdirSync(resolved.realPath);
  const entries: FsEntry[] = names.map((name) => {
    const full = path.join(resolved.realPath, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return { name, type: "other" as const };
    }
    const type = lstatType(stat);
    const entry: FsEntry = { name, type, mtime: stat.mtime.toISOString() };
    if (type === "file") entry.size = stat.size;
    return entry;
  });
  entries.sort(compareEntries);

  // Response `path` is the absolute realpath — the client keyed the request
  // by absolute path (there's no single root to subtract) and needs the
  // canonicalized spelling back for its cache keys, mirroring how
  // fs_read_external / fs_read_workspace echo the absolute path.
  return { ok: true, data: { sid, path: resolved.realPath, entries } };
}

export function fsReadWorkspace(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  reqPath: string,
): FsAccessResult<Omit<FsReadResponse, "ok">> {
  const allow = getWorkspaceAllowlist(sessions, statusStore, sid);
  if (!allow.ok) return allow;
  const resolved = resolveWorkspaceContained(allow.folders, reqPath);
  if (!resolved.ok) return resolved;
  return readRegularFile(sid, resolved.realPath, resolved.realPath, reqPath);
}

// --- fs_write ----------------------------------------------------------

export function fsWrite(
  sessions: SessionLookup,
  sid: string,
  reqPath: string,
  content: string,
): FsAccessResult<Omit<FsWriteResponse, "ok">> {
  const rootResult = resolveRoot(sessions, sid);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.root;

  // Writes are addressed from the session's own working copy even when
  // repo_root widens fs_list/fs_read to a container of sibling workspaces.
  // Resolve cwd independently, then verify it still lies under the accepted
  // containment root before using it as the request base.
  const entry = sessions.get(sid);
  const declaredCwd = entry?.meta.cwd;
  if (!declaredCwd || !path.isAbsolute(declaredCwd)) {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session has no usable cwd: ${sid}`,
    };
  }
  let cwd: string;
  try {
    cwd = fs.realpathSync(declaredCwd);
  } catch {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session cwd not accessible: ${sid}`,
    };
  }
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (cwd !== root && !cwd.startsWith(rootPrefix)) {
    return {
      ok: false,
      code: ErrorCode.session_not_found,
      msg: `session cwd is outside its containment root: ${sid}`,
    };
  }

  if (typeof reqPath !== "string" || reqPath === "") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_write requires path" };
  }
  if (typeof content !== "string") {
    return { ok: false, code: ErrorCode.invalid_args, msg: "fs_write content must be a string" };
  }

  // Permit a missing leaf only after the nearest existing ancestor has passed
  // the same lexical + realpath containment checks fs_list/fs_read use.
  const resolved = resolveContained(root, reqPath, true, cwd);
  if (!resolved.ok) return resolved;

  // Policy check (DR-0019 § 3.1): judge the realpath-resolved location relative
  // to cwd, not the request string or repo_root. A lexical "docs/inbox/…"
  // whose docs/inbox is really an in-root symlink (e.g. -> src/) must not
  // smuggle a write outside this working copy's inbox.
  const cwdRelPath = path.relative(cwd, resolved.realPath);
  const inbox = path.join("docs", "inbox");
  const inboxPrefix = inbox + path.sep;
  if (!cwdRelPath.startsWith(inboxPrefix)) {
    return {
      ok: false,
      code: ErrorCode.path_not_writable,
      msg: `fs_write path must be under ${inboxPrefix}`,
    };
  }

  const rootRelPath = path.relative(root, resolved.realPath);
  try {
    fs.lstatSync(resolved.realPath);
    return { ok: false, code: ErrorCode.file_exists, msg: `path already exists: ${rootRelPath}` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      return {
        ok: false,
        code: ErrorCode.path_forbidden,
        msg: `cannot inspect path: ${reqPath}`,
      };
    }
  }

  try {
    fs.mkdirSync(path.dirname(resolved.realPath), { recursive: true });
  } catch {
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `cannot create parent directory: ${reqPath}`,
    };
  }

  // Re-check after mkdir so any symlink exposed in the newly-existing parent
  // chain is subject to containment before the create-only open. The inbox
  // policy is re-applied on the re-resolved location for the same reason —
  // both checks must hold for the path actually opened, not just the one
  // inspected before mkdir.
  const rechecked = resolveContained(root, reqPath, true, cwd);
  if (!rechecked.ok) return rechecked;
  if (!path.relative(cwd, rechecked.realPath).startsWith(inboxPrefix)) {
    return {
      ok: false,
      code: ErrorCode.path_not_writable,
      msg: `fs_write path must be under ${inboxPrefix}`,
    };
  }

  try {
    fs.writeFileSync(rechecked.realPath, content, { encoding: "utf-8", flag: "wx" });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      return { ok: false, code: ErrorCode.file_exists, msg: `path already exists: ${rootRelPath}` };
    }
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `cannot write path: ${reqPath}`,
    };
  }

  return { ok: true, data: { sid, path: path.relative(root, rechecked.realPath) } };
}
