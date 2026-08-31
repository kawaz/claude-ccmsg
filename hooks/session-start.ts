#!/usr/bin/env bun
/**
 * SessionStart hook.
 *
 * Four jobs:
 *   (a) Write a per-session state file (`<stateDir>/sessions/<sid>.json`) carrying
 *       transcript_path/cwd/repo/ws, for the CLI's resolveIdentity to pick up at
 *       hello time. A state file the CLI reads on its own keeps the suggested
 *       command a constant bare `ccmsg subscribe` regardless of how much
 *       identity metadata accumulates (kawaz decision, 2026-07-11) — env
 *       prefixes on the suggested command would make every session's *first*
 *       turn re-teach the AI an ever-growing command line purely for the
 *       daemon's benefit.
 *   (b) Tell the AI to hold a bare `ccmsg subscribe` stream open under the
 *       Monitor tool. `CLAUDE_CODE_SESSION_ID` is exported into Bash/Monitor
 *       subprocesses by Claude Code, so the CLI's own identity auto-detection
 *       (packages/cli/src/index.ts's resolveIdentity) picks it up without any
 *       env prefix on the suggested command; CCMSG_SID stays available as an
 *       explicit override for manual invocation and tests.
 *       That subscribe call is the first client action of this session and it goes
 *       through `ensureDaemon`, which spawns/upgrades the daemon on demand — so no
 *       separate pre-warm from this hook is needed (DR-0002 §5 lazy ensure).
 *   (c) When PATH has no `ccmsg` but a stable, writable candidate dir does, tell
 *       the AI to ask the user (AskUserQuestion) whether to symlink one in.
 *       The hook itself never writes the symlink or the decline marker — only
 *       detects and instructs; the AI performs the confirmed action. (DR-0007 §1)
 *   (d) Likewise for the `say` shim: when PATH's effective `say` is the plain
 *       system one (or our own copy, gone stale) and a writable dir ahead of it
 *       is available, tell the AI to ask whether to copy `bin/say` there.
 *
 * Failure here never blocks the turn: parse errors and ensure failures exit 0 quietly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePaths } from "@ccmsg/protocol";
import { armHookDeadline, exitHook } from "./deadline.ts";

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
 *  whether the killed subprocess actually exits.
 *
 *  Bounding the caller's wait is not the same as bounding the hook, though, and
 *  both loose ends here were costing the hook wall time long after this
 *  function returned (see deadline.ts for the measurements):
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
// The suggested subscribe command carries no env prefix at all (see
// buildSubscribeCommand below): the sid comes from CLAUDE_CODE_SESSION_ID,
// which the CLI auto-detects, and everything else identity-related that the
// CLI's resolveIdentity wants (transcript_path/repo/ws) rides through this
// file instead, so the command the AI re-types every session stays short
// regardless of how much metadata accumulates.

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
 * Builds the `ccmsg subscribe` command line suggested to the AI: a bare
 * `<bin> subscribe`, no env prefix. The CLI auto-detects the session identity
 * from `CLAUDE_CODE_SESSION_ID`, which Claude Code exports into Bash/Monitor
 * subprocesses; transcript_path/repo/ws ride along via the session state file
 * (see writeSessionFile) and are read by the CLI's own resolveIdentity. This
 * keeps the suggested command constant regardless of how much identity
 * metadata accumulates.
 */
export function buildSubscribeCommand(bin: string): string {
  return `${bin} subscribe`;
}

/** Absolute path of this plugin's root, robust to a missing CLAUDE_PLUGIN_ROOT
 *  (a dev checkout runs the hook straight from `hooks/`). */
function resolvePluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
}

