#!/usr/bin/env bun
/**
 * SessionStart hook.
 *
 * Four jobs:
 *   (a) Wake the central daemon by going through the *same* ensure-daemon path
 *       every client uses — we shell out to the launcher (`ccmsg peers`) rather
 *       than importing daemon internals, so the hook depends only on the public
 *       `bin/ccmsg` contract. Blocking on it also lets the spawned daemon reparent
 *       to init before this hook exits, so a hook process-group teardown won't take
 *       the daemon with it (and if it ever does, the next ensure — subscribe's own —
 *       respawns it, DR-0002 §5). (DR-0002 §2)
 *   (b) Write a per-session state file (`<stateDir>/sessions/<sid>.json`) carrying
 *       transcript_path/cwd/repo/ws, for the CLI's resolveIdentity to pick up at
 *       hello time. This replaces an earlier approach of embedding these as env
 *       prefixes (CCMSG_TRANSCRIPT_PATH/CCMSG_REPO/CCMSG_WS) on the suggested
 *       subscribe command: that made every session's *first* turn re-teach the AI
 *       a long, ever-growing command line purely for the daemon's benefit. A state
 *       file the CLI reads on its own keeps the suggested command down to
 *       `CCMSG_SID=<sid> ccmsg subscribe` regardless of how much identity metadata
 *       accumulates (kawaz decision, 2026-07-11).
 *   (c) Tell the AI to hold a `ccmsg subscribe` stream open under the Monitor tool.
 *       (DR-0002 §2)
 *   (d) When PATH has no `ccmsg` but a stable, writable candidate dir does, tell
 *       the AI to ask the user (AskUserQuestion) whether to symlink one in.
 *       The hook itself never writes the symlink or the decline marker — only
 *       detects and instructs; the AI performs the confirmed action. (DR-0007 §1)
 *
 * Failure here never blocks the turn: parse errors and ensure failures exit 0 quietly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePaths } from "@ccmsg/protocol";

interface SessionStartInput {
  session_id?: string;
  source?: string;
  /** absolute path of this session's Claude Code transcript jsonl, per Claude
   *  Code's SessionStart hook input schema (DR-0009). */
  transcript_path?: string;
  /** event-time cwd, present on SessionStart/UserPromptSubmit/PreToolUse/Stop
   *  per the hooks common-field table. Not necessarily this hook process's own
   *  cwd (verified to diverge from it), so repo/ws derivation must read this
   *  field rather than call process.cwd(). */
  cwd?: string;
}

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
 *  whether the killed subprocess actually exits. */
