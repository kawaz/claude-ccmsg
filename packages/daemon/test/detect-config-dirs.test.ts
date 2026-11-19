// HOME の直下の `.claude*` のうち、どれを Claude config dir とみなすか (agents.ts
// detectConfigDirs)。セッションが使った印 (`sessions/` か `projects/`) を持つ
// ディレクトリだけを返す。Claude Code のコマンドが CLAUDE_CONFIG_DIR に置いて
// いく `.claude.json` と `backups/` しか無いディレクトリ (`.claude.json`、
// `.claude.json.lock`、`.claude-<面>.lock` 等。開発機の HOME で観測した形、
// docs/findings/2026-11-19-config-dir-markers.md) は返さない。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { detectConfigDirs } from "../src/agents.ts";

const tmpDir = perTestTmpDir();

/** `<home>/<name>` with the given entries: a name ending in `/` is a dir,
 * any other a file. */
function entry(home: string, name: string, children: readonly string[]): string {
  const dir = path.join(home, name);
  fs.mkdirSync(dir);
  for (const child of children) {
    if (child.endsWith("/")) fs.mkdirSync(path.join(dir, child));
    else fs.writeFileSync(path.join(dir, child), "{}");
  }
  return dir;
}

/** What any Claude Code command leaves in the dir CLAUDE_CONFIG_DIR names. */
const COMMAND_LEFTOVERS = [".claude.json", "backups/"];

describe("detectConfigDirs", () => {
  test("セッションの印を持つ .claude* だけを返し、コマンドの残り物しか無いものは返さない", () => {
    const home = tmpDir("ccmsg-detect-");
    // A config dir in use: everything a long-used one has.
    const used = entry(home, ".claude-personal", [
      ...COMMAND_LEFTOVERS,
      "sessions/",
      "projects/",
      "settings.json",
      "history.jsonl",
    ]);
    // Just started: the harness made `sessions/` and nothing is typed yet.
    const started = entry(home, ".claude-new", [...COMMAND_LEFTOVERS, "sessions/"]);
    // Only transcripts left (its `sessions/` gone).
    const transcripts = entry(home, ".claude-old", ["projects/"]);
    for (const name of [
      ".claude.json",
      ".claude.json.lock",
      ".claude-personal.lock",
      ".claude-emrd.lock.bak-144649",
      ".claude-unused",
    ]) {
      entry(home, name, COMMAND_LEFTOVERS);
    }
    entry(home, ".claude-empty", []);
    // The marks as files are no marks.
    entry(home, ".claude-files", ["sessions", "projects"]);
    // ~/.claude as a regular file (the development machine's shape).
    fs.writeFileSync(path.join(home, ".claude"), "");
    // A dir not named `.claude*` is not looked at, marks or not.
    entry(home, "claude-other", ["sessions/", "projects/"]);

    expect(detectConfigDirs(home)).toEqual([started, transcripts, used]);
  });

  test("印が後から現れたディレクトリは次の呼び出しで返る", () => {
    const home = tmpDir("ccmsg-detect-");
    const dir = entry(home, ".claude-late", COMMAND_LEFTOVERS);
    expect(detectConfigDirs(home)).toEqual([]);
    fs.mkdirSync(path.join(dir, "sessions"));
    expect(detectConfigDirs(home)).toEqual([dir]);
  });

  test("読めない HOME は空", () => {
    expect(detectConfigDirs(path.join(tmpDir("ccmsg-detect-"), "absent"))).toEqual([]);
  });
});