/** Absolute path to the launcher. */
function resolveBin(): string {
  return path.join(resolvePluginRoot(), "bin", "ccmsg");
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

/** First PATH dir holding an entry named `ccmsg` (symlink or regular file),
 *  or null when there is none. The dir — not just the yes/no — is what the say
 *  shim detection below needs, so it can put the shim next to the ccmsg the
 *  user already installed rather than inventing a second location. */
function findCcmsgDir(dirs: string[]): string | null {
  for (const d of dirs) {
    try {
      fs.accessSync(path.join(d, "ccmsg"));
      return d;
    } catch {
      // not here; keep looking
    }
  }
  return null;
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
  if (findCcmsgDir(dirs) !== null) return null;
  if (fs.existsSync(declineMarkerPath(stateDir))) return null;

  for (const cand of candidateBinDirs(home)) {
    if (dirs.includes(cand) && isWritableDir(cand)) {
      return { dir: cand, binPath: path.join(cand, "ccmsg") };
    }
  }
  return null;
}

// --- `say` shim install detection --------------------------------------------
//
// The same "detect, ask, let the AI do it" shape as the ccmsg PATH install
// above (DR-0007 §1): the hook never writes anything, it only reports what it
// found and what command would fix it.
//
// Two things differ from the ccmsg case:
//
//   - the shim is COPIED, not symlinked. A symlink would point into the
//     versioned plugin cache (`.../cache/ccmsg/ccmsg/<version>/bin/say`), a
//     path that disappears on the next plugin update and leaves a dangling
//     `say` on PATH — and a broken `say` is exactly the failure the shim's own
//     fallback logic is written to avoid. `ccmsg`'s symlink can afford that
//     dependency because the launcher repairs it (DR-0007 §2); a shim with no
//     self-update path cannot, so it is copied and re-copied when stale.
//   - it must not hijack someone else's `say`. Only a PATH where the effective
//     `say` is the system one (or our own shim) is eligible; anything else is
//     left alone, silently.

/** Marker line carried by `bin/say`, used to tell our own shim apart from an
 *  unrelated `say` a user put on PATH. */
const SAY_SHIM_MARKER = "ccmsg-say-shim";

/** The macOS `say` the shim ultimately execs. Overridable only so the
 *  detection can be unit-tested without a real /usr/bin/say. */
const SYSTEM_SAY = "/usr/bin/say";

export interface SayShimCandidate {
  dir: string;
  /** dir/say — where the copy goes. */
  shimPath: string;
  /** source file to copy from (the plugin's own bin/say). */
  source: string;
  /** "install": no shim there yet. "update": our shim is there but stale. */
  action: "install" | "update";
}

export interface SayShimOptions {
  /** plugin root holding `bin/say`; the copy's source. */
  pluginRoot: string;
  /** test seam for {@link SYSTEM_SAY}. */
  systemSay?: string;
}

/** Absolute path of the say-shim decline marker (separate from the ccmsg one:
 *  declining a PATH `ccmsg` and declining to intercept `say` are different
 *  answers, and a user who already has ccmsg on PATH never saw the first
 *  question at all). */
export function sayShimDeclineMarkerPath(stateDir: string): string {
  return path.join(stateDir, "say-shim-declined");
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function realpathOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * Returns the say-shim install/update candidate, or null when nothing should
 * be proposed. Conditions, all required:
 *
 *   - the user hasn't declined before (marker in stateDir);
 *   - the plugin ships a readable `bin/say`;
 *   - the *effective* `say` on PATH (first PATH dir with such an entry) is
 *     either the system binary or our own shim — a third party's `say` means
 *     hands off;
 *   - the target dir (where `ccmsg` already lives on PATH, else the ccmsg
 *     install candidate) is writable and sits ahead of the system `say`, so the
 *     copy would actually take effect.
 *
 * An up-to-date shim already in place returns null: nothing to say.
 */
export function detectSayShimCandidate(
  pathEnv: string | undefined,
  home: string,
  stateDir: string,
  opts: SayShimOptions,
): SayShimCandidate | null {
  if (fs.existsSync(sayShimDeclineMarkerPath(stateDir))) return null;

  const source = path.join(opts.pluginRoot, "bin", "say");
  const wanted = readFileOrNull(source);
  if (wanted === null) return null;

  const systemSay = realpathOrNull(opts.systemSay ?? SYSTEM_SAY);
  const dirs = pathDirs(pathEnv);

  // The effective `say`: the first one PATH would resolve to.
  let effectiveDir: string | null = null;
  let effectiveBody: string | null = null;
  for (const d of dirs) {
    const p = path.join(d, "say");
    if (!fs.existsSync(p)) continue;
    effectiveDir = d;
    const real = realpathOrNull(p);
    if (systemSay !== null && real === systemSay) break; // the system one
    effectiveBody = readFileOrNull(p);
    if (effectiveBody === null || !effectiveBody.includes(SAY_SHIM_MARKER)) return null; // someone else's
    break;
  }

  // Ours is already the effective `say`: only propose when its content drifted
  // from what this plugin version ships (the shim has no self-update path, so
  // re-copying on drift is the whole update mechanism).
  if (effectiveBody !== null && effectiveDir !== null) {
    if (effectiveBody === wanted) return null;
    return {
      dir: effectiveDir,
      shimPath: path.join(effectiveDir, "say"),
      source,
      action: "update",
    };
  }

  const ccmsgDir = findCcmsgDir(dirs);
  const target =
    ccmsgDir ?? candidateBinDirs(home).find((c) => dirs.includes(c) && isWritableDir(c)) ?? null;
  if (target === null || !isWritableDir(target)) return null;

  // A copy placed behind the system `say` on PATH would never run.
  if (effectiveDir !== null && dirs.indexOf(target) > dirs.indexOf(effectiveDir)) return null;

  return { dir: target, shimPath: path.join(target, "say"), source, action: "install" };
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

  // (a) Write this session's state file (transcript_path/cwd/repo/ws) for the CLI
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

  // (b) Guide the AI. subscribe is a long-running blocking stream, so it must run
  // under the Monitor tool (persistent), never the Bash tool.
  //
  // No env prefix needed: CLAUDE_CODE_SESSION_ID is exported into Bash/Monitor
  // subprocesses, and the CLI's identity auto-detection picks it up on its own
  // (packages/cli/src/index.ts's resolveIdentity). CCMSG_SID remains available
  // as an explicit override for manual invocation and tests.
  const subscribeCmd = buildSubscribeCommand(bin);
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

  // (c) PATH install suggestion (DR-0007 §1) and (d) `say` shim suggestion,
  // each only when detected.
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

    const shim = detectSayShimCandidate(process.env.PATH, home, stateDir, {
      pluginRoot: resolvePluginRoot(),
    });
    if (shim) {
      const decline = sayShimDeclineMarkerPath(stateDir);
      const what =
        shim.action === "install"
          ? `A \`say\` shim in ${shim.dir} (which is on PATH ahead of /usr/bin) would let the web UI show which session made a sound`
          : `The \`say\` shim in ${shim.dir} is out of date with this ccmsg version`;
      contextLines.push(
        "",
        `${what}. Ask the user with AskUserQuestion whether to ${shim.action} it:`,
        `  - If they agree: install -m 0755 '${shim.source}' '${shim.shimPath}'`,
        `  - If they decline: touch '${decline}'`,
        "The shim is a copy, not a symlink, on purpose — the source lives in a versioned plugin cache dir that disappears on the next update.",
        "Do this at most once per session, and only after an explicit answer — don't run either command without asking first.",
      );
    }
  } catch {
    // best-effort detection; never block the turn over an install suggestion
  }

  await exitHook(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextLines.join("\n"),
      },
    })}\n`,
  );
}

/** Wall-clock cap for this hook (see deadline.ts). Roomier than
 *  UserPromptSubmit's: this fires once per session rather than once per turn,
 *  and losing its output costs the session its ccmsg guidance entirely, where
 *  the nag merely reappears on the next prompt. Still far below the 30s Claude
 *  Code would otherwise allow. */
const SESSION_START_DEADLINE_MS = 3000;

if (import.meta.main) {
  armHookDeadline(SESSION_START_DEADLINE_MS);
  main().catch((e) => {
    // A hook must never break the turn (exit 0).
    process.stderr.write(`[ccmsg session-start] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(0);
  });
}
