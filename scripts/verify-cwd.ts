#!/usr/bin/env bun
// The pool of trusted cwds for verify runs that start a real `claude` in a
// real config dir (one that is logged in). A cwd claude has not seen shows the
// trust dialog; these cwds are registered as trusted once, and each run takes
// one, starts claude in it and gives it back.
//
// Design rationale: the pool sits at a fixed place,
// ~/.local/state/ccmsg/tmp-test-trusted-dirs/NN, and not under a temp base as the
// temp-files rule asks. Claude Code keys a cwd's trust by its realpath, and a
// temp dir or a jj workspace is a new path every time, so trust registered for
// it would never apply again. The cost is that runs do not clean up after
// themselves: `acquire` empties a cwd when it hands it out, `release` only
// gives it back.
//
// The name says what the dirs are: reserved for tests, nothing in them is
// kept, and the whole dir may be removed (the next `acquire` makes it again at
// the same paths, so the trust registered for them still applies).
//
// The pool's root is a git repo (`git init`) whose `.gitignore` is `*`. git's
// search for the repo a cwd belongs to stops there, so a run's git never
// reaches a repo above it (an empty `.git` dir would not stop the search), and
// the root's own status lists nothing. Each NN is also a fresh empty repo of
// its own, so `git rev-parse --show-toplevel` in it names NN.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const POOL_SIZE = 50;

const USAGE = `Usage: verify-cwd <command>

Commands:
  acquire           take a free cwd, empty it and print its realpath
  release <NN>      give cwd NN back
  list              print each cwd's number and whether it is in use
  register [<file>] write a copy of the .claude.json <file> (default: the
                    current config dir's) with every cwd of the pool trusted,
                    and print the copy's path; <file> itself is not changed

Environment: CCMSG_VERIFY_CWD_POOL (the pool's root, for tests)`;

const root =
  process.env.CCMSG_VERIFY_CWD_POOL ??
  path.join(os.homedir(), ".local/state/ccmsg/tmp-test-trusted-dirs");

function fail(message: string, code: number): never {
  process.stderr.write(`verify-cwd: ${message}\n`);
  process.exit(code);
}

function errorCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** Runs git in `cwd` and returns its standard output; any failure ends the script. */
function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    fail(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr.toString().trim()}`, 1);
  }
  return result.stdout.toString().trim();
}

/** Makes the root a git repo that ignores everything unless it is one already.
 * The repo is built in a scratch dir and its `.git` renamed into place, so a
 * concurrent `acquire` sees either no repo or a complete one: rename(2) fails
 * on the loser's side when the winner's `.git` is there. */
function ensureRoot(): string {
  fs.mkdirSync(root, { recursive: true });
  const real = fs.realpathSync(root);
  const dotGit = path.join(real, ".git");
  if (!fs.existsSync(dotGit)) {
    const scratch = fs.mkdtempSync(path.join(real, ".guard-"));
    try {
      git(scratch, ["init", "-q"]);
      fs.writeFileSync(path.join(real, ".gitignore"), "*\n");
      try {
        fs.renameSync(path.join(scratch, ".git"), dotGit);
      } catch (e) {
        const code = errorCode(e);
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (git(real, ["rev-parse", "--show-toplevel"]) !== real) {
    fail(`${dotGit} is not the pool's repo; move it away`, 1);
  }
  return real;
}

function slot(n: number): string {
  return String(n).padStart(2, "0");
}

function slots(): string[] {
  return Array.from({ length: POOL_SIZE }, (_, i) => slot(i + 1));
}

function acquire(): void {
  const real = ensureRoot();
  for (const nn of slots()) {
    try {
      fs.mkdirSync(path.join(real, `${nn}.lock`));
    } catch (e) {
      if (errorCode(e) === "EEXIST") continue;
      throw e;
    }
    const cwd = path.join(real, nn);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd);
    git(cwd, ["init", "-q"]);
    process.stdout.write(`${cwd}\n`);
    return;
  }
  fail(`all ${String(POOL_SIZE)} cwds are in use; see \`verify-cwd list\` and release one`, 1);
}

function release(nn: string | undefined): void {
  if (nn === undefined || !slots().includes(nn)) {
    fail(`release takes a cwd number, 01 to ${slot(POOL_SIZE)}`, 2);
  }
  try {
    fs.rmdirSync(path.join(root, `${nn}.lock`));
  } catch (e) {
    if (errorCode(e) === "ENOENT") fail(`${nn} is not in use`, 1);
    throw e;
  }
}

/** Written in one write, so a reader that stops early (`| head`) takes it
 * from the pipe's buffer instead of failing the next write with EPIPE. */
function list(): void {
  const lines = slots().map((nn) => {
    const inUse = fs.existsSync(path.join(root, `${nn}.lock`));
    return `${nn}\t${inUse ? "in-use" : "free"}\n`;
  });
  process.stdout.write(lines.join(""));
}

function register(file: string | undefined): void {
  const source = file ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? os.homedir(), ".claude.json");
  if (!fs.existsSync(source)) fail(`${source} does not exist`, 1);
  const real = ensureRoot();
  const paths = slots().map((nn) => path.join(real, nn));
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-verify-cwd-")),
    ".claude.json",
  );
  const result = Bun.spawnSync(
    [
      "jq",
      "--argjson",
      "paths",
      JSON.stringify(paths),
      "reduce $paths[] as $p (.; .projects[$p].hasTrustDialogAccepted = true)",
      source,
    ],
    { stdout: Bun.file(out), stderr: "pipe" },
  );
  if (result.exitCode !== 0) fail(`jq failed on ${source}: ${result.stderr.toString().trim()}`, 1);
  process.stdout.write(`${out}\n`);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "acquire":
    acquire();
    break;
  case "release":
    release(arg);
    break;
  case "list":
    list();
    break;
  case "register":
    register(arg);
    break;
  case undefined:
  case "--help":
    process.stdout.write(`${USAGE}\n`);
    break;
  default:
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
}
