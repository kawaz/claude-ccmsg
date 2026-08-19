// Deriving `repo`/`ws` from a session's cwd, for hellos that announce neither.
//
// The announced values ride the hook-written session state file, which a
// fork/resume launch never gets (the same structural hole adoptTranscriptPath
// covers for transcript_path) — such sessions showed up in the webui's SESSIONS
// list with empty repo/ws columns. This module reproduces what the hook's
// `bump-semver vcs get` calls would have reported, from the on-disk layout
// alone:
//
//   - `repo` = the origin remote URL's `owner/repo` slug (bump-semver's
//     `vcs get repository`, DR-0041), read out of the backing git config;
//   - `ws`   = the jj workspace / git linked-worktree directory name, falling
//     back to the checked-out branch when there is no workspace layer
//     (bump-semver's `worktree-name` else `current-branch`, per the hook's
//     deriveWs).
//
// Design rationale: no subprocess. The hook can afford `bump-semver` because it
// runs on kawaz's machine where the binary exists; the daemon serves sessions
// whose environment it does not control, and a hello must not block on a
// spawn that may not resolve. Every fact needed here is a small file read:
//
//   jj default workspace   `<root>/.jj/repo` is a directory
//   jj secondary workspace `<root>/.jj/repo` is a file holding a relative path
//                          to the primary's `.jj/repo`; the workspace name is
//                          the root's basename (jj has no "name of current
//                          workspace" query — same convention bump-semver's
//                          jjBackend.WorktreeName relies on)
//   jj -> git store        `<repo>/store/git_target`, relative to `store/`
//   git main worktree      `<root>/.git` is a directory
//   git linked worktree    `<root>/.git` is a file `gitdir: <path>`; the common
//                          dir (where `config` lives) is `<gitdir>/commondir`
//
// Every failure degrades to "" for the affected field. Nothing here throws, and
// a value is never invented: a repo with no forge remote and no recognizable
// path layout keeps an empty `repo` rather than a guess.
import * as fs from "node:fs";
import * as path from "node:path";

export interface DerivedRepoWs {
  repo: string;
  ws: string;
}

const EMPTY: DerivedRepoWs = { repo: "", ws: "" };

async function statOrUndefined(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return undefined;
  }
}

async function readTextOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Walks `dir` and its ancestors for a `.jj` / `.git` marker, stopping at the
 * first directory carrying either (jj wins when both sit at the same level —
 * DR-0008's precedence, and the layout kawaz's repos use: a git bare store next
 * to the jj repo). */
async function findRepoRoot(
  dir: string,
): Promise<{ root: string; backend: "jj" | "git" } | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    if (await statOrUndefined(path.join(current, ".jj"))) return { root: current, backend: "jj" };
    if (await statOrUndefined(path.join(current, ".git"))) return { root: current, backend: "git" };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `.jj/repo` resolution: the directory holding the jj repo's own state, plus
 * the workspace name (empty for the default workspace, whose `.jj/repo` IS that
 * directory). */
async function resolveJjRepo(root: string): Promise<{ repoDir: string; ws: string } | undefined> {
  const marker = path.join(root, ".jj", "repo");
  const st = await statOrUndefined(marker);
  if (!st) return undefined;
  if (st.isDirectory()) return { repoDir: marker, ws: "" };
  const target = (await readTextOrUndefined(marker))?.trim();
  if (!target) return undefined;
  return {
    repoDir: path.resolve(path.dirname(marker), target),
    ws: path.basename(root),
  };
}

/** git dir resolution: the *common* dir (the one holding `config`), plus the
 * worktree name (empty for the main worktree). */
async function resolveGitDir(root: string): Promise<{ commonDir: string; ws: string } | undefined> {
  const marker = path.join(root, ".git");
  const st = await statOrUndefined(marker);
  if (!st) return undefined;
  if (st.isDirectory()) return { commonDir: marker, ws: "" };
  const contents = (await readTextOrUndefined(marker))?.trim();
  const gitdirLine = contents?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdirLine) return undefined;
  const gitDir = path.resolve(root, gitdirLine);
  const commonRel = (await readTextOrUndefined(path.join(gitDir, "commondir")))?.trim();
  const commonDir = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  return { commonDir, ws: path.basename(root) };
}

/** `<jj repo>/store/git_target` points at the backing git dir, relative to the
 * `store/` directory that holds it. Absent for a non-git jj backend (native
 * store) — then there is no remote to read and `repo` stays empty. */
async function resolveJjGitDir(repoDir: string): Promise<string | undefined> {
  const storeDir = path.join(repoDir, "store");
  const target = (await readTextOrUndefined(path.join(storeDir, "git_target")))?.trim();
  if (!target) return undefined;
  return path.resolve(storeDir, target);
}

