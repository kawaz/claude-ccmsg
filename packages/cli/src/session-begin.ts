// `ccmsg sidecar begin`: what a session's start (and a change of its id, on
// /clear or /resume) leaves for the CLI and the daemon. The hooks module runs
// it from `session.start` and from `command.run` (DR-0039 §2):
//   (a) a per-session state file (`<stateDir>/sessions/<sid>.json`) carrying
//       cwd/repo/ws/repo_root/branch, which every CLI hello of the session
//       reads to name it;
//   (b) the daemon, brought up if none is running, so the web UI is live and
//       can put its posts into the session.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionStateFile } from "@ccmsg/protocol";

/** Raw VCS facts `getRepoWsFromVcs` reads via `bump-semver vcs get <key>`, and
 *  the input to the pure `deriveWs`/`deriveRepoRoot` below. Empty string means
 *  "the getter ran but had nothing to report" (e.g. main worktree/workspace,
 *  or a bookmark/branch that couldn't be resolved) — distinct from "the
 *  getter failed", which callers collapse to empty before this point. */
export interface VcsFacts {
  backend: string; // "git" | "jj" (or "" if undetected)
  root: string; // absolute repo/workspace root; "" if not in a VCS repo
  worktreeName: string; // linked worktree (git) / named workspace (jj); "" for the main one
  currentBranch: string; // current branch/bookmark; "" if unresolvable (detached HEAD, ambiguous bookmarks, ...)
}

/**
 * Derives `ws` from `bump-semver vcs get` facts: prefers the worktree/workspace
 * name; falls back to the current branch/bookmark only when there's no
 * workspace layer to report (kawaz's "workspace name if present, else branch
 * name" priority). Never throws; `root === ""` (no VCS facts available)
 * short-circuits to `""`.
 *
 * `repo` is NOT derived here — unlike `ws`/`repoRoot`, it no longer comes from
 * parsing `root`'s path (basename/dirname heuristics that differed by backend
 * and, for a git linked worktree, had no way back to the true repo name — see
 * `deriveRepoRoot`'s doc for why that path-based container lookup remains
 * git-limited). `getRepoWsFromVcs` below sources `repo` straight from
 * `bump-semver vcs get repository` (the remote URL's owner/repo slug, DR-0041)
 * instead: a single value shared across every worktree/workspace of a repo,
 * with no backend-specific parsing needed.
 *
 * Design rationale: the `bump-semver` dependency is deliberate, kawaz-environment-
 * specific tooling (it's already on kawaz's PATH everywhere ccmsg runs). If this
 * plugin is ever distributed more broadly, a from-scratch fallback (`git
 * rev-parse --show-toplevel` / `jj workspace root`, etc.) should be built in
 * rather than assuming the binary exists — `getRepoWsFromVcs` below already
 * degrades to `{ repo: "", ws: "", ... }` when it's absent, so nothing breaks
 * in the meantime, it just loses the repo/ws enrichment.
 */
export function deriveWs(vcs: VcsFacts): string {
  if (vcs.root === "") return "";
  return vcs.worktreeName !== "" ? vcs.worktreeName : vcs.currentBranch;
}

/**
 * Derives `repo_root` (DR-0008 addendum): the absolute path of the container
 * directory holding ALL of a repo's workspaces, for the daemon's fs_list/
 * fs_read containment root to widen to (sibling workspaces become browsable)
 * instead of staying pinned to this session's own cwd.
 *
 * Restricted to jj with a named workspace: kawaz's jj repos always nest a
 * named workspace exactly one level under the repo dir (`<repo>/<ws>`), so
 * `dirname(root)` IS that container and nothing wider — verified real-machine
 * for this repo. git is deliberately excluded even though `worktreeName` is
 * non-empty for linked worktrees: a git linked worktree's `root` is the
 * worktree dir itself, sitting as a sibling of *every other repo* under the
 * owner directory (verified: `github.com/kawaz/mermaid-aa-pr1` sits directly
 * among dozens of unrelated repos, not nested under a `mermaid-aa` container)
 * — `dirname(root)` there would widen fs_list/fs_read to "all of the owner's
 * repos", not "this repo's worktrees". Determining the true git worktree
 * container needs corroboration from `git worktree list` (which repo a
 * worktree belongs to), not deducible from `root` alone — deferred as a known
 * limitation until that lookup is added; for now git always reports "".
 */
export function deriveRepoRoot(vcs: VcsFacts): string {
  if (vcs.root === "" || vcs.backend !== "jj" || vcs.worktreeName === "") return "";
  return path.dirname(vcs.root);
}

export interface VcsRepoWsOptions {
  /** overrides the `bump-semver` binary looked up on PATH (test seam, mirrors
   *  CCMSG_TAILSCALE_BIN's precedent in packages/daemon/src/server.ts). */
  bin?: string;
  timeoutMs?: number;
}

