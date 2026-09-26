#!/usr/bin/env bun
/**
 * UserPromptSubmit hook.
 *
 * Rescues a session whose SessionStart never wrote a state file (see
 * ensureSessionFile below) — but only ever fills in a *missing* file, never
 * overwrites the fresher one SessionStart already wrote. Otherwise silent.
 */
import * as fs from "node:fs";
import { resolvePaths } from "@ccmsg/protocol";
import { armHookDeadline, exitHook } from "./deadline.ts";
import {
  getRepoWsFromVcs,
  resolveBumpSemverBin,
  sessionFilePath,
  sessionLocation,
  writeSessionFile,
} from "./session-start.ts";

interface UserPromptSubmitInput {
  session_id?: string;
  /** absolute path of this session's Claude Code transcript jsonl, same field
   *  SessionStart receives (DR-0009 addendum). Only used here to rescue a
   *  missing session state file (see ensureSessionFile). */
  transcript_path?: string;
}

/**
 * Rescue path for a session whose SessionStart never wrote a state file (e.g.
 * the plugin was installed/updated mid-session, or the file was pruned) — writes
 * one iff `sessionFilePath(stateDir, sid)` doesn't already exist. Every other
 * prompt in a session leaves SessionStart's (fresher, cwd-at-launch) write alone
 * rather than re-deriving repo/ws via a `bump-semver` subprocess on every single
 * turn. Best-effort: any failure (unwritable stateDir, bump-semver absent, ...)
 * is swallowed by the caller, same as the rest of this hook.
 *
 * The location it rescues comes from `CLAUDE_PROJECT_DIR` alone: this hook fires
 * mid-session, so the cwd its event carries is wherever the last Bash tool went
 * (DR-0003 §3 「所在の正本」). Without that variable the rescued file names no
 * location at all and only carries transcript_path, which is the field the
 * rescue exists for.
 *
 * `opts.timeoutMs` forwards to `getRepoWsFromVcs`'s shared deadline; omitted (as
 * the hook itself does) it keeps that function's 1000ms production default. It
 * exists so tests, whose fake `sh` fixtures are far slower to spawn than the real
 * binary under parallel load, can buy a budget that isn't a stand-in for the
 * production latency ceiling.
 */
export async function ensureSessionFile(
  stateDir: string,
  sid: string,
  input: { transcriptPath?: string },
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<void> {
  if (fs.existsSync(sessionFilePath(stateDir, sid))) return;
  const stationed = sessionLocation();
  const { repo, ws, repoRoot, branch } = stationed
    ? await getRepoWsFromVcs(stationed, { bin: opts.bin, timeoutMs: opts.timeoutMs })
    : { repo: "", ws: "", repoRoot: "", branch: "" };
  writeSessionFile(stateDir, sid, {
    ...(input.transcriptPath ? { transcript_path: input.transcriptPath } : {}),
    ...(stationed ? { cwd: stationed } : {}),
    ...(repo ? { repo } : {}),
    ...(ws ? { ws } : {}),
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    ...(branch ? { branch } : {}),
    updated_at: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  let sessionId: string | undefined;
  let transcriptPath: string | undefined;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as UserPromptSubmitInput;
    sessionId = input.session_id;
    transcriptPath = input.transcript_path;
  } catch {
    // Non-JSON stdin: no session file rescue to attempt.
  }

  if (sessionId) {
    try {
      await ensureSessionFile(
        resolvePaths().stateDir,
        sessionId,
        { transcriptPath },
        { bin: resolveBumpSemverBin() },
      );
    } catch {
      // best-effort
    }
  }

  await exitHook();
}

/** Wall-clock cap for this hook (see deadline.ts). This one runs before every
 *  turn, so the cap is set against what the work actually costs rather than
 *  against what Claude Code tolerates: bun startup for the steady-state path, and a
 *  few hundred more on the once-per-session turn that rescues a missing state file. 1500ms leaves that whole budget intact while
 *  turning the pathological cases — a subprocess stuck behind a repo lock, a
 *  stdin that is never closed — from an unbounded stall into a skipped rescue. */
const USER_PROMPT_SUBMIT_DEADLINE_MS = 1500;

if (import.meta.main) {
  armHookDeadline(USER_PROMPT_SUBMIT_DEADLINE_MS);
  main().catch(() => {
    // A hook must never break the turn (exit 0).
    process.exit(0);
  });
}
