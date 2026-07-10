#!/usr/bin/env bun
/**
 * SessionStart hook.
 *
 * Three jobs:
 *   (a) Wake the central daemon by going through the *same* ensure-daemon path
 *       every client uses — we shell out to the launcher (`ccmsg peers`) rather
 *       than importing daemon internals, so the hook depends only on the public
 *       `bin/ccmsg` contract. Blocking on it also lets the spawned daemon reparent
 *       to init before this hook exits, so a hook process-group teardown won't take
 *       the daemon with it (and if it ever does, the next ensure — subscribe's own —
 *       respawns it, DR-0002 §5). (DR-0002 §2)
 *   (b) Tell the AI to hold a `ccmsg subscribe` stream open under the Monitor tool.
 *       (DR-0002 §2)
 *   (c) When PATH has no `ccmsg` but a stable, writable candidate dir does, tell
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

  // (b) Guide the AI. subscribe is a long-running blocking stream, so it must run
  // under the Monitor tool (persistent), never the Bash tool.
  //
  // CCMSG_SID must be embedded in the suggested command: CLAUDE_SESSION_ID is
  // NOT exported to the Bash/Monitor subprocess environment, so without it the
  // subscribe would silently hello as the User (u1) — no peers entry, no
  // echo suppression. The hook is the one place that reliably knows session_id.
  const sidPrefix = input.session_id ? `CCMSG_SID=${input.session_id} ` : "";
  const contextLines = [
    "ccmsg is available: file-backed messaging between Claude Code sessions via a central daemon.",
    `Launcher (use this absolute path, not PATH): ${bin}`,
    "",
    "Start the new-message stream now with the **Monitor tool** (persistent: true):",
    `  ${sidPrefix}${bin} subscribe`,
    "subscribe is long-running and blocking — running it in the Bash tool will hang the turn.",
    "Its stdout is JSONL (one room event per line) for Monitor / jq to consume.",
    "Without it you cannot proactively notice incoming messages (the UserPromptSubmit hook only nags you on your next turn).",
  ];

  // (c) PATH install suggestion (DR-0007 §1), only when detected.
  try {
    const stateDir = resolvePaths().stateDir;
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
