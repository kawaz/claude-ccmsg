// Deriving a session's location facts from its cwd: `repo`/`ws` for hellos
// that announce neither, and `repo_url`, `vcs`, `repository`, which no hello
// announces.
//
// The announced values ride the session state file `ccmsg sidecar begin`
// writes, which a session without it never gets — such sessions showed up in
// the webui's SESSIONS list with empty repo/ws columns. This module
// reproduces what begin's `bump-semver vcs get` calls would have reported,
// from the on-disk layout alone:
//
//   - `repo` = the origin remote URL's `owner/repo` slug (bump-semver's
//     `vcs get repository`, DR-0041), read out of the backing git config;
//   - `ws`   = the jj workspace / git linked-worktree directory name, falling
//     back to the checked-out branch when there is no workspace layer
//     (bump-semver's `worktree-name` else `current-branch`, per the CLI's
//     deriveWs);
//   - `repo_url` = the same remote as the forge's web page (`https://<host>/
//     <path>`), which the Status tab shows;
//   - `vcs` = which of jj / git the checkout is, its workspace / worktree name
//     alone (no branch fallback), the branch git's `HEAD` names, and every
//     remote of the git config with the credentials taken out of its URL;
//   - `repository` = the remote `repo_url` comes from, split into host, owner
//     and name.
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
//                          dir (where `config` lives) is `<gitdir>/commondir`,
//                          the worktree's `HEAD` is in `<gitdir>` itself
//
// Every failure degrades to "" (or an absent field) for the affected field.
// Nothing here throws, and a value is never invented: a repo with no forge
// remote and no recognizable path layout keeps an empty `repo` and no
// `repository` rather than a guess.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRepository, SessionVcs, SessionVcsRemote } from "@ccmsg/protocol";

export interface DerivedLocation {
  repo: string;
  ws: string;
  /** The repository's web page (remoteWebUrl), "" when unknown. */
  repo_url: string;
  /** Absent when the cwd is under no jj / git checkout. */
  vcs?: SessionVcs;
  /** Absent when neither the remote nor the checkout path names one. */
  repository?: SessionRepository;
}

const EMPTY: DerivedLocation = { repo: "", ws: "", repo_url: "" };

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

/** git dir resolution: the worktree's own git dir (the one holding its
 * `HEAD`), the *common* dir (the one holding `config`), plus the worktree name
 * (empty for the main worktree, whose two dirs are one). */
async function resolveGitDir(
  root: string,
): Promise<{ gitDir: string; commonDir: string; ws: string } | undefined> {
  const marker = path.join(root, ".git");
  const st = await statOrUndefined(marker);
  if (!st) return undefined;
  if (st.isDirectory()) return { gitDir: marker, commonDir: marker, ws: "" };
  const contents = (await readTextOrUndefined(marker))?.trim();
  const gitdirLine = contents?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdirLine) return undefined;
  const gitDir = path.resolve(root, gitdirLine);
  const commonRel = (await readTextOrUndefined(path.join(gitDir, "commondir")))?.trim();
  const commonDir = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  return { gitDir, commonDir, ws: path.basename(root) };
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

/** The web page of a forge remote URL: `https://<host>/<path>` with the
 * credentials, the `.git` suffix and a trailing `/` dropped, whatever the forge
 * (GitHub, GitLab, Bitbucket, a self-hosted one). ssh / git / scp-style remotes
 * keep only their host (their port is the ssh / git port, not the web one);
 * http(s) remotes keep their scheme and port. Local filesystem remotes and
 * anything unparsable yield "". An ssh config alias used as the host is passed
 * through as written: the alias is all the remote says. */
export function remoteWebUrl(raw: string): string {
  const page = remoteWebPage(raw);
  return page ? `${page.origin}/${page.path}` : "";
}

/** remoteWebUrl's parts: the page's origin (`https://<host>` or the http(s)
 * remote's own scheme and port), the host alone, and the path below it with
 * no leading or trailing `/`. Undefined where remoteWebUrl yields "". */
function remoteWebPage(raw: string): { origin: string; host: string; path: string } | undefined {
  const url = raw.trim();
  if (url === "" || url.startsWith("/")) return undefined;
  let origin: string;
  let host: string;
  let pathPart: string;
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      origin = `${parsed.protocol}//${parsed.host}`;
    } else if (parsed.protocol === "ssh:" || parsed.protocol === "git:") {
      origin = `https://${parsed.hostname}`;
    } else {
      return undefined;
    }
    if (parsed.hostname === "") return undefined;
    host = parsed.hostname;
    pathPart = parsed.pathname;
  } else {
    const colon = url.indexOf(":");
    if (colon < 0) return undefined;
    const slash = url.indexOf("/");
    // The same scp-vs-local rule as remoteUrlSlug.
    if ((slash >= 0 && slash < colon) || (colon === 1 && /^[A-Za-z]$/.test(url[0] ?? "")))
      return undefined;
    host = url.slice(0, colon).replace(/^[^@]*@/, "");
    if (host === "") return undefined;
    origin = `https://${host}`;
    pathPart = url.slice(colon + 1);
  }
  const rest = pathPart
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .replace(/^\//, "");
  return rest === "" ? undefined : { origin, host, path: rest };
}

/** The forge repository a remote URL names: remoteWebUrl's page, its path
 * split at the last `/` into owner and name. Undefined when remoteWebUrl
 * yields "" or the path has no owner segment. */
