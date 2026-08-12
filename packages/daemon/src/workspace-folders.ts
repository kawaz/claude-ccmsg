// DR-0026 VS Code `.code-workspace` detection + JSONC parsing + folders[]
// resolution. Called at session_status snapshot time (not fold time): the file
// is edited by hand out-of-band and has no transcript event to fold on, so
// freshness comes from re-checking disk each publish rather than from a fold.
// The check is a stat per path — the directory listing and each file's parsed
// folder list are memoized behind their own mtime (see mtime-cache.ts), so a
// publish that changes nothing on disk opens no files. Silently returns an
// empty list on any failure (cwd unresolvable, no matches, all files
// malformed) — a broken workspace file must never break the session_status
// pipeline.
//
// Detection scope is deliberately session cwd's top level, NOT the whole
// containment root: DR-0026 §2 says "session cwd 直下". A worktree that owns
// its own `.code-workspace` should not inherit its sibling's workspace file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceFolder } from "@ccmsg/protocol";
import { createMtimeCache } from "./mtime-cache.ts";

/** Strip JSONC comments (line + block) and trailing commas, then JSON.parse.
 * VS Code's own `.code-workspace` files are documented as JSONC — real files
 * in kawaz's tree use tab indentation and no comments today, but VS Code
 * itself accepts both, so the parser matches. Kept small (no dep) — the JSONC
 * grammar we need is a strict subset of what jsonc-parser handles, and this
 * module is the only caller.
 *
 * String-literal handling matters for `//` and `,` inside JSON strings: we
 * track an in-string flag and skip escapes so a folder path containing
 * `,` or `//` (e.g. an escaped URL, unlikely but possible) is not mangled.
 * Returns `undefined` on any post-strip JSON.parse failure — caller treats
 * as "workspace file unreadable" and skips it. */
