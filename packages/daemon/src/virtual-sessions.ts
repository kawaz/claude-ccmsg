import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ErrorCode,
  type ErrorCode as ErrorCodeType,
  parseWith,
  TranscriptRowCwdLineSchema,
} from "@ccmsg/protocol";
import { detectConfigDirs } from "./agents.ts";

const CWD_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSid(sid: string): boolean {
  return UUID_RE.test(sid);
}

/**
 * Resolve a sid's transcript only below `<configDir>/projects/<project>/` directories.
 * This deliberately rebuilds the lookup on every call: Claude Code creates and appends
 * project transcripts continuously, so a daemon-side index would become stale unless it
 * grew a second watch/invalidation subsystem. The bounded `readdir + stat` lookup is both
 * current and safer than interpolating the sid into a glob pattern.
 *
 * The config dirs are looked in in the order given, each once: a caller that
 * knows the session's own config dir (a hello names it) puts it first, so its
 * transcript is found there before any other dir is read. The default is the
 * detected dirs, sorted.
 *
 * Within a config dir every project directory is looked into at once, and the
 * first hit in name order wins. Looked into one after another, a lookup is one
 * wait on the event loop per project directory (several hundred in a real
 * home), and while the loop is busy (the folds catching up on the live
 * sessions' transcripts after a daemon restart) each wait is long; at once, it
 * is one wait per config dir however many project directories it holds.
 */
export async function resolveVirtualTranscript(
  sid: string,
  configDirs: readonly string[] = detectConfigDirs(),
): Promise<{ file: string; configDir: string } | undefined> {
  if (!isValidSid(sid)) return undefined;

  for (const configDir of new Set(configDirs)) {
    const projects = path.join(configDir, "projects");
    let projectEntries: fs.Dirent[];
    try {
      projectEntries = await fs.promises.readdir(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    // Symlinked project directories/files are excluded so "projects/*" is a
    // physical containment boundary, not merely a lexical path prefix.
    const candidates = projectEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => path.join(projects, name, `${sid}.jsonl`));
    const found = await Promise.all(candidates.map(isRegularFile));
    const file = candidates.find((_, i) => found[i]);
    if (file !== undefined) return { file, configDir };
  }
  return undefined;
}

/** Whether `file` is a regular file itself (a symlink is not). Missing (the
 * normal case for all but one project directory), or raced away: false. */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** Scan at most the transcript head budget and return the first absolute top-level cwd. */
export async function scanTranscriptCwd(
  file: string,
  maxBytes = CWD_SCAN_MAX_BYTES,
): Promise<string | undefined> {
  let size: number;
  try {
    size = Math.min((await fs.promises.stat(file)).size, maxBytes);
  } catch {
    return undefined;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return undefined;
  }
  let offset = 0;
  let carry = Buffer.alloc(0);
  const inspect = (line: string): string | undefined => {
    const row = parseWith(TranscriptRowCwdLineSchema, line);
    if (!row.ok || row.value.cwd === undefined || !path.isAbsolute(row.value.cwd)) return undefined;
    return row.value.cwd;
  };

  try {
    while (offset < size) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, size - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead: read } = await handle.read(chunk, 0, toRead, offset);
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
        const cwd = inspect(data.toString("utf-8", start, newline));
        if (cwd) return cwd;
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
    if (carry.length > 0 && offset < maxBytes) return inspect(carry.toString("utf-8"));
    return undefined;
  } finally {
    await handle.close();
  }
}

export interface RepoLocation {
  root: string;
  repo: string | null;
  ws: string | null;
}

/**
 * Heuristically recognize the configured repository layout
 * `.../repos/{host}/{owner}/{repo}/{workspace...}`. The JSONL cwd remains the
 * source of truth: paths outside that convention simply use cwd as their root
 * and expose no repo/workspace labels.
 */
export function deriveRepoLocation(cwd: string): RepoLocation {
  const absolute = path.resolve(cwd);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let reposIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "repos" && i + 3 < parts.length) {
      reposIndex = i;
      break;
    }
  }
  if (reposIndex < 0) return { root: absolute, repo: null, ws: null };

  const owner = parts[reposIndex + 2];
  const repoName = parts[reposIndex + 3];
  const root = path.join(parsed.root, ...parts.slice(0, reposIndex + 4));
  const workspace = parts.slice(reposIndex + 4);
  return {
    root,
    repo: `${owner}/${repoName}`,
    ws: workspace.length > 0 ? workspace.join(path.sep) : null,
  };
}

export type VirtualRootResult =
  | { ok: true; root: string; cwd: string }
  | { ok: false; code: ErrorCodeType; msg: string };

export async function resolveVirtualRoot(
  sid: string,
  configDirs: readonly string[] = detectConfigDirs(),
): Promise<VirtualRootResult> {
  const transcript = await resolveVirtualTranscript(sid, configDirs);
  if (!transcript) {
    return { ok: false, code: ErrorCode.session_not_found, msg: `session not found: ${sid}` };
  }
  const cwd = await scanTranscriptCwd(transcript.file);
  if (!cwd) {
    return { ok: false, code: ErrorCode.not_found, msg: `session has no usable cwd: ${sid}` };
  }

  // No child process is launched to discover a repository. Historical browsing
  // is a high-frequency read path, and deriving from the established path layout
  // avoids executing an external command in an arbitrary transcript-provided cwd.
  const candidate = deriveRepoLocation(cwd).root;
  let root: string;
  let realCwd: string;
  try {
    root = await fs.promises.realpath(candidate);
    realCwd = await fs.promises.realpath(cwd);
  } catch {
    return {
      ok: false,
      code: ErrorCode.not_found,
      msg: `session cwd no longer exists: ${cwd}`,
    };
  }

  let home = "";
  try {
    home = await fs.promises.realpath(os.homedir());
  } catch {
    // If HOME itself cannot be resolved, the root/cwd checks below still fail closed.
  }
  if (
    root === path.parse(root).root ||
    (home !== "" && (root === home || home.startsWith(root + path.sep)))
  ) {
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `session cwd has an unsafe containment root: ${cwd}`,
    };
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (realCwd !== root && !realCwd.startsWith(prefix)) {
    return {
      ok: false,
      code: ErrorCode.path_forbidden,
      msg: `session cwd escapes its derived containment root: ${cwd}`,
    };
  }
  return { ok: true, root, cwd };
}
