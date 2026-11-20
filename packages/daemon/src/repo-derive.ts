// Deriving a session's location facts from its cwd: `vcs` and `repository`,
// which no hello announces (DR-0003 §3):
//
//   - `vcs` = which of jj / git the checkout is, its workspace / worktree name
//     alone (no branch fallback), the branch git's `HEAD` names, and every
//     remote of the git config with the credentials taken out of its URL;
//   - `repository` = the origin remote (else the only remote) split into host,
//     owner and name, with the forge's web page of it (`https://<host>/
//     <path>`), which the Status tab and the Timeline link to.
//
// Design rationale: no subprocess. `ccmsg sidecar begin` can afford
// `bump-semver` because it runs on kawaz's machine where the binary exists;
// the daemon serves sessions whose environment it does not control, and a
// hello must not block on a spawn that may not resolve. Every fact needed here is a small file read:
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
// Every failure leaves the affected field absent.
// Nothing here throws, and a value is never invented: a repo with no forge
// remote and no recognizable path layout has no `repository` rather than a
// guess.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRepository, SessionVcs, SessionVcsRemote } from "@ccmsg/protocol";

export interface DerivedLocation {
  /** Absent when the cwd is under no jj / git checkout. */
  vcs?: SessionVcs;
  /** Absent when neither the remote nor the checkout path names one. */
  repository?: SessionRepository;
}

const EMPTY: DerivedLocation = {};

/** The two reads the derivation makes of the checkout's files: a stat and a
 * text read, each undefined for a path that is not there or cannot be read. */
export interface LocationIo {
  stat(p: string): Promise<fs.Stats | undefined>;
  read(p: string): Promise<string | undefined>;
}