/** The branch name a git dir has checked out, from `HEAD`. A detached HEAD
 * (raw sha, no `ref:`) yields "" rather than a sha — a 40-hex string is not a
 * workspace label anyone reads. */
async function readHeadBranch(gitDir: string): Promise<string> {
  const head = (await readTextOrUndefined(path.join(gitDir, "HEAD")))?.trim();
  const ref = head?.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
  return ref?.trim() ?? "";
}

/** Remote selection, mirroring bump-semver's selectDefaultRemote: `origin`
 * wins; otherwise a lone remote is unambiguous; two or more without `origin`
 * are ambiguous and yield nothing. */
export function selectRemoteUrl(remotes: ReadonlyMap<string, string>): string {
  const origin = remotes.get("origin");
  if (origin) return origin;
  if (remotes.size === 1) return [...remotes.values()][0] ?? "";
  return "";
}

/** Minimal git-config reader: enough to answer `[remote "<name>"] url = ...`.
 * Section headers and `key = value` lines are the only shapes needed, and both
 * are stable across git versions. */
export function parseGitConfigRemotes(text: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = line.match(/^\[([^\]]*)\]$/)?.[1];
    if (header !== undefined) {
      section = header.match(/^remote\s+"(.+)"$/)?.[1] ?? "";
      continue;
    }
    if (section === "") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== "url") continue;
    const url = line.slice(eq + 1).trim();
    if (url !== "" && !remotes.has(section)) remotes.set(section, url);
  }
  return remotes;
}

/** The `owner/repo` slug of a forge remote URL (bump-semver's
 * normalizeRemoteURL, Slug half). Accepts scheme URLs (ssh/git/http/https) and
 * scp-style `[user@]host:path`; local filesystem remotes have no forge path and
 * yield "". */
export function remoteUrlSlug(raw: string): string {
  const url = raw.trim();
  if (url === "" || url.startsWith("/")) return "";
  let pathPart: string;
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "";
    }
    if (!["ssh:", "git:", "http:", "https:"].includes(parsed.protocol)) return "";
    pathPart = parsed.pathname;
  } else {
    const colon = url.indexOf(":");
    if (colon < 0) return "";
    const slash = url.indexOf("/");
    // git's own scp-vs-local rule: a '/' before the first ':' means a local
    // path with an incidental colon, and a single letter before ':' is a
    // Windows drive.
    if ((slash >= 0 && slash < colon) || (colon === 1 && /^[A-Za-z]$/.test(url[0] ?? "")))
      return "";
    pathPart = url.slice(colon + 1);
  }
  const slug = pathPart
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .replace(/^\//, "");
  return slug;
}

/** Path-convention fallback for a repo with no usable remote: kawaz's checkout
 * layout is `.../repos/<host>/<owner>/<repo>/...`, so a `repos/` segment
 * followed by a dotted host names the slug that the remote would have. */
export function slugFromCheckoutPath(root: string): string {
  const parts = path.resolve(root).split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "repos") continue;
    const [host, owner, repo] = [parts[i + 1], parts[i + 2], parts[i + 3]];
    if (host?.includes(".") && owner && repo) return `${owner}/${repo}`;
  }
  return "";
}

async function slugFromGitDir(gitDir: string | undefined, root: string): Promise<string> {
  if (gitDir) {
    const config = await readTextOrUndefined(path.join(gitDir, "config"));
    if (config !== undefined) {
      const slug = remoteUrlSlug(selectRemoteUrl(parseGitConfigRemotes(config)));
      if (slug !== "") return slug;
    }
  }
  return slugFromCheckoutPath(root);
}

/**
 * Best-effort `{repo, ws}` for a session that announced neither. Never throws;
 * anything unresolvable stays "".
 *
 * jj's default workspace reports no `ws`: its label would be the current
 * bookmark, which no file under `.jj` spells out (jj resolves it through the
 * op log), and the backing git store's `HEAD` does not track jj's working copy.
 * Secondary workspaces — what kawaz's layout actually checks out — carry their
 * name in the directory itself and resolve fine.
 */
export async function deriveRepoWs(cwd: string): Promise<DerivedRepoWs> {
  if (!cwd) return EMPTY;
  try {
    const found = await findRepoRoot(cwd);
    if (!found) return EMPTY;
    const { root, backend } = found;
    if (backend === "jj") {
      const jj = await resolveJjRepo(root);
      if (!jj) return EMPTY;
      const gitDir = await resolveJjGitDir(jj.repoDir);
      return { repo: await slugFromGitDir(gitDir, root), ws: jj.ws };
    }
    const git = await resolveGitDir(root);
    if (!git) return EMPTY;
    const ws = git.ws !== "" ? git.ws : await readHeadBranch(git.commonDir);
    return { repo: await slugFromGitDir(git.commonDir, root), ws };
  } catch {
    return EMPTY;
  }
}