export function parseJsonc(source: string): unknown {
  let out = "";
  let i = 0;
  const n = source.length;
  let inString = false;
  let stringQuote: string = '"';
  while (i < n) {
    const ch = source[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += source[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    // Line comment: // ... \n
    if (ch === "/" && i + 1 < n && source[i + 1] === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    // Block comment: /* ... */
    if (ch === "/" && i + 1 < n && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && i + 1 < n && source[i + 1] === "/")) i += 1;
      if (i < n) i += 2; // skip the closing */
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Strip trailing commas: `, }` / `, ]` (with any whitespace between). Done
  // as a separate pass after comment stripping so nested cases (`, /* c */ }`)
  // that survive comment stripping now look flat here. This pass tracks
  // in-string state again (same escape rules as above) so a literal `, }`
  // inside a JSON string — e.g. a folder path or name containing a comma —
  // is left intact; a naive regex over the whole text would mangle it.
  let stripped = "";
  let j = 0;
  const m = out.length;
  let inStr = false;
  let strQuote = '"';
  while (j < m) {
    const c = out[j]!;
    if (inStr) {
      stripped += c;
      if (c === "\\" && j + 1 < m) {
        stripped += out[j + 1]!;
        j += 2;
        continue;
      }
      if (c === strQuote) inStr = false;
      j += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strQuote = c;
      stripped += c;
      j += 1;
      continue;
    }
    if (c === ",") {
      // Look ahead past whitespace: a `}` or `]` next means this comma is a
      // JSONC trailing comma — drop it (whitespace is preserved as-is).
      let k = j + 1;
      while (k < m && /\s/.test(out[k]!)) k += 1;
      if (k < m && (out[k] === "}" || out[k] === "]")) {
        j += 1;
        continue;
      }
    }
    stripped += c;
    j += 1;
  }
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject folder roots that would grant an effectively unbounded browse
 * surface: `/` itself, the daemon user's `$HOME`, and any ancestor of
 * `$HOME` (e.g. `/Users`). Same policy — and same rationale — as
 * validateRepoRoot's repo_root widening guard in fs-access.ts: a workspace
 * file is a first-class artifact of the repo (DR-0026), but it is writable
 * by the AI session running in that cwd, so folder entries must not be able
 * to escalate the webui's read surface to "everything". Descendants of
 * `$HOME` (where all of kawaz's repos live) remain allowed. `home` is taken
 * from the daemon's own os.homedir(), realpath'd, never from session env. */
async function isOverbroadFolderRoot(real: string): Promise<boolean> {
  if (real === "/") return true;
  let home: string;
  try {
    home = await fs.promises.realpath(os.homedir());
  } catch {
    return false;
  }
  return home === real || home.startsWith(real + path.sep);
}

/** Return the workspace folder entries advertised by the parsed workspace
 * document, or `undefined` if the shape is not a `folders[]` array of records.
 * Non-record / missing-path entries are individually dropped — a partially
 * malformed workspace file still yields whatever valid folders it lists. */
function extractFolderSpecs(doc: unknown): Array<{ path: string; name?: string }> | undefined {
  if (!isRecord(doc)) return undefined;
  const folders = doc.folders;
  if (!Array.isArray(folders)) return undefined;
  const specs: Array<{ path: string; name?: string }> = [];
  for (const entry of folders) {
    if (!isRecord(entry)) continue;
    const p = entry.path;
    if (typeof p !== "string" || p === "") continue;
    const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined;
    specs.push(name ? { path: p, name } : { path: p });
  }
  return specs;
}

/** Discover all workspace folders declared by `*.code-workspace` files at
 * the top level of `cwd`. Each returned entry's `path` is a realpath — the
 * exact string fs_list_workspace / fs_read_workspace check as an allowlist
 * prefix. Order is deterministic (workspace-file name ascending, then the
 * order folders[] declares them); duplicates by realpath drop the later one
 * so a folder listed twice (or referenced by two workspace files) shows once.
 *
 * Failure modes are all silent (fail-open on the calling channel: an empty
 * list disables the DR-0026 section, no error surfacing). This matches how
 * `external_files` behaves when transcript scanning finds nothing. */
export async function discoverWorkspaceFolders(cwd: string): Promise<WorkspaceFolder[]> {
  if (!path.isAbsolute(cwd)) return [];
  const workspaceFiles = await workspaceFileNames.get(cwd, async () => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cwd, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".code-workspace"))
      .map((e) => e.name)
      .sort();
  });
  if (!workspaceFiles) return [];

  const seenRealpaths = new Set<string>();
  const result: WorkspaceFolder[] = [];
  for (const filename of workspaceFiles) {
    const file = path.join(cwd, filename);
    const folders = await foldersByWorkspaceFile.get(file, () => resolveWorkspaceFile(file));
    for (const folder of folders ?? []) {
      if (seenRealpaths.has(folder.path)) continue;
      seenRealpaths.add(folder.path);
      result.push(folder);
    }
  }
  return result;
}

/** `*.code-workspace` names at the top level of one cwd, keyed by that cwd and
 * revalidated by its directory mtime (which moves whenever an entry is added,
 * removed, or renamed — the only changes that can alter this list). */
const workspaceFileNames = createMtimeCache<string[]>(64);

/** One workspace file's resolved folder entries, revalidated by that file's
 * own mtime. The memoized value includes each entry's realpath and its
 * directory / overbroad-root verdicts, so a publish over an unedited workspace
 * file performs no realpath and no per-folder stat.
 *
 * Staleness this admits: a folder deleted, or a symlinked folder retargeted,
 * after the file was last parsed keeps its cached realpath until the workspace
 * file is next edited. That cannot widen the webui's read surface — the cached
 * path is the one the workspace file itself declared and validated, and a read
 * of a path that no longer exists fails as not_found on the fs_read side. */
const foldersByWorkspaceFile = createMtimeCache<WorkspaceFolder[]>(256);

/** Parse one `.code-workspace` and resolve its `folders[]` to realpaths.
 * Returns the entries it could validate; an unreadable / malformed file or a
 * file with no usable `folders[]` yields an empty list. */
async function resolveWorkspaceFile(file: string): Promise<WorkspaceFolder[]> {
  let source: string;
  try {
    source = await fs.promises.readFile(file, "utf-8");
  } catch {
    return [];
  }
  const specs = extractFolderSpecs(parseJsonc(source));
  if (!specs) return [];
  const folders: WorkspaceFolder[] = [];
  for (const spec of specs) {
    // `folders[].path` in a `.code-workspace` file is resolved relative to
    // the workspace file's own location (VS Code semantics), *not* the
    // session cwd. In kawaz's practice both usually coincide, but the
    // workspace file could live in a subdirectory and reference `../foo`.
    const abs = path.isAbsolute(spec.path)
      ? spec.path
      : path.resolve(path.dirname(file), spec.path);
    let real: string;
    try {
      real = await fs.promises.realpath(abs);
    } catch {
      // Non-existent / permission-denied folder: skip. Stale workspace
      // entries (e.g. a `.worktrees/foo` that was removed) shouldn't
      // leak into the allowlist — realpath failure = no grant.
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(real);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (await isOverbroadFolderRoot(real)) continue;
    folders.push({ name: spec.name ?? (path.basename(real) || real), path: real });
  }
  return folders;
}