async function raceExit(
  proc: Bun.Subprocess<"ignore", "pipe", "ignore">,
  remainingMs: number,
): Promise<{ stdout: string; exitCode: number } | undefined> {
  const TIMED_OUT = Symbol("timed-out");
  const result = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
      ([stdout, exitCode]) => ({ stdout, exitCode }) as const,
    ),
    new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), remainingMs)),
  ]);
  if (result === TIMED_OUT) {
    proc.kill();
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
 *  throw or delay the hook's turn over a "?" fallback.
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
 *  PATH (test seam); shared with user-prompt-submit.ts's nag path so both
 *  hooks resolve the same way. */
export function resolveBumpSemverBin(): string {
  return process.env.CCMSG_BUMP_SEMVER_BIN ?? "bump-semver";
}

// --- session state file (transcript_path/cwd/repo/ws handoff to the CLI) ---
//
// The suggested subscribe command only ever carries CCMSG_SID (see
// buildSubscribeCommand below) — everything else identity-related that the CLI's
// resolveIdentity wants (transcript_path/repo/ws) rides through this file instead,
// so the command the AI re-types every session stays short regardless of how much
// metadata accumulates.

/** Shape written by this hook / user-prompt-submit.ts, and read by
 *  packages/cli/src/index.ts's resolveIdentity. All fields but `updated_at` are
 *  optional because any of them may be undiscoverable (no cwd from stdin, no VCS
 *  facts, no transcript_path announced) without that being an error. */
export interface SessionFileData {
  transcript_path?: string;
  cwd?: string;
  repo?: string;
  ws?: string;
  /** absolute path of the repo container holding all workspaces/worktrees
   *  (DR-0008 addendum); see deriveRepoRoot's doc for when this is present. */
  repo_root?: string;
  /** current branch/bookmark of the session's checkout (informational, for
   *  the webui session list); absent when detached or unresolvable. */
  branch?: string;
  updated_at: string;
}

/** Absolute path of the per-session state file. packages/cli/src/index.ts computes
 *  this same path independently (a shared protocol-level helper was considered but
 *  deferred to keep this change's footprint to hooks/ + the CLI's own file — see
 *  the delegation report for the tradeoff). */
export function sessionFilePath(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.json`);
}

/** Best-effort write (mkdir -p + overwrite); failures (unwritable stateDir, races,
 *  ...) are swallowed — the state file is an enrichment for hello, never a hard
 *  dependency for the hook or the CLI to function. */
export function writeSessionFile(stateDir: string, sid: string, data: SessionFileData): void {
  try {
    const file = sessionFilePath(stateDir, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // best-effort
  }
}

const SESSION_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Best-effort GC for `<stateDir>/sessions/*.json`: a session ends when the Claude
 *  Code process exits, which fires no hook — nothing else ever removes these, so
 *  left unchecked they'd accumulate forever (one file per sid, forever). Age is
 *  judged by mtime (last SessionStart/UserPromptSubmit write), not by whether the
 *  session is still alive, so a stale entry survives at most ~30 days past its
 *  last hook fire. Missing sessions/ dir, unreadable dir, or a single file's
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

/**
 * Builds the `ccmsg subscribe` command line suggested to the AI. Only carries
 * CCMSG_SID (from `session_id`) — transcript_path/repo/ws used to ride along as
 * further env prefixes (CCMSG_TRANSCRIPT_PATH/CCMSG_REPO/CCMSG_WS) but that grew
 * the suggested command every time DR-0009-style metadata was added; they're now
 * handed off via the session state file instead (see writeSessionFile) and read
 * by the CLI's own resolveIdentity, so this command stays short.
 */
export function buildSubscribeCommand(bin: string, sessionId: string | undefined): string {
  const sidPrefix = sessionId ? `CCMSG_SID=${sessionId} ` : "";
  return `${sidPrefix}${bin} subscribe`;
}

/** Absolute path to the launcher, robust to a missing CLAUDE_PLUGIN_ROOT. */
function resolveBin(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
  return path.join(root, "bin", "ccmsg");
}

// --- PATH install candidate detection (DR-0007 §1) --------------------------
//
// Candidates in priority order: ~/.local/bin, then ~/bin. Exported (and
// parameterized on pathEnv/home/stateDir rather than reading process.env
// directly) so the branch logic is unit-testable without touching the real
// filesystem/PATH.

/** Stable bin dirs to consider for the PATH symlink, in priority order. */
export function candidateBinDirs(home: string): string[] {
  return [path.join(home, ".local", "bin"), path.join(home, "bin")];
}

function pathDirs(pathEnv: string | undefined): string[] {
  return (pathEnv ?? "").split(path.delimiter).filter((s) => s !== "");
}

/** True iff some PATH dir has an entry named `ccmsg` (symlink or regular file). */
function hasCcmsgOnPath(dirs: string[]): boolean {
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, "ccmsg"));
      return true;
    } catch {
      return false;
    }
  });
}

