#!/usr/bin/env bun
// ccmsg CLI. Subcommand style, long options, no-args prints help (per kawaz CLI
// conventions). Every command except `daemon run` goes through ensure-daemon.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AllowedOriginsTextSchema,
  VERSION,
  applySayDictionary,
  type SayDictionary,
  errorText,
  isSessionIdShape,
  migrateLegacyConfigFiles,
  parseWith,
  SessionStateFileTextSchema,
  SidecarRunIdSchema,
  resolvePaths,
  sessionProjectDir,
  type Identity,
  type ReplyOf,
  type RequestInput,
  LaunchInputTextSchema,
  PermitInputTextSchema,
  type SessionStateFile,
} from "@ccmsg/protocol";
import { runDaemon } from "@ccmsg/daemon/run";
import { holdTestLifeline } from "@ccmsg/daemon/test-lifeline";
import {
  dumpSession,
  formatJsonlDump,
  formatTextDump,
  writeSessionDumpFile,
} from "@ccmsg/daemon/session-dump";
import { Client, connectIfRunning, helloRequest, ensureDaemon, waitDaemonGone } from "./client.ts";
import {
  getRepoWsFromVcs,
  pruneOldSessionFiles,
  resolveBumpSemverBin,
  sessionFilePath,
  writeSessionFile,
} from "./session-begin.ts";
import { keepNamed, type Sidecar, socketPeerClosed, startSidecar } from "./sidecar.ts";
import { loadSayDictionary, speechTextOf } from "./say-dictionary.ts";
import { type AgentsFormat, agentsTable } from "./agents.ts";

// --- arg parsing -----------------------------------------------------------

const BOOL_FLAGS = new Set([
  "self",
  "foreground",
  "no-thinking",
  "no-agent",
  "force",
  "help",
  "help-full",
  "version",
]);

/** Write ops require a session identity; without one the CLI refuses to run
 * rather than silently posting as u1 (the User admin), which would forge
 * user-authored msgs (see docs/decisions/DR-0003 §3, docs/issue/2026-07-12-
 * prevent-u1-masquerade-on-missing-sid.md). peers/status stay available
 * identity-less because they only observe. */
const WRITE_OPS = new Set(["notify"]);