const FS_IO: LocationIo = {
  stat: async (p) => {
    try {
      return await fs.promises.stat(p);
    } catch {
      return undefined;
    }
  },
  read: async (p) => {
    try {
      return await fs.promises.readFile(p, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** One read of the derivation: which, of what path, and how long it took. */
export interface LocationRead {
  op: "stat" | "read";
  path: string;
  ms: number;
}

/** The file system's reads, each recorded in `reads` with the time it took:
 * for a caller that says where a slow derivation spent its time. */
export function timedLocationIo(reads: LocationRead[]): LocationIo {
  const timed =
    <T>(op: LocationRead["op"], read: (p: string) => Promise<T>) =>
    async (p: string): Promise<T> => {
      const started = performance.now();
      try {
        return await read(p);
      } finally {
        reads.push({ op, path: p, ms: performance.now() - started });
      }
    };
  return {
    stat: timed("stat", (p) => FS_IO.stat(p)),
    read: timed("read", (p) => FS_IO.read(p)),
  };
}

/** Walks `dir` and its ancestors for a `.jj` / `.git` marker, stopping at the
 * first directory carrying either (jj wins when both sit at the same level —
 * DR-0008's precedence, and the layout kawaz's repos use: a git bare store next
 * to the jj repo). */
async function findRepoRoot(
  dir: string,
  io: LocationIo,
): Promise<{ root: string; backend: "jj" | "git" } | undefined> {
  let current = path.resolve(dir);
  for (;;) {
    if (await io.stat(path.join(current, ".jj"))) return { root: current, backend: "jj" };
    if (await io.stat(path.join(current, ".git"))) return { root: current, backend: "git" };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `.jj/repo` resolution: the directory holding the jj repo's own state, plus
 * the workspace name (empty for the default workspace, whose `.jj/repo` IS that
 * directory). */
async function resolveJjRepo(
  root: string,
  io: LocationIo,
): Promise<{ repoDir: string; workspace: string } | undefined> {
  const marker = path.join(root, ".jj", "repo");
  const st = await io.stat(marker);
  if (!st) return undefined;
  if (st.isDirectory()) return { repoDir: marker, workspace: "" };
  const target = (await io.read(marker))?.trim();
  if (!target) return undefined;
  return {
    repoDir: path.resolve(path.dirname(marker), target),
    workspace: path.basename(root),
  };
}

/** git dir resolution: the worktree's own git dir (the one holding its
 * `HEAD`), the *common* dir (the one holding `config`), plus the worktree name
 * (empty for the main worktree, whose two dirs are one). */
async function resolveGitDir(
  root: string,
  io: LocationIo,
): Promise<{ gitDir: string; commonDir: string; workspace: string } | undefined> {
  const marker = path.join(root, ".git");
  const st = await io.stat(marker);
  if (!st) return undefined;
  if (st.isDirectory()) return { gitDir: marker, commonDir: marker, workspace: "" };
  const contents = (await io.read(marker))?.trim();
  const gitdirLine = contents?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!gitdirLine) return undefined;
  const gitDir = path.resolve(root, gitdirLine);
  const commonRel = (await io.read(path.join(gitDir, "commondir")))?.trim();
  const commonDir = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
  return { gitDir, commonDir, workspace: path.basename(root) };
}

/** `<jj repo>/store/git_target` points at the backing git dir, relative to the
 * `store/` directory that holds it. Absent for a non-git jj backend (native
 * store) — then there is no remote to read. */
async function resolveJjGitDir(repoDir: string, io: LocationIo): Promise<string | undefined> {
  const storeDir = path.join(repoDir, "store");
  const target = (await io.read(path.join(storeDir, "git_target")))?.trim();
  if (!target) return undefined;
  return path.resolve(storeDir, target);
}

/** The branch name a git dir has checked out, from `HEAD`. A detached HEAD
 * (raw sha, no `ref:`) yields "" rather than a sha — a 40-hex string is not a
 * workspace label anyone reads. */
async function readHeadBranch(gitDir: string, io: LocationIo): Promise<string> {
  const head = (await io.read(path.join(gitDir, "HEAD")))?.trim();
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

/** The web page of a forge remote URL, in parts: the page's origin
 * (`https://<host>`, or an http(s) remote's own scheme and port), the host
 * alone, and the path below it with no leading or trailing `/`, the
 * credentials, the `.git` suffix and a trailing `/` dropped, whatever the
 * forge (GitHub, GitLab, Bitbucket, a self-hosted one). ssh / git /
 * scp-style remotes keep only their host (their port is the ssh / git port,
 * not the web one). An ssh config alias used as the host is passed through as
 * written: the alias is all the remote says. Undefined for local filesystem
 * remotes and anything unparsable. */
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
    // git's own scp-vs-local rule: a '/' before the first ':' means a local
    // path with an incidental colon, and a single letter before ':' is a
    // Windows drive.
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

/** The forge repository a remote URL names: remoteWebPage's page, its path
 * split at the last `/` into owner and name. Undefined when there is no page
 * or the path has no owner segment. */
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

/** The remotes of the git config in `gitDir`, none when there is no such dir
 * or config. */
async function readRemotes(
  gitDir: string | undefined,
  io: LocationIo,
): Promise<Map<string, string>> {
  if (!gitDir) return new Map();
  const config = await io.read(path.join(gitDir, "config"));
  return config !== undefined ? parseGitConfigRemotes(config) : new Map();
}

/** The `repository` of a checkout: from its remote first, else the checkout
 * path's convention. */
function repoFromRemotes(
  remotes: ReadonlyMap<string, string>,
  root: string,
): Pick<DerivedLocation, "repository"> {
  const repository = remoteRepository(selectRemoteUrl(remotes)) ?? repositoryFromCheckoutPath(root);
  return repository ? { repository } : {};
}

/**
 * Best-effort location facts of a cwd. Never throws; anything unresolvable
 * stays "" or absent.
 *
 * jj's default workspace reports no `vcs.workspace` / `vcs.branch`: its
 * branch would be the current bookmark, which no file under `.jj` spells
 * out (jj resolves it through the op log), and the backing git store's `HEAD`
 * does not track jj's working copy. Secondary workspaces — what kawaz's layout
 * actually checks out — carry their name in the directory itself and resolve
 * fine.
 *
 * `io` makes the reads (the file system's by default; timedLocationIo to
 * know where the time went).
 */
export async function deriveLocation(
  cwd: string,
  io: LocationIo = FS_IO,
): Promise<DerivedLocation> {
  if (!cwd) return EMPTY;
  try {
    const found = await findRepoRoot(cwd, io);
    if (!found) return EMPTY;
    const { root, backend } = found;
    if (backend === "jj") {
      const jj = await resolveJjRepo(root, io);
      if (!jj) return EMPTY;
      const remotes = await readRemotes(await resolveJjGitDir(jj.repoDir, io), io);
      return {
        ...repoFromRemotes(remotes, root),
        vcs: {
          type: "jj",
          ...(jj.workspace !== "" ? { workspace: jj.workspace } : {}),
          remotes: vcsRemotes(remotes),
        },
      };
    }
    const git = await resolveGitDir(root, io);
    if (!git) return EMPTY;
    const branch = await readHeadBranch(git.gitDir, io);
    const remotes = await readRemotes(git.commonDir, io);
    return {
      ...repoFromRemotes(remotes, root),
      vcs: {
        type: "git",
        ...(git.workspace !== "" ? { workspace: git.workspace } : {}),
        ...(branch !== "" ? { branch } : {}),
        remotes: vcsRemotes(remotes),
      },
    };
  } catch {
    return EMPTY;
  }
}
