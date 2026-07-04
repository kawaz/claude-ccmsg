#!/usr/bin/env bun
/**
 * UserPromptSubmit hook.
 *
 * A `ccmsg subscribe` stream dies with the claude process that launched it (a
 * `claude --resume` starts a fresh process where it does not come back), and
 * SessionStart does not fire on `/cd`. So on every prompt we re-check whether a
 * subscribe process is still live in *this* session's process tree and, only if
 * it is missing, nag the AI to re-open it under the Monitor tool. When it is
 * running we stay silent (the quiet principle).
 *
 * Detection is process-tree based: this hook runs as a descendant of the claude
 * process, so we walk our own ppid chain up to claude, then look for a
 * `ccmsg subscribe` process among claude's descendants. Any failure (no ps, no
 * claude ancestor) falls to the safe side — nag — rather than staying silent.
 */
import * as path from "node:path";

interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axww -o pid=,ppid=,command=` output (headerless): "<pid> <ppid> <command...>". */
export function parsePs(raw: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trimStart();
    if (s === "") continue;
    const m = s.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/** argv[0] basename === "claude". */
function isClaudeCommand(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0];
  if (!argv0) return false;
  return argv0.split("/").pop() === "claude";
}

/** Walk ppid from startPid until a `claude` process is found; null if none (cycle/PID 1 guarded). */
export function findClaudeAncestor(rows: ProcRow[], startPid: number, maxDepth = 32): number | null {
  const byPid = new Map<number, ProcRow>();
  for (const r of rows) byPid.set(r.pid, r);
  const seen = new Set<number>();
  let cur = startPid;
  for (let i = 0; i < maxDepth; i++) {
    if (cur <= 1 || seen.has(cur)) return null;
    seen.add(cur);
    const row = byPid.get(cur);
    if (!row) return null;
    if (isClaudeCommand(row.command)) return row.pid;
    cur = row.ppid;
  }
  return null;
}

/** BFS the descendant pid set of rootPid (rootPid itself excluded, cycles guarded). */
export function collectDescendants(rows: ProcRow[], rootPid: number): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const r of rows) {
    const arr = childrenByPpid.get(r.ppid);
    if (arr) arr.push(r.pid);
    else childrenByPpid.set(r.ppid, [r.pid]);
  }
  const result = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenByPpid.get(cur) ?? []) {
      if (child === rootPid || result.has(child)) continue;
      result.add(child);
      queue.push(child);
    }
  }
  return result;
}

/**
 * Does this command line run `ccmsg subscribe`?
 *
 * The launcher `exec`s `bun run <root>/packages/cli/src/index.ts <args>`, so the
 * live process shows as either `.../bin/ccmsg subscribe` or
 * `bun run .../packages/cli/src/index.ts subscribe`. Match an entry token
 * (basename `ccmsg`, or the CLI entry `index.ts`) immediately followed by
 * `subscribe`. Descendant-of-claude scoping keeps false positives negligible.
 */
export function isSubscribeCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length - 1; i++) {
    const base = tokens[i]!.split("/").pop();
    const isEntry = base === "ccmsg" || base === "index.ts";
    if (isEntry && tokens[i + 1] === "subscribe") return true;
  }
  return false;
}

/** True iff a `ccmsg subscribe` process exists among rootPid's descendants. */
export function detectSubscribeInTree(rows: ProcRow[], rootPid: number): boolean {
  const descendants = collectDescendants(rows, rootPid);
  return rows.some((r) => descendants.has(r.pid) && isSubscribeCommand(r.command));
}

function resolveBin(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(import.meta.dir, "..");
  return path.join(root, "bin", "ccmsg");
}

/** Detect a live subscribe in the current session's tree; false on any uncertainty (safe side = nag). */
function subscribeRunning(): boolean {
  let rows: ProcRow[];
  try {
    const proc = Bun.spawnSync({
      cmd: ["ps", "-axww", "-o", "pid=,ppid=,command="],
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (proc.exitCode !== 0) return false;
    rows = parsePs(new TextDecoder().decode(proc.stdout));
  } catch {
    return false;
  }
  const claudePid = findClaudeAncestor(rows, process.pid);
  if (claudePid === null) return false;
  return detectSubscribeInTree(rows, claudePid);
}

async function main(): Promise<void> {
  try {
    await Bun.stdin.text();
  } catch {
    process.exit(0);
  }

  if (subscribeRunning()) {
    // Quiet principle: nothing to say when the stream is healthy.
    process.exit(0);
  }

  const bin = resolveBin();
  // stdout is injected into the next turn as a <system-reminder>.
  process.stdout.write(
    `[ccmsg] subscribe stream not detected in this session's process tree. ` +
      `Open it with the **Monitor tool** (persistent: true), not Bash: ${bin} subscribe\n`,
  );
}

if (import.meta.main) {
  main().catch(() => {
    // A hook must never break the turn (exit 0).
    process.exit(0);
  });
}