interface Parsed {
  positionals: string[];
  opts: Record<string, string | boolean>;
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (BOOL_FLAGS.has(key)) {
          opts[key] = true;
        } else {
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            opts[key] = next;
            i++;
          } else {
            opts[key] = true;
          }
        }
      }
    } else if (a === "-h") {
      opts.help = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

function str(opts: Record<string, string | boolean>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

function requireArg(v: string | undefined, name: string, usage: string): string {
  if (v === undefined || v === "") throw new Error(`missing <${name}>\n  usage: ${usage}`);
  return v;
}

// --- identity --------------------------------------------------------------

/** Best-effort read of the session state file `sidecar begin` writes. Missing
 *  file, unreadable, or not of the state file's shape all resolve to undefined —
 *  this is an optional enrichment (repo/ws/cwd for a richer hello),
 *  never a hard requirement for `hello` to succeed. */
function readSessionFile(stateDir: string, sid: string): SessionStateFile | undefined {
  let text: string;
  try {
    text = fs.readFileSync(sessionFilePath(stateDir, sid), "utf8");
  } catch {
    return undefined;
  }
  const stored = parseWith(SessionStateFileTextSchema, text);
  return stored.ok ? stored.value : undefined;
}

/** `undefined` and `""` both collapse to `undefined` — an env var
 *  present-but-blank (a CI/shell environment accident) must not shadow a real
 *  value from the session file. */
function strField(v: string | undefined): string | undefined {
  return v !== undefined && v !== "" ? v : undefined;
}

/** Resolve a session identity from flags + env, or null when no sid is
 * available. The CLI intentionally does NOT fall back to `{ role: "user" }`
 * (u1, admin) for a missing sid — that fallback is what forged u1-authored
 * msgs when a Monitor subprocess inherited an env without CCMSG_SID (DR-0003
 * §3 revision, docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md).
 * Callers of write ops turn this null into a hard error; observe-only ops
 * (peers/status) treat null as user role. */
function resolveSessionIdentity(
  opts: Record<string, string | boolean>,
  cmd: string,
): Identity | null {
  // `notify` uses --sid for its target, so it must not double as an identity override
  // there; --as-session still works everywhere.
  const sidOverride =
    cmd === "notify" ? str(opts, "as-session") : (str(opts, "sid") ?? str(opts, "as-session"));
  // Env auto-detect: CCMSG_SID first (an explicit override for manual
  // invocation / tests), then CLAUDE_CODE_SESSION_ID (Claude Code's own env,
  // exported into Bash subprocesses, so this is the normal path a `ccmsg
  // notify --self` run from a session's own justfile resolves through). `strField`
  // collapses empty strings to undefined so `CCMSG_SID=""` (a shell/CI env
  // accident) doesn't shadow a real CLAUDE_CODE_SESSION_ID; same pattern used
  // elsewhere in this function for CCMSG_TRANSCRIPT_PATH and friends.
  const sid =
    sidOverride ?? strField(process.env.CCMSG_SID) ?? strField(process.env.CLAUDE_CODE_SESSION_ID);
  // The daemon refuses a session hello whose sid is not a Claude Code session
  // id (the sid names its sidecar's socket and the envelopes it sends); refuse it
  // here first so the reason names the flag or variable it came from.
  if (sid && !isSessionIdShape(sid)) {
    throw new Error(
      `session id must be a Claude Code session id (lowercase UUID), got "${sid}" ` +
        "(from --sid / --as-session / CCMSG_SID / CLAUDE_CODE_SESSION_ID)",
    );
  }
  if (sid) {
    // CCMSG_REPO/CCMSG_WS env vars are an override knob (manual invocation,
    // tests) — when present they win over what `sidecar begin` wrote to the
    // session file. Absent, fall back to the file; absent there too, degrade
    // to "".
    const stored = readSessionFile(resolvePaths().stateDir, sid);
    // The transcript path is announced only through the override knob: no
    // writer of the state file knows it (the hooks module has no `$` that
    // says it), and without one the daemon finds the session's transcript
    // under its config dir (DR-0039 Consequences). Announced only if the file
    // it names exists — the daemon (DR-0009) checks path *shape*, not
    // existence.
    const transcriptPathCandidate = strField(process.env.CCMSG_TRANSCRIPT_PATH);
    const transcriptPath =
      transcriptPathCandidate !== undefined && fs.existsSync(transcriptPathCandidate)
        ? transcriptPathCandidate
        : undefined;
    // CCMSG_REPO_ROOT is the same override-knob pattern as CCMSG_REPO/CCMSG_WS
    // (manual invocation, tests) — env wins over the session file.
    // No existence/shape check here (unlike transcript_path's fs.existsSync):
    // the daemon's hello-time validation (DR-0008 addendum) is the actual trust
    // boundary (absolute + realpath-resolvable + strict ancestor of cwd + not
    // "/"/$HOME), so this CLI layer only needs to not forward a blank string.
    const repoRoot = strField(process.env.CCMSG_REPO_ROOT) ?? strField(stored?.repo_root);
    // CCMSG_BRANCH is the same override-knob pattern as CCMSG_REPO/CCMSG_WS/
    // CCMSG_REPO_ROOT (manual invocation, tests) — env wins over the
    // session file. Optional like repo_root (branch may be
    // unknown/detached), not defaulted to "" like repo/ws.
    const branch = strField(process.env.CCMSG_BRANCH) ?? strField(stored?.branch);
    // The config dir of THIS process is the session's own: the CLI runs as a
    // child of the Claude Code session, so it inherits whatever face that
    // session was launched under. Unset means Claude Code's default rather
    // than "unknown" (both ends of a comparison fall back to the same path),
    // so the flag still works for the common single-config-dir setup.
    const configDir = strField(process.env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude");
    // Where the session is, from the fixed sources alone (DR-0003 §3
    // 「所在の正本」): the CCMSG_CWD override knob, then the state file (the
    // session's project root as the hooks module read it), then
    // CLAUDE_PROJECT_DIR for a session whose state file never got written.
    // `process.cwd()` is deliberately not among them: this CLI runs as a child
    // of whichever Bash tool invocation called it, so its working directory is
    // wherever that tool last `cd`'d to — announcing it would move the session
    // there for everyone reading `peers`. Empty means
    // "not stated" and leaves the daemon holding what it registered before.
    const cwd =
      strField(process.env.CCMSG_CWD) ?? strField(stored?.cwd) ?? sessionProjectDir() ?? "";
    return {
      role: "session",
      sid,
      repo: strField(process.env.CCMSG_REPO) ?? strField(stored?.repo) ?? "",
      ws: strField(process.env.CCMSG_WS) ?? strField(stored?.ws) ?? "",
      cwd,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      ...(branch ? { branch } : {}),
      config_dir: configDir,
    };
  }
  return null;
}

/** stderr message + exit code for write ops invoked without a sid. Centralized
 * so every write op rejects the same way, and the
 * message names every env var and flag a caller might expect to work. */
function refuseWriteWithoutSid(cmd: string): never {
  process.stderr.write(
    `ccmsg: '${cmd}' requires a session identity; refusing to post as u1 (User).\n` +
      "  Set one of:\n" +
      "    CLAUDE_CODE_SESSION_ID=<sid>  (Claude Code's own env; auto-detected when exported)\n" +
      "    CCMSG_SID=<sid>            (explicit override, manual invocation / tests)\n" +
      "    --as-session <sid>         (explicit override on the command line)\n" +
      "  From a Claude Code session, CLAUDE_CODE_SESSION_ID is normally already set,\n" +
      "  so the bare command is enough.\n",
  );
  process.exit(1);
}

// --- output ----------------------------------------------------------------

function output<R extends { readonly ok?: boolean }>(res: R): number {
  const line = `${JSON.stringify(res)}\n`;
  if (res.ok === false) {
    process.stderr.write(line);
    return 1;
  }
  process.stdout.write(line);
  return 0;
}

// --- commands --------------------------------------------------------------

/** `ccmsg notify`: the result printed on stdout as it came, and the exit
 * status saying whether the notice arrived — a caller that has to know (a
 * justfile step) need not read the JSON. */
async function runNotify(identity: Identity, req: RequestInput & { op: "notify" }): Promise<never> {
  const paths = resolvePaths();
  const client = await ensureDaemon(paths, identity);
  const res = await client.request(req);
  client.close();
  if (!res.ok) process.exit(output(res));
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exit(res.result.outcome === "delivered" ? 0 : 1);
}

// --- sidecar ---------------------------------------------------------------

const SIDECAR_HELP = `ccmsg sidecar — the child process the ccmsg hooks module starts for its
session, and the way some of the module's tools go to the daemon. Not for
direct use.
`;

/** `ccmsg sidecar` (DR-0035 §3), `ccmsg sidecar begin` (DR-0039 §2), `ccmsg
 * sidecar launch` (DR-0018 §3.7) and `ccmsg sidecar permit` (DR-0040). All
 * are the hooks module's: it starts the first for its session's life, the
 * second when the session starts or changes its id, and the last two for its
 * `launch` and `permit` tools. What else the module asks the daemon, the
 * replies to the requests the first copies to it among them, goes over the
 * daemon's `POST /op` (DR-0046). The help says no more than that on purpose
 * (DR-0035 §4). */
async function runSidecarCommand(args: string[]): Promise<void> {
  const { positionals, opts } = parseArgs(args);
  if (opts.help === true) {
    process.stdout.write(SIDECAR_HELP);
    return;
  }
  if (positionals[0] === "launch") {
    await runSidecarLaunch(opts);
    return;
  }
  if (positionals[0] === "permit") {
    await runSidecarPermit(opts);
    return;
  }
  if (positionals[0] === "begin") {
    await runSidecarBegin(opts);
    return;
  }
  if (positionals.length > 0) {
    process.stderr.write(`ccmsg sidecar: unexpected argument '${positionals[0]}'\n`);
    process.exit(2);
  }
  await runSidecar(opts);
}

/** `ccmsg sidecar --sid <sid> --run <run id> --started-at <epoch ms>
 * [--config-dir <dir>] [--hyoui-session-id <id>]`: bind the run's socket and
 * keep the run named to the daemon (sidecar_hello) with what the module read
 * of the session — its CLAUDE_CONFIG_DIR and HYOUI_SESSION_ID through
 * `$.env.get`, and when it was loaded.
 *
 * Standard input is not read: the module's spawn closes it at once, so its
 * end says nothing about whether anybody still reads. What does is a write to
 * standard output failing, and the signal the harness sends the child when
 * the module goes. */
async function runSidecar(opts: Record<string, string | boolean>): Promise<never> {
  const sid =
    str(opts, "sid") ??
    strField(process.env.CCMSG_SID) ??
    strField(process.env.CLAUDE_CODE_SESSION_ID);
  if (sid === undefined || !isSessionIdShape(sid)) {
    process.stderr.write(`ccmsg sidecar: --sid must be a session id (got ${sid ?? "nothing"})\n`);
    process.exit(2);
  }
  const runId = str(opts, "run");
  if (runId === undefined || !parseWith(SidecarRunIdSchema, runId).ok) {
    process.stderr.write(
      `ccmsg sidecar: --run must be a run id: lowercase letters and digits (got ${runId ?? "nothing"})\n`,
    );
    process.exit(2);
  }
  const givenStart = str(opts, "started-at");
  const startedAt = Number(givenStart);
  if (givenStart === undefined || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
    process.stderr.write(
      `ccmsg sidecar: --started-at must be a time in epoch milliseconds (got ${givenStart ?? "nothing"})\n`,
    );
    process.exit(2);
  }
  const configDir = str(opts, "config-dir");
  const hyouiSessionId = str(opts, "hyoui-session-id");
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar");
  const paths = resolvePaths();
  let running: Sidecar;
  try {
    running = startSidecar({
      dir: paths.sidecars,
      sid,
      runId,
      out: (line, done) => {
        process.stdout.write(line, done);
      },
      outClosed: socketPeerClosed(1),
    });
  } catch (e) {
    process.stderr.write(
      `ccmsg sidecar: cannot bind: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }
  const stop = (): void => running.stop();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  process.stdout.on("error", stop);
  // A sidecar a test run started lives no longer than the run, as its daemons
  // do (test-lifeline.ts): neither a write failing nor stdout's socket ending
  // reaches one whose output is a pipe nobody writes to. Held before `ready`,
  // so a test that read `ready` knows the sidecar is held.
  const lifelinePath = process.env.CCMSG_TEST_LIFELINE;
  if (lifelinePath !== undefined && lifelinePath !== "") {
    const lifeline = await holdTestLifeline(lifelinePath, running.path, stop);
    void running.stopped.then(() => lifeline.release());
  }
  process.stderr.write(`ready ${running.path}\n`);
  const named = keepNamed({
    paths,
    identity,
    name: {
      runId,
      startedAt,
      ...(configDir !== undefined ? { configDir } : {}),
      ...(hyouiSessionId !== undefined ? { hyouiSessionId } : {}),
    },
    stopped: running.stopped,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const why = await running.stopped;
  await named;
  process.stderr.write(`${why} ${running.path}\n`);
  process.exit(0);
}

/** `ccmsg sidecar begin --sid <sid> --cwd <dir>`: the session `<sid>` began
 * (its start, or the id it has after /clear or /resume) in `<dir>`, its
 * project root. Writes the session's state file, which every CLI hello of the
 * session reads to name it, and brings the daemon up if none is running.
 * The module runs it without waiting on it, so the daemon's start does not
 * hold the session up. */
async function runSidecarBegin(opts: Record<string, string | boolean>): Promise<never> {
  const usage = "ccmsg sidecar begin --sid <sid> --cwd <dir>";
  const sid = str(opts, "sid");
  const cwd = str(opts, "cwd");
  if (sid === undefined || !isSessionIdShape(sid) || cwd === undefined || !path.isAbsolute(cwd)) {
    process.stderr.write(
      `ccmsg sidecar begin: --sid must be a session id and --cwd an absolute path\n  usage: ${usage}\n`,
    );
    process.exit(2);
  }
  const paths = resolvePaths();
  const { repo, ws, repoRoot, branch } = await getRepoWsFromVcs(cwd, {
    bin: resolveBumpSemverBin(),
  });
  writeSessionFile(paths.stateDir, sid, {
    cwd,
    ...(repo ? { repo } : {}),
    ...(ws ? { ws } : {}),
    ...(repoRoot ? { repo_root: repoRoot } : {}),
    ...(branch ? { branch } : {}),
    updated_at: new Date().toISOString(),
  });
  pruneOldSessionFiles(paths.stateDir);
  try {
    (await ensureDaemon(paths, { role: "user" })).close();
  } catch (e) {
    process.stderr.write(`ccmsg sidecar begin: the daemon did not come up: ${errorText(e)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

/** `ccmsg sidecar launch --sid <sid> < launch.json` (DR-0018 §3.7): ask the
 * daemon, as session `<sid>`, to start a session through its configured
 * launch command with the launch on standard input, and print the daemon's
 * session_launch reply (what the command did, uninterpreted), exiting 0. The
 * launch comes on standard input: its prompt may be long, and an argument is
 * bounded in size and shown to every user by `ps`.
 *
 * The reply waits for the launch command to end; nothing here times it out,
 * the module's wait does. Exits 3, nothing started, when no daemon can be
 * had; exits 1 with the daemon's refusal on standard error when it did not
 * run the command. */
async function runSidecarLaunch(opts: Record<string, string | boolean>): Promise<never> {
  const usage = "ccmsg sidecar launch --sid <sid> < launch.json";
  const read = parseWith(LaunchInputTextSchema, await Bun.stdin.text());
  if (!read.ok) {
    throw new Error(
      `standard input must be one launch as JSON: ${read.failure.summary}\n  usage: ${usage}`,
    );
  }
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar launch");
  const client = await daemonOrExit(identity, "sidecar launch");
  const res = await client.request({ op: "session_launch", launch: read.value });
  client.close();
  process.exit(output(res));
}

/** What the speakers say when a session asks for permission: that one is
 * asking. The request itself (its commands, its files) is for reading in the
 * webui, not for hearing. */
const PERMIT_SPEECH = "許可を求めています";

/** `ccmsg sidecar permit --sid <sid> < permit.json` (DR-0040): ask the
 * person, as session `<sid>`, for the permission the input on standard input
 * describes. The daemon records it and shows it in the session's Timeline;
 * then the speakers say that a session is asking, through the speech binary
 * `ccmsg say` speaks with. Prints the daemon's permit_request reply, exiting
 * 0, the speech having ended. The input comes on standard input: its
 * commands may be long, and an argument is bounded in size and shown to
 * every user by `ps`.
 *
 * Exits 3, nothing asked, when no daemon can be had; exits 1 with the
 * daemon's refusal on standard error when it did not record the request. A
 * speech that fails is said on standard error and does not change the exit:
 * the request is recorded, and the Timeline shows it. */
async function runSidecarPermit(opts: Record<string, string | boolean>): Promise<never> {
  const usage = "ccmsg sidecar permit --sid <sid> < permit.json";
  const read = parseWith(PermitInputTextSchema, await Bun.stdin.text());
  if (!read.ok) {
    throw new Error(
      `standard input must be one request for permission as JSON: ${read.failure.summary}\n  usage: ${usage}`,
    );
  }
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar permit");
  const client = await daemonOrExit(identity, "sidecar permit");
  const res = await client.request({ op: "permit_request", permit: read.value });
  client.close();
  if (res.ok) await speakPermitRequested();
  process.exit(output(res));
}

/** Say PERMIT_SPEECH and wait for it to end. Never throws: a speech binary
 * that cannot start or fails is said on standard error. */
async function speakPermitRequested(): Promise<void> {
  try {
    const speech = Bun.spawn(
      [process.env.CCMSG_SAY_BIN || SYSTEM_SAY, ...spokenArgs([PERMIT_SPEECH], "sidecar permit")],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    const spoke = await speech.exited;
    if (spoke !== 0) {
      process.stderr.write(`ccmsg sidecar permit: the speech exited ${String(spoke)}\n`);
    }
  } catch (e) {
    process.stderr.write(`ccmsg sidecar permit: the speech did not start: ${errorText(e)}\n`);
  }
}

/** The daemon, started if none runs; exit 3 with why when none can be had. */
async function daemonOrExit(identity: Identity, command: string): Promise<Client> {
  try {
    return await ensureDaemon(resolvePaths(), identity);
  } catch (e) {
    process.stderr.write(`ccmsg ${command}: the daemon could not be reached: ${errorText(e)}\n`);
    process.exit(3);
  }
}

// --- say -------------------------------------------------------------------

/** The real macOS speech binary. Absolute on purpose: a `say` shim earlier on
 * PATH is exactly what delegates here, so resolving through PATH again would
 * re-enter the shim and loop. */
const SYSTEM_SAY = "/usr/bin/say";

/** How long the say record may take before the speech goes ahead
 * without it. The event is a nicety (which session spoke); the speech is the
 * thing the caller asked for, so a wedged daemon must cost latency once, not
 * silence. */
const SAY_RECORD_TIMEOUT_MS = 1500;

function printSayHelp(): void {
  process.stdout.write(`ccmsg say — speak through ${SYSTEM_SAY}, and record which session spoke

Usage:
  ccmsg say [say-options] [text...]
  echo <text> | ccmsg say [say-options]

Every argument is forwarded to ${SYSTEM_SAY} in place — ccmsg defines no options
of its own here, so \`say\`'s own flags (-v, -r, -o, ...) work unchanged and a
PATH shim can delegate to this command without altering behaviour. The one
exception is a lone --help / -h, which prints this text (${SYSTEM_SAY} has no
--help of its own to shadow).

The words of the text to speak are first put as the reading dictionary says:
the one shipped with ccmsg, with <config dir>/say-dictionary.tsv laid over it
(one "word<TAB>reading" per line, "#" starts a comment; a word there wins over
the same word shipped), read afresh by every speech. A word matches without regard to case, only where
neither side is a letter or a digit ("daemon" in "_daemon_" and "の daemon で",
not in "daemonize"), the longest word first. Options and their values are not
touched, nor is a file given with -f. Text on standard input is replaced too,
unless standard input is a terminal. The session's timeline records the text
as it was written.

Before speaking, the session id in CCMSG_SID / CLAUDE_CODE_SESSION_ID is used to
tell the running daemon which session spoke, so the webui can answer "which
session just talked" when several are running: the text appears in that
session's timeline, unread until acked there. The daemon keeps this in memory
only, so a daemon restart forgets it. Speech happens either way: no
session id, no running daemon, or a daemon that errors all fall through to
${SYSTEM_SAY} unchanged.

Environment Variables:
  CCMSG_SAY_BIN                Speech binary to exec instead of ${SYSTEM_SAY}
                               (test hook — lets the say path be exercised
                               without producing audio)
  CCMSG_CONFIG_DIR             The config dir say-dictionary.tsv, the
                               reading dictionary, is read from
`);
}

/** Best-effort record of "this session spoke". Never throws, never blocks past
 * SAY_RECORD_TIMEOUT_MS, and deliberately does NOT spawn a daemon: the only
 * consumer of the event is the webui, which the daemon itself serves, so
 * starting one from a speech path would be a surprising side effect that
 * benefits nobody. */
async function recordSayEvent(args: string[]): Promise<void> {
  let identity: Identity | null;
  try {
    identity = resolveSessionIdentity({}, "say");
  } catch {
    // Not a session id: nothing to record it under, and the speech proceeds.
    return;
  }
  if (identity === null || identity.role !== "session") return;
  let client: Client | null = null;
  const timer = setTimeout(() => client?.close(), SAY_RECORD_TIMEOUT_MS);
  try {
    client = await connectIfRunning(resolvePaths());
    if (!client) return;
    const hello = await client.request(helloRequest(identity));
    if (!hello.ok) return;
    await client.request({ op: "say", text: args.join(" ") });
  } catch {
    // daemon down / socket closed under us / op rejected — the speech below is
    // what the caller asked for and it proceeds regardless.
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}

/**
 * `ccmsg say` (kawaz r244 m5-m6). Records the say event, then hands the exact
 * argv to the system `say`. Argument handling bypasses the CLI's own parser
 * entirely (see main()): `say -v Kyoko --whatever` must reach `say` byte for
 * byte, and a ccmsg option in the middle of that would be a landmine for the
 * shim's users.
 *
 * Design rationale (no-args does NOT print help, unlike every other ccmsg
 * command): bare `say` reads the text from stdin, and `echo hi | say` is a
 * real, commonly-shimmed usage. Printing help there would break the pipe form
 * that the PATH shim exists to preserve.
 */
async function runSay(args: string[]): Promise<never> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printSayHelp();
    process.exit(0);
  }
  await recordSayEvent(args);
  const bin = process.env.CCMSG_SAY_BIN || SYSTEM_SAY;
  // Text on standard input is read here only when it is not a terminal: on
  // a terminal say speaks it line by line as it is typed, which reading it
  // all first would take away.
  const stdinText = speechTextOf(args).fromStdin && process.stdin.isTTY !== true;
  const dict = stdinText ? sayDictionaryFor("say") : null;
  const proc = Bun.spawn([bin, ...spokenArgs(args, "say")], {
    stdin: dict === null ? "inherit" : new Blob([applySayDictionary(dict, await Bun.stdin.text())]),
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

/** The reading dictionary (DR-0042), its problems said on standard error as
 * `ccmsg <command>: …`. */
function sayDictionaryFor(command: string): SayDictionary {
  return loadSayDictionary(resolvePaths().sayDictionary, (m) =>
    process.stderr.write(`ccmsg ${command}: ${m}\n`),
  );
}

/** `args` for the speech binary, the words of the text to speak put as the
 * reading dictionary says (DR-0042). Options and their values pass
 * unchanged. */
function spokenArgs(args: readonly string[], command: string): string[] {
  const { words } = speechTextOf(args);
  if (words.length === 0) return [...args];
  const dict = sayDictionaryFor(command);
  const text = new Set(words);
  return args.map((a, i) => (text.has(i) ? applySayDictionary(dict, a) : a));
}

/** Ping an already-connected client and shape the result the way `status`/`daemon
 * start` report it (used by both so the two commands can't drift apart). Closes
 * `client` before returning. */
async function pingRunningStatus(
  client: Client,
  paths: ReturnType<typeof resolvePaths>,
): Promise<
  ReplyOf<"ping"> & { readonly running: true; readonly stateDir: string; readonly dataDir: string }
> {
  const pong = await client.request({ op: "ping" });
  client.close();
  return { running: true, ...pong, stateDir: paths.stateDir, dataDir: paths.dataDir };
}

async function runStatus(): Promise<never> {
  const paths = resolvePaths();
  const client = await connectIfRunning(paths);
  if (!client) {
    output({ ok: true, running: false, stateDir: paths.stateDir, dataDir: paths.dataDir });
    process.exit(0);
  }
  output(await pingRunningStatus(client, paths));
  process.exit(0);
}

/** `ccmsg daemon start` — idempotent detached bring-up. Spawns the daemon (via
 * `ensureDaemon`'s existing spawn path, same one every other command uses) only
 * when nothing is listening yet, then reports the same shape as `status`. Uses
 * the `{role: "user"}` fallback identity (no session context exists at this
 * entry point, same as `status`/`peers`). */
async function runDaemonStart(): Promise<never> {
  const paths = resolvePaths();
  const existing = await connectIfRunning(paths);
  if (existing) {
    output({ ...(await pingRunningStatus(existing, paths)), started: false });
    process.exit(0);
  }
  const client = await ensureDaemon(paths, { role: "user" });
  output({ ...(await pingRunningStatus(client, paths)), started: true });
  process.exit(0);
}

/** `ccmsg daemon restart` — stop the running daemon and bring a fresh one up in
 * its place, which is how an edited `<configDir>/config.{ts,js,json}` reaches a
 * live daemon: user configuration is read once at startup (DR-0018 LN-Q4) and
 * the `config.ts` path goes through a dynamic `import()`, whose module cache
 * hands back the first-loaded module for the rest of the process's life (a
 * cache-busting query does not defeat it under bun) — so no in-process reload
 * can observe the edit.
 *
 * The stop→respawn sequence is the same one `ensureDaemon` runs for a
 * client-driven version upgrade (shutdown, waitDaemonGone, spawn), reused here
 * rather than duplicated. Live sidecars and webui tabs reattach on their own
 * once the replacement is listening; the sidecars' no-spawn contract only
 * keeps them from resurrecting a daemon nobody replaced, and here the
 * restarting client is the one putting it back.
 *
 * With nothing running this degrades to `daemon start` (restarted:false,
 * started:true) instead of erroring — "make a current daemon be running" is the
 * ask either way. */
async function runDaemonRestart(): Promise<never> {
  const paths = resolvePaths();
  const existing = await connectIfRunning(paths);
  if (existing) {
    try {
      await existing.request({ op: "shutdown", reason: "restart" });
    } catch {
      // daemon may drop the connection without replying
    }
    existing.close();
    await waitDaemonGone(paths.sock);
  }
  const client = await ensureDaemon(paths, { role: "user" });
  output({
    ...(await pingRunningStatus(client, paths)),
    restarted: existing !== null,
    started: existing === null,
  });
  process.exit(0);
}

async function runDaemonStop(): Promise<never> {
  const paths = resolvePaths();
  const client = await connectIfRunning(paths);
  if (!client) {
    output({ ok: true, running: false });
    process.exit(0);
  }
  try {
    await client.request({ op: "shutdown", reason: "stop" });
  } catch {
    // daemon may drop the connection without replying
  }
  client.close();
  await waitDaemonGone(paths.sock);
  output({ ok: true, stopped: true });
  process.exit(0);
}

/** `ccmsg stop <session-id> [--force]` — terminate the OS process behind a
 * Claude Code session, via the same daemon op (`session_kill`, DR-0028) the
 * webui's Status tab danger-zone button uses. `session_kill` is user-role
 * only (DR-0028: session-role agents must never kill each other), so this
 * hellos as `{ role: "user" }` unconditionally — same posture as `daemon
 * start`/`stop`/`status` — rather than picking up CLAUDE_CODE_SESSION_ID via
 * resolveSessionIdentity, which would hello as role "session" and get
 * rejected. The reply takes up to ~4s (the daemon's resolve-pid +
 * two-shot-SIGTERM sequence), which `request` simply waits out. */
async function runSessionKill(sessionId: string, force: boolean): Promise<never> {
  const paths = resolvePaths();
  const client = await ensureDaemon(paths, { role: "user" });
  const reply = await client.request({
    op: "session_kill",
    session_id: sessionId,
    ...(force ? { force: true } : {}),
  });
  client.close();
  process.exit(output(reply));
}

/** `ccmsg agents [--format <json|text>]` — the daemon's agents rows (op
 * `agents`, the webui's Sessions list): every live Claude Code process in the
 * config dirs the daemon serves, with its status. `json` (the default, as every
 * other command prints) is the reply as it came; `text` is a table. The op is
 * user role only, so this hellos as `{ role: "user" }` unconditionally, as
 * `stop` does: inside a Claude Code session the session's own identity would be
 * refused. */
async function runAgents(format: AgentsFormat): Promise<never> {
  const client = await daemonOrExit({ role: "user" }, "agents");
  const res = await client.request({ op: "agents" });
  client.close();
  if (!res.ok || format === "json") process.exit(output(res));
  process.stdout.write(agentsTable(res, os.homedir()));
  process.exit(0);
}

async function handleDaemon(
  positionals: string[],
  opts: Record<string, string | boolean>,
): Promise<void> {
  const sub = positionals[0];
  if (sub === "start") {
    await runDaemonStart();
    return;
  }
  if (sub === "run") {
    // blocks: the listen socket keeps the event loop alive
    void runDaemon({ foreground: opts.foreground === true });
    return;
  }
  if (sub === "stop") {
    await runDaemonStop();
    return;
  }
  if (sub === "restart") {
    await runDaemonRestart();
    return;
  }
  process.stderr.write("ccmsg: usage: ccmsg daemon <start|run|stop|restart>\n");
  process.exitCode = 1;
}

// --- help ------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Commands:
  dump <session-id> [--since <ts>]          セッション会話を圧縮 JSONL/text で回収
  peers [cwd(partial)]                      セッション一覧
  agents [--format text]                    Claude Code のセッションと状態の一覧
  notify --self --text <msg>                自セッションの会話に一言入れる (justfile等の組み込み用途)
  say [say-options] [text...]               say で発声 + どのセッションが喋ったか記録

Options:
  --help-full
`);
}

function printFullHelp(): void {
  process.stdout.write(`ccmsg v${VERSION} — central-daemon messenger for Claude Code sessions

Usage:
  ccmsg <command> [args] [options]

Commands:
  dump <session-id>            Export session handoff context (todos, agents, rooms) +
                               conversation entries as compact jsonl (default) or readable
                               text (--format text). --since/--until accept a
                               timezone-qualified ISO 8601 timestamp or a transcript
                               record uuid. Agents the dumped range never
                               involves fold to one line each (--agent expands one);
                               --no-thinking / --no-agent trim further. --out writes the
                               jsonl to a file and prints only its path (bare --out
                               auto-names it under <data>/dumps/)
  peers [<cwd>]                List connected sessions; positional <cwd> filters
                               by substring match on each session's cwd
  agents                       List the live Claude Code sessions in the config
                               dirs the daemon serves: session id, Claude Code's
                               status (idle / busy / waiting / shell), whether
                               the main thread answers a turn, name, config
                               dir, cwd. Prints the daemon's reply as JSON;
                               --format text prints a table
  notify                       Put --text into a session's conversation, from this
                               session (--self / --sid). It arrives as a message
                               from another session does, and only in a session
                               running the ccmsg plugin's hooks module. Prints
                               the result; exits non-zero unless it arrived
  say [args...]                Speak via /usr/bin/say, first telling the daemon
                               which session spoke so the webui can show it in
                               that session's timeline. Every argument is
                               forwarded in place (say's own -v/-r/-o keep
                               working), the words of the text put as the
                               reading dictionary (say-dictionary.tsv) says;
                               speech
                               still happens when there is no
                               session id or no running daemon. Run
                               "ccmsg say --help" for the full description
  status                       Show daemon liveness / version / uptime / pid.
                               Does not start the daemon — use daemon start
  stop <session-id>            Terminate the OS process behind a Claude Code
                               session (same op the webui Status tab's
                               danger-zone button uses: resolve sid→pid fresh,
                               verify, two-shot SIGTERM, ~4s grace). Not to be
                               confused with "daemon stop", which stops the
                               ccmsg daemon itself. --force escalates to a
                               single SIGKILL instead (irreversible — only
                               after a graceful stop reported
                               terminated:false)
  sidecar                      The child process the ccmsg hooks module starts for
                               its session, and the way its replies go back.
                               Not for direct use
  origins [list]               List persisted extra allowed Origins (webui reverse proxy)
  origins add <origin>         Allow an Origin (e.g. "https://ccmsg.example.com"), effective immediately
  origins remove <origin>      Remove a persisted Origin
  version                      Print the ccmsg version and exit
  daemon start                 Start the daemon detached if not already running
                               (idempotent: prints the same status either way)
  daemon run [--foreground]    Run the daemon in this process
  daemon stop                  Gracefully stop the running daemon
  daemon restart               Stop the daemon and start a fresh one — how an
                               edited config.ts/js/json (see CCMSG_CONFIG_DIR)
                               takes effect, since configuration is read once
                               at startup. Starts the daemon if none was running.
                               Live sidecars and webui tabs reattach on their own

Command Options:
  --since <value>              dump: inclusive lower bound — an ISO 8601 timestamp with
                               timezone, or a transcript record uuid. A uuid cuts at that
                               record itself, so records sharing its timestamp are not
                               dragged in (the webui shows each record's uuid)
  --until <timestamp|uuid>     dump: inclusive upper bound, same two forms as --since
  --format <format>            dump: 'jsonl' (default) or 'text'
                               agents: 'json' (default) or 'text' (a table)
  --out [path]                 dump: write the jsonl to a file and print only its
                               path. Bare --out auto-names it
                               <data>/dumps/<sid>-<YYYYMMDD-HHmmss>.jsonl.
                               Conflicts with --format text (stdout is the
                               human-reading form)
  --no-thinking                dump: drop assistant thinking entries (recovery use —
                               conclusions already reached the transcript)
  --no-agent                   dump: drop the agents/workflows context and the
                               agent-spawn / agent-send / peer-message entries
                               (journal use — leaves thinking and ccmsg traffic)
  --agent <id|name>            dump: keep only the entries involving one agent —
                               its spawn prompt, the messages sent to it, its
                               replies. Takes an agent id, a teammate name, or an
                               unambiguous id prefix. Conflicts with --no-agent
  --self                       notify: target own session (default when no --sid)
  --sid <sid>                  notify: target session id
  --text <text>                notify: notification text
  --foreground                 daemon run: also log to stderr
  --force                      stop: escalate to a single SIGKILL instead of
                               the graceful two-shot SIGTERM sequence

Global Options:
  --sid <sid>                  Act as this session id (for 'notify', --sid is the
                               target instead; use --as-session to set identity there)
  --as-session <sid>           Act as this session id (works for every command)
  -h, --help                   Show the minimal command rail
  --help-full                  Show this complete reference
  --version                    Print the ccmsg version and exit

Notes:
  Write ops (notify) require a session
  identity (CCMSG_SID / CLAUDE_CODE_SESSION_ID / --as-session). Without one the
  CLI exits with a non-zero status rather than posting as the User (u1). The
  User admin identity is issued by the webui backend only; the CLI cannot act
  as u1 for write ops.
  Rooms are read-only: the webui shows the past rooms, and no command writes
  to one.
  No command sends to the person: their input reaches a session from the
  webui. A session sends to another session, and tells the person something,
  with the ccmsg plugin's tools (send / say / peers); its skill ccmsg says how.

Environment Variables:
  CCMSG_STATE_DIR              Override runtime dir (sock/lock/pid/log)
  CCMSG_CONFIG_DIR             Override config dir (config.ts, config.js, or
                               config.json, allowed-origins.json,
                               say-dictionary.tsv)
  CCMSG_DATA_DIR               Override data dir (rooms/<id>.jsonl read-only,
                               dumps/*.jsonl)
  CCMSG_SID / CLAUDE_CODE_SESSION_ID  Session id for identity auto-detection.
                               CLAUDE_CODE_SESSION_ID is normally already set
                               inside a Claude Code session; CCMSG_SID is an
                               explicit override (wins when both are set,
                               manual invocation / tests). Both are ignored
                               for --as-session.
  CCMSG_REPO / CCMSG_WS        Session metadata (repo / workspace) sent in hello
  CCMSG_BRANCH                 Current branch/bookmark of the session's checkout,
                               sent in hello (informational, webui session list)
  CCMSG_TRANSCRIPT_PATH        This session's Claude Code transcript jsonl path,
                               sent in hello (DR-0009); adopted only if the
                               daemon accepts it. Unset, the daemon finds the
                               transcript under the session's config dir
  CCMSG_REPO_ROOT              Absolute path of this repo's workspace/worktree
                               container, sent in hello (DR-0008 addendum;
                               the session's state file carries it otherwise);
                               adopted only if the daemon accepts it (widens
                               fs_list/fs_read to sibling workspaces instead of
                               just cwd)
  CCMSG_SAY_BIN                say / sidecar permit: speech binary to exec instead
                               of /usr/bin/say (test hook — exercise the path
                               without audio)
  CCMSG_HTTP_BIND              webui/HTTP binds, comma-separated host:port
                               (daemon side, default 127.0.0.1:8642,[::1]:8642,
                               "off" to disable)
  CCMSG_HTTP_ALLOW             webui/HTTP source-IP allowlist, comma-separated CIDR/IP
                               (daemon side, default 127.0.0.0/8,::1 — loopback only)
  CCMSG_HTTP_ALLOW_ORIGIN      extra allowed browser Origin values, comma-separated
                               (daemon side, e.g. https://<machine>.<tailnet>.ts.net
                               for tailscale serve; loopback origins allowed by default)
`);
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    return;
  }
  // `say` takes over argv before the shared parser runs: its arguments belong
  // to /usr/bin/say, not to ccmsg (runSay's doc comment). This also means a
  // global option like --sid is passed through to say rather than consumed —
  // intentional, the shim contract is "same arguments as say".
  if (argv[0] === "say") {
    await runSay(argv.slice(1));
    return;
  }
  // Ahead of the shared help handling, so `ccmsg sidecar --help` prints the
  // sidecar's own line rather than the command rail.
  if (argv[0] === "sidecar") {
    await runSidecarCommand(argv.slice(1));
    return;
  }
  // Parse the whole argv so options may appear before or after the command (kawaz
  // CLI convention: option position is not fixed). The first positional is the command.
  const { positionals, opts } = parseArgs(argv);
  if (opts["help-full"] === true) {
    printFullHelp();
    return;
  }
  if (opts.version === true || positionals[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [cmd, ...args] = positionals;
  if (opts.help === true || cmd === undefined) {
    printHelp();
    return;
  }

  if (cmd === "daemon") {
    await handleDaemon(args, opts);
    return;
  }

  // `stop` hellos as role "user" unconditionally (see runSessionKill's doc
  // comment) — handled before resolveSessionIdentity so a caller running
  // inside a Claude Code session (CLAUDE_CODE_SESSION_ID set) doesn't get its
  // own sid picked up as the identity and rejected by session_kill's
  // user-role gate.
  if (cmd === "stop") {
    const usage = "ccmsg stop <session-id> [--force]";
    const sid = requireArg(args[0], "session-id", usage);
    await runSessionKill(sid, opts.force === true);
    return;
  }

  // `agents` hellos as role "user" too (runAgents' doc comment), for the same
  // reason as `stop`.
  if (cmd === "agents") {
    const usage = "ccmsg agents [--format <json|text>]";
    if (args[0] !== undefined)
      throw new Error(`unexpected argument "${args[0]}"\n  usage: ${usage}`);
    const format = str(opts, "format") ?? "json";
    if (format !== "json" && format !== "text") {
      throw new Error(`--format must be 'json' or 'text' (got '${format}')\n  usage: ${usage}`);
    }
    await runAgents(format);
    return;
  }

  const sessionIdentity = resolveSessionIdentity(opts, cmd);
  // Write ops refuse to run without a sid — silently degrading to u1 was the
  // masquerade bug (docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md).
  if (sessionIdentity === null && WRITE_OPS.has(cmd)) refuseWriteWithoutSid(cmd);
  // Observe ops fall back to user role: peers/status don't need identity, but
  // hello with role=user is harmless and uniform.
  const identity: Identity = sessionIdentity ?? { role: "user" };

  switch (cmd) {
    case "dump": {
      const usage =
        "ccmsg dump <session-id> [--out [path]] [--since <timestamp|uuid>] [--until <timestamp|uuid>] [--format <jsonl|text>] [--no-thinking] [--no-agent] [--agent <id|name>]";
      const sid = requireArg(args[0], "session-id", usage);
      if (args[1] !== undefined)
        throw new Error(`unexpected argument "${args[1]}"\n  usage: ${usage}`);
      const format = str(opts, "format") ?? "jsonl";
      if (format !== "jsonl" && format !== "text") {
        throw new Error(`--format must be 'jsonl' or 'text' (got '${format}')\n  usage: ${usage}`);
      }
      // `--out` (bare) auto-names inside the daemon's dumps/, `--out <path>`
      // names the file. The file is always JSONL — it exists to be read back
      // by another session, and `--format text` is the human-reading form that
      // stdout already serves. Refusing the combination beats silently
      // ignoring one of the two flags.
      const out = opts.out;
      if (out !== undefined && format === "text") {
        throw new Error(`--out writes JSONL; drop --format text\n  usage: ${usage}`);
      }
      const paths = resolvePaths();
      const dump = await dumpSession(sid, {
        dataDir: paths.dataDir,
        ...(str(opts, "since") ? { since: str(opts, "since") } : {}),
        ...(str(opts, "until") ? { until: str(opts, "until") } : {}),
        ...(opts["no-thinking"] === true ? { noThinking: true } : {}),
        ...(opts["no-agent"] === true ? { noAgent: true } : {}),
        ...(str(opts, "agent") ? { agent: str(opts, "agent") } : {}),
      });
      if (out !== undefined) {
        const file = writeSessionDumpFile(
          dump,
          typeof out === "string" ? { file: out } : { dir: paths.dumps },
        );
        // Path only: the caller's next move is to hand this to something else,
        // so anything beside it would have to be stripped back off.
        process.stdout.write(`${file}\n`);
        return;
      }
      if (format === "text") {
        process.stdout.write(formatTextDump(dump));
      } else {
        process.stdout.write(formatJsonlDump(dump));
      }
      return;
    }
    case "peers": {
      // RL-Q2 (kawaz r26 mid=104、裁定=a): help `peers [cwd(partial)]` に合わせ
      // positional 引数を cwd 部分一致 filter として実装する。絞りは CLI 側で
      // 行う (webui の op:"peers" を汚さない方針、interface-wording
      // rule 準拠)。
      const cwdFilter = args[0];
      const client = await ensureDaemon(resolvePaths(), identity);
      const res = await client.request({ op: "peers" });
      client.close();
      if (!res.ok) process.exit(output(res));
      const peers = res.peers.filter(
        (p) => typeof cwdFilter !== "string" || cwdFilter === "" || p.cwd.includes(cwdFilter),
      );
      process.exit(output({ ...res, peers }));
      return;
    }
    case "notify": {
      const text = requireArg(
        str(opts, "text"),
        "text",
        "ccmsg notify [--self | --sid <sid>] --text <text>",
      );
      const sid = str(opts, "sid");
      await runNotify(identity, { op: "notify", ...(sid ? { sid } : {}), text });
      return;
    }
    case "status": {
      await runStatus();
      return;
    }
    case "origins": {
      runOrigins(args);
      return;
    }
    default: {
      process.stderr.write(`ccmsg: unknown command '${cmd}'\n\n`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }
}

/** `ccmsg origins <list|add|remove> [origin]` — manage the persisted extra
 * allowed Origins file (<configDir>/allowed-origins.json) that the daemon's
 * Origin check consults on misses (origins-file.ts). Pure file manipulation,
 * no daemon round-trip: the daemon re-reads the file on its next failing
 * Origin lookup, so an add here is live from the next request. Origins are
 * scheme://host[:port] with no path/trailing slash (the exact string a
 * browser sends in the Origin header). */
function runOrigins(args: string[]): void {
  const usage =
    "ccmsg origins list | ccmsg origins add <origin> | ccmsg origins remove <origin>\n" +
    '  <origin> は scheme://host[:port] 形式 (例: "https://ccmsg.example.com")';
  const paths = resolvePaths(process.env);
  // The daemon migrates on startup, but `ccmsg origins` is pure file
  // manipulation that runs with no daemon in sight — migrate here too so an
  // add never lands in a fresh configDir while the legacy file still holds the
  // origins the user added earlier.
  migrateLegacyConfigFiles(paths, {
    info: (m) => process.stderr.write(`ccmsg: ${m}\n`),
    warn: (m) => process.stderr.write(`ccmsg: ${m}\n`),
  });
  const file = paths.allowedOrigins;
  // A file that is missing reads as no origins. One that does not read is
  // refused rather than taken as empty: `add` / `remove` would overwrite it
  // with what was read, dropping every origin it held.
  const load = (): readonly string[] => {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return [];
      throw e;
    }
    const origins = parseWith(AllowedOriginsTextSchema, text);
    if (!origins.ok) {
      throw new Error(
        `${file} is not a JSON array of origins (${origins.failure.summary}); fix or delete it`,
      );
    }
    return origins.value;
  };
  const save = (origins: readonly string[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(origins, null, 2)}\n`);
  };
  const sub = args[0];
  switch (sub) {
    case "list":
    case undefined: {
      process.stdout.write(`${JSON.stringify({ ok: true, file, origins: load() })}\n`);
      return;
    }
    case "add": {
      const origin = requireArg(args[1], "origin", usage);
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`invalid origin (not a URL): ${origin}\n${usage}`);
      }
      if (parsed.origin !== origin) {
        throw new Error(
          `invalid origin: ${origin} — use the exact origin form ${parsed.origin} (no path / trailing slash)`,
        );
      }
      const loaded = load();
      const already = loaded.includes(origin);
      const origins = already ? loaded : [...loaded, origin];
      if (!already) save(origins);
      process.stdout.write(`${JSON.stringify({ ok: true, origin, already, origins })}\n`);
      return;
    }
    case "remove": {
      const origin = requireArg(args[1], "origin", usage);
      const origins = load();
      const removed = origins.includes(origin);
      if (removed) save(origins.filter((o) => o !== origin));
      process.stdout.write(`${JSON.stringify({ ok: true, origin, removed, origins: load() })}\n`);
      return;
    }
    default:
      throw new Error(`unknown origins subcommand '${sub}'\n${usage}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ccmsg: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// re-export for tests / embedding
export { Client, ensureDaemon };
