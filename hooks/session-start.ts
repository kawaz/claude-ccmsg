#!/usr/bin/env bun
/**
 * SessionStart hook.
 *
 * Two jobs (DR-0002 §2):
 *   (a) Wake the central daemon by going through the *same* ensure-daemon path
 *       every client uses — we shell out to the launcher (`ccmsg peers`) rather
 *       than importing daemon internals, so the hook depends only on the public
 *       `bin/ccmsg` contract. Blocking on it also lets the spawned daemon reparent
 *       to init before this hook exits, so a hook process-group teardown won't take
 *       the daemon with it (and if it ever does, the next ensure — subscribe's own —
 *       respawns it, DR-0002 §5).
 *   (b) Tell the AI to hold a `ccmsg subscribe` stream open under the Monitor tool.
 *
 * Failure here never blocks the turn: parse errors and ensure failures exit 0 quietly.
 */
import * as path from "node:path";

interface SessionStartInput {
  session_id?: string;
  source?: string;
}

/** Absolute path to the launcher, robust to a missing CLAUDE_PLUGIN_ROOT. */
function resolveBin(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
  return path.join(root, "bin", "ccmsg");
}

async function main(): Promise<void> {
  try {
    JSON.parse(await Bun.stdin.text()) as SessionStartInput;
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
  const additionalContext = [
    "ccmsg is available: file-backed messaging between Claude Code sessions via a central daemon.",
    `Launcher (use this absolute path, not PATH): ${bin}`,
    "",
    "Start the new-message stream now with the **Monitor tool** (persistent: true):",
    `  ${bin} subscribe`,
    "subscribe is long-running and blocking — running it in the Bash tool will hang the turn.",
    "Its stdout is JSONL (one room event per line) for Monitor / jq to consume.",
    "Without it you cannot proactively notice incoming messages (the UserPromptSubmit hook only nags you on your next turn).",
  ].join("\n");

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
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