/** True iff `dir` exists, is a directory, and is writable by this process. */
function isWritableDir(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PathInstallCandidate {
  dir: string;
  binPath: string; // dir/ccmsg
}

/** Absolute path of the decline marker inside `stateDir` (DR-0007 §1). */
export function declineMarkerPath(stateDir: string): string {
  return path.join(stateDir, "path-install-declined");
}

/**
 * Returns the PATH-install candidate iff every DR-0007 §1 condition holds:
 * PATH has no `ccmsg` entry, PATH contains a writable stable dir (priority
 * order from candidateBinDirs), and the user hasn't previously declined.
 * Returns null (silently) otherwise — this must never be the thing that adds
 * noise to a session that already has ccmsg on PATH or already said no.
 */
export function detectPathInstallCandidate(
  pathEnv: string | undefined,
  home: string,
  stateDir: string,
): PathInstallCandidate | null {
  const dirs = pathDirs(pathEnv);
  if (hasCcmsgOnPath(dirs)) return null;
  if (fs.existsSync(declineMarkerPath(stateDir))) return null;

  for (const cand of candidateBinDirs(home)) {
    if (dirs.includes(cand) && isWritableDir(cand)) {
      return { dir: cand, binPath: path.join(cand, "ccmsg") };
    }
  }
  return null;
}

async function main(): Promise<void> {
  let input: SessionStartInput;
  try {
    input = JSON.parse(await Bun.stdin.text()) as SessionStartInput;
  } catch {
    // Non-JSON stdin: nothing to do, stay silent.
    process.exit(0);
  }

  const bin = resolveBin();
  const stateDir = resolvePaths().stateDir;

  // (a) Ensure the daemon is up. `peers` is a read-only op that flows through
  // ensure-daemon (connect -> spawn+upgrade if needed). Output is discarded; a
  // slow/failed spawn is capped by the timeout and never fails the session.
  try {
    Bun.spawnSync({
      cmd: [bin, "peers"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
  } catch {
    // best-effort warm-up
  }

  // (b) Write this session's state file (transcript_path/cwd/repo/ws) for the CLI
  // to pick up at hello time (see the module header). Always overwrite (unlike
  // UserPromptSubmit's "only if missing" — this is the fresh, authoritative source
  // per session start, e.g. a `/cd` or `claude --resume` should refresh it).
  if (input.session_id) {
    const { repo, ws, repoRoot, branch } = input.cwd
      ? await getRepoWsFromVcs(input.cwd, { bin: resolveBumpSemverBin() })
      : { repo: "", ws: "", repoRoot: "", branch: "" };
    writeSessionFile(stateDir, input.session_id, {
      ...(input.transcript_path ? { transcript_path: input.transcript_path } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(repo ? { repo } : {}),
      ...(ws ? { ws } : {}),
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      ...(branch ? { branch } : {}),
      updated_at: new Date().toISOString(),
    });
  }
  pruneOldSessionFiles(stateDir);

  // (c) Guide the AI. subscribe is a long-running blocking stream, so it must run
  // under the Monitor tool (persistent), never the Bash tool.
  //
  // CCMSG_SID must be embedded in the suggested command: CLAUDE_CODE_SESSION_ID
  // is not reliably exported to the Bash/Monitor subprocess environment, so
  // without it the subscribe would silently hello as the User (u1) — no peers
  // entry, no echo suppression. The hook is the one place that reliably knows
  // session_id.
  const subscribeCmd = buildSubscribeCommand(bin, input.session_id);
  const contextLines = [
    "ccmsg is available: file-backed messaging between Claude Code sessions via a central daemon.",
    `Launcher (use this absolute path, not PATH): ${bin}`,
    "",
    "Start the new-message stream now with the **Monitor tool** (persistent: true):",
    `  ${subscribeCmd}`,
    "subscribe is long-running and blocking — running it in the Bash tool will hang the turn.",
    "Its stdout is JSONL (one room event per line) for Monitor / jq to consume.",
    "Without it you cannot proactively notice incoming messages (the UserPromptSubmit hook only nags you on your next turn).",
  ];

  // (d) PATH install suggestion (DR-0007 §1), only when detected.
  try {
    const home = process.env.HOME ?? os.homedir();
    const candidate = detectPathInstallCandidate(process.env.PATH, home, stateDir);
    if (candidate) {
      const decline = declineMarkerPath(stateDir);
      contextLines.push(
        "",
        `ccmsg is not on PATH, but ${candidate.dir} is on PATH and writable. Ask the user ` +
          "with AskUserQuestion whether to add a stable `ccmsg` command there:",
        `  - If they agree: ln -sfn '${bin}' '${candidate.binPath}'`,
        `  - If they decline: touch '${decline}'`,
        "Do this at most once per session, and only after an explicit answer — don't run either command without asking first.",
      );
    }
  } catch {
    // best-effort detection; never block the turn over PATH install suggestion
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextLines.join("\n"),
      },
    })}\n`,
  );
}

if (import.meta.main) {
  main().catch((e) => {
    // A hook must never break the turn (exit 0).
    process.stderr.write(`[ccmsg session-start] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(0);
  });
}