/** Races a subprocess's (stdout, exit code) against a deadline. `Bun.spawn`'s
 *  own `signal` option was tried first and doesn't reliably bound this: it
 *  kills the direct child, but a shell-wrapped hang (e.g. `sh -c 'sleep 10'`,
 *  observed with a test fixture written that way) leaves its own child alive
 *  holding the stdout pipe open, so `Response.text()` never resolves even
 *  after the signal fires (verified: the process — not just the awaited
 *  promise — hangs past the timeout). Racing a `setTimeout` and calling
 *  `proc.kill()` on the loser bounds the *caller's* wait regardless of
 *  whether the killed subprocess actually exits.
 *
 *  Bounding the caller's wait is not the same as bounding the process, though,
 *  and both loose ends here were costing wall time long after this function
 *  returned (measured: a lookup that answered in 87ms left the process alive
 *  until 1003ms on the uncleared timer, and a stand-in that ignores SIGTERM
 *  kept it alive until 8328ms on the abandoned read):
 *
 *  - the losing timer has to be cleared, or it holds the event loop until the
 *    full `remainingMs` even when the subprocess answered immediately;
 *  - `kill()` only signals, so on the timeout path the read of the child's
 *    stdout has to be cancelled and the subprocess handle unref'd, or a child
 *    that outlives the signal keeps the loop alive for as long as it runs.
 *
 *  Reading through an explicit reader rather than `new Response(proc.stdout)`
 *  is what makes that cancellation possible: `Response` locks the stream, and a
 *  locked stream cannot be cancelled. */
async function raceExit(
  proc: Bun.Subprocess<"ignore", "pipe", "ignore">,
  remainingMs: number,
): Promise<{ stdout: string; exitCode: number } | undefined> {
  const TIMED_OUT = Symbol("timed-out");
  const reader = proc.stdout.getReader();
  const readAll = async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.all([readAll(), proc.exited]).then(
      ([stdout, exitCode]) => ({ stdout, exitCode }) as const,
    ),
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
    }),
  ]);
  clearTimeout(timer);
  if (result === TIMED_OUT) {
    proc.kill();
    await reader.cancel().catch(() => {});
    proc.unref();
    return undefined;
  }
  return result;
}

/** Best-effort: runs `bump-semver vcs get <key>` (backend, root, worktree-name,
 *  current-branch, repository) in `cwd`, then folds backend/root/worktree-name/
 *  current-branch through `deriveWs`/`deriveRepoRoot` while `repository`'s raw
 *  slug becomes `repo` directly (see `deriveWs`'s doc for why `repo` is no
 *  longer path-derived). Binary absent, `cwd` outside any VCS repo, a
 *  subprocess error, or exceeding `timeoutMs` (default 1000ms — a shared
 *  deadline across every call, so a slow first call leaves less budget for
 *  the rest rather than each call getting its own fresh 1000ms) all collapse
 *  to `{ repo: "", ws: "", repoRoot: "", branch: "" }` — this must never
 *  throw or hold the session's start up over a "?" fallback.
 *
 *  `repository` failing on its own (no forge remote configured, ambiguous
 *  remote selection — bump-semver exit 3/4) degrades only `repo` to "",
 *  independent of whether backend/root/worktree-name/current-branch
 *  succeeded — a repo with no `origin` remote still gets ws/repoRoot/branch. */
export async function getRepoWsFromVcs(
  cwd: string,
  opts: VcsRepoWsOptions = {},
): Promise<{ repo: string; ws: string; repoRoot: string; branch: string }> {
  const bin = opts.bin ?? "bump-semver";
  const deadline = Date.now() + (opts.timeoutMs ?? 1000);

  const runGet = async (key: string): Promise<string | undefined> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return undefined;
    try {
      const proc = Bun.spawn([bin, "vcs", "get", key, "--no-hint"], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const result = await raceExit(proc, remainingMs);
      if (result === undefined || result.exitCode !== 0) return undefined;
      return result.stdout.trim();
    } catch {
      return undefined;
    }
  };

  const backend = await runGet("backend");
  const root = await runGet("root");
  if (backend === undefined || root === undefined || root === "")
    return { repo: "", ws: "", repoRoot: "", branch: "" };
  const worktreeName = (await runGet("worktree-name")) ?? "";
  const currentBranch = (await runGet("current-branch")) ?? "";
  const repository = (await runGet("repository")) ?? "";
  const facts: VcsFacts = { backend, root, worktreeName, currentBranch };
  return {
    repo: repository,
    ws: deriveWs(facts),
    repoRoot: deriveRepoRoot(facts),
    branch: currentBranch,
  };
}

/** `CCMSG_BUMP_SEMVER_BIN` overrides the `bump-semver` binary looked up on
 *  PATH (test seam). */
export function resolveBumpSemverBin(): string {
  return process.env.CCMSG_BUMP_SEMVER_BIN ?? "bump-semver";
}

// --- session state file (cwd/repo/ws handoff to the CLI) ---
//
// Identity-related fields the CLI's resolveIdentity wants (repo/ws/cwd) ride
// through this file, so no command the AI runs needs an env prefix for them.

/** Absolute path of the per-session state file. */
export function sessionFilePath(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.json`);
}

/** Best-effort write (mkdir -p + overwrite); failures (unwritable stateDir, races,
 *  ...) are swallowed — the state file is an enrichment for hello, never a hard
 *  dependency for the session or the CLI to function. */
export function writeSessionFile(stateDir: string, sid: string, data: SessionStateFile): void {
  try {
    const file = sessionFilePath(stateDir, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // best-effort
  }
}

const SESSION_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Best-effort GC for `<stateDir>/sessions/*.json`: nothing removes a
 *  session's file when the session ends (a process that dies says nothing), so
 *  left unchecked they'd accumulate forever (one file per sid). Age is judged
 *  by mtime (the last `sidecar begin` write), not by whether the session is
 *  still alive, so a stale entry survives at most ~30 days past its last
 *  begin. Missing sessions/ dir, unreadable dir, or a single file's
 *  stat/unlink failing are all swallowed — this must never be the thing that
 *  breaks a session start. */
export function pruneOldSessionFiles(stateDir: string, now: number = Date.now()): void {
  const dir = path.join(stateDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet, or unreadable — nothing to prune
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > SESSION_FILE_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // best-effort per-file
    }
  }
}