export function remoteRepository(raw: string): SessionRepository | undefined {
  const page = remoteWebPage(raw);
  if (!page) return undefined;
  const cut = page.path.lastIndexOf("/");
  const owner = page.path.slice(0, cut);
  const name = page.path.slice(cut + 1);
  if (cut < 0 || owner === "" || name === "") return undefined;
  return { host: page.host, owner, name, url: `${page.origin}/${page.path}` };
}

/** A remote URL as it may be shown: the userinfo of a scheme URL dropped
 * (`https://user:token@host/…` → `https://host/…`), except that an `ssh`
 * scheme (`ssh://`, `git+ssh://`, `ssh+git://`) keeps the user name, the
 * login on the host, and loses only a password. scp-style `user@host:path`
 * and local paths have no slot for a secret and stay as written. */
export function remoteUrlWithoutCredentials(raw: string): string {
  const url = raw.trim();
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (!scheme) return url;
  const authorityStart = scheme[0].length;
  const rest = url.slice(authorityStart);
  const authorityLength = rest.search(/[/?#]/);
  const authority = authorityLength < 0 ? rest : rest.slice(0, authorityLength);
  const at = authority.lastIndexOf("@");
  if (at < 0) return url;
  const user = authority.slice(0, at).split(":")[0] ?? "";
  const keep = /(^|\+)ssh(\+|$)/i.test(scheme[1] ?? "") && user !== "" ? `${user}@` : "";
  return `${url.slice(0, authorityStart)}${keep}${rest.slice(at + 1)}`;
}

/** Every remote of a git config, in its order, as `vcs.remotes` carries them. */
function vcsRemotes(remotes: ReadonlyMap<string, string>): SessionVcsRemote[] {
  return [...remotes].map(([name, url]) => ({ name, url: remoteUrlWithoutCredentials(url) }));
}

/** Path-convention fallback for a repo with no usable remote: kawaz's checkout
 * layout is `.../repos/<host>/<owner>/<repo>/...`, so a `repos/` segment
 * followed by a dotted host names the repository that the remote would have,
 * its page being `https://<host>/<owner>/<repo>`. */
export function repositoryFromCheckoutPath(root: string): SessionRepository | undefined {
  const parts = path.resolve(root).split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "repos") continue;
    const [host, owner, name] = [parts[i + 1], parts[i + 2], parts[i + 3]];
    if (host?.includes(".") && owner && name)
      return { host, owner, name, url: `https://${host}/${owner}/${name}` };
  }
  return undefined;
}

/** The slug the same path convention names. */
export function slugFromCheckoutPath(root: string): string {
  const found = repositoryFromCheckoutPath(root);
  return found ? `${found.owner}/${found.name}` : "";
}

/** The page the same path convention names. */
export function webUrlFromCheckoutPath(root: string): string {
  return repositoryFromCheckoutPath(root)?.url ?? "";
}

/** The remotes of the git config in `gitDir`, none when there is no such dir
 * or config. */
async function readRemotes(gitDir: string | undefined): Promise<Map<string, string>> {
  if (!gitDir) return new Map();
  const config = await readTextOrUndefined(path.join(gitDir, "config"));
  return config !== undefined ? parseGitConfigRemotes(config) : new Map();
}

/** `repo`, `repo_url` and `repository` of a checkout: from its remote first,
 * the checkout path's convention for whichever the remote could not give. */
function repoFromRemotes(
  remotes: ReadonlyMap<string, string>,
  root: string,
): Pick<DerivedLocation, "repo" | "repo_url" | "repository"> {
  const remote = selectRemoteUrl(remotes);
  const slug = remoteUrlSlug(remote);
  const webUrl = remoteWebUrl(remote);
  const repository = remoteRepository(remote) ?? repositoryFromCheckoutPath(root);
  return {
    repo: slug !== "" ? slug : slugFromCheckoutPath(root),
    repo_url: webUrl !== "" ? webUrl : webUrlFromCheckoutPath(root),
    ...(repository ? { repository } : {}),
  };
}

/**
 * Best-effort location facts of a cwd. Never throws; anything unresolvable
 * stays "" or absent.
 *
 * jj's default workspace reports no `ws` and no `vcs.workspace` / `vcs.branch`:
 * its label would be the current bookmark, which no file under `.jj` spells
 * out (jj resolves it through the op log), and the backing git store's `HEAD`
 * does not track jj's working copy. Secondary workspaces — what kawaz's layout
 * actually checks out — carry their name in the directory itself and resolve
 * fine.
 */
export async function deriveLocation(cwd: string): Promise<DerivedLocation> {
  if (!cwd) return EMPTY;
  try {
    const found = await findRepoRoot(cwd);
    if (!found) return EMPTY;
    const { root, backend } = found;
    if (backend === "jj") {
      const jj = await resolveJjRepo(root);
      if (!jj) return EMPTY;
      const remotes = await readRemotes(await resolveJjGitDir(jj.repoDir));
      return {
        ...repoFromRemotes(remotes, root),
        ws: jj.ws,
        vcs: {
          type: "jj",
          ...(jj.ws !== "" ? { workspace: jj.ws } : {}),
          remotes: vcsRemotes(remotes),
        },
      };
    }
    const git = await resolveGitDir(root);
    if (!git) return EMPTY;
    const branch = await readHeadBranch(git.gitDir);
    const remotes = await readRemotes(git.commonDir);
    return {
      ...repoFromRemotes(remotes, root),
      ws: git.ws !== "" ? git.ws : branch,
      vcs: {
        type: "git",
        ...(git.ws !== "" ? { workspace: git.ws } : {}),
        ...(branch !== "" ? { branch } : {}),
        remotes: vcsRemotes(remotes),
      },
    };
  } catch {
    return EMPTY;
  }
}
