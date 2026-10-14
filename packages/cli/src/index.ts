#!/usr/bin/env bun
// ccmsg CLI. Subcommand style, long options, no-args prints help (per kawaz CLI
// conventions). Every command except `daemon run` goes through ensure-daemon.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AllowedOriginsTextSchema,
  type AddressSendReason,
  DIRECT_DELIVERY_USER_SENDER,
  DIRECT_SEND_UNCONFIRMED_EXIT,
  VERSION,
  directAddressSid,
  errorText,
  isDirectMid,
  isSessionIdShape,
  migrateLegacyConfigFiles,
  parseWith,
  SessionFactsTextSchema,
  SessionStateFileTextSchema,
  SidecarReplyTextSchema,
  SidecarRunIdSchema,
  SinceSeqTextSchema,
  splitSendWords,
  resolvePaths,
  sessionProjectDir,
  type Identity,
  type MessageSendReason,
  type MessageSendRequest,
  type ReplyOf,
  type RequestInput,
  type SendMessageResult,
  type SessionStateFile,
} from "@ccmsg/protocol";
import { runDaemon } from "@ccmsg/daemon/run";
import {
  dumpSession,
  formatJsonlDump,
  formatTextDump,
  writeSessionDumpFile,
} from "@ccmsg/daemon/session-dump";
import {
  Client,
  connectIfRunning,
  helloRequest,
  ensureDaemon,
  reconnectSubscribeNoSpawn,
  sendFactsNoSpawn,
  waitDaemonGone,
} from "./client.ts";
import { watchSubscribeOwner } from "./subscribe-owner.ts";
import { keepNamed, type Sidecar, startSidecar } from "./sidecar.ts";

// --- arg parsing -----------------------------------------------------------

const BOOL_FLAGS = new Set([
  "all",
  "exclude-self",
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
 * prevent-u1-masquerade-on-missing-sid.md). read/rooms/peers/status stay
 * available identity-less because they only observe. subscribe also stays
 * available (with a stderr warning) so kawaz can observe as u1 until the
 * webui is up. */
const WRITE_OPS = new Set(["post", "reply", "create-room", "next-room", "leave", "notify"]);

interface Parsed {
  positionals: string[];
  opts: Record<string, string | boolean>;
  /** Where in the parsed words the first positional (the command) is. */
  commandAt?: number;
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};
  let commandAt: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--") {
      if (i + 1 < args.length) commandAt ??= i + 1;
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
      commandAt ??= i;
      positionals.push(a);
    }
  }
  return { positionals, opts, ...(commandAt !== undefined ? { commandAt } : {}) };
}

/** `post` / `reply` read again: the words after the command by
 * splitSendWords, which the timeline and the dump read them with too, so a
 * body holding `--foo` or written without quotes is sent as they show it.
 * The words before the command are read as for any command. The body, when
 * there is one, is the last positional, its words joined by one space. */
function parseSendArgs(argv: string[], commandAt: number): Parsed {
  const before = parseArgs(argv.slice(0, commandAt));
  const split = splitSendWords(argv.slice(commandAt + 1), 1);
  const opts = { ...before.opts };
  for (const [name, value] of split.options) {
    opts[name === "-h" ? "help" : name.replace(/^--/, "")] = value;
  }
  return {
    positionals: [
      ...argv.slice(commandAt, commandAt + 1),
      ...split.leading,
      ...(split.body.length > 0 ? [split.body.join(" ")] : []),
    ],
    opts,
  };
}

function str(opts: Record<string, string | boolean>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

function parseIdList(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  const out = s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return out.length > 0 ? out : undefined;
}

function requireArg(v: string | undefined, name: string, usage: string): string {
  if (v === undefined || v === "") throw new Error(`missing <${name}>\n  usage: ${usage}`);
  return v;
}

function parseReadArgs(args: string[], usage: string): { room: string; mids: string } {
  const [, room, mids] = args[0]?.match(/^(r\d+)m(\d+(?:,m\d+)*)$/) ?? [];
  if (room !== undefined && mids !== undefined) {
    if (args[1] !== undefined)
      throw new Error(`unexpected argument "${args[1]}"\n  usage: ${usage}`);
    return { room, mids: mids.replaceAll(",m", ",") };
  }
  return {
    room: requireArg(args[0], "room", usage),
    mids: requireArg(args[1], "mids", usage),
  };
}

// --- identity --------------------------------------------------------------

/** Mirrors hooks/session-start.ts's sessionFilePath. */
function sessionFilePath(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.json`);
}

/** Best-effort read of the hook-written session state file. Missing file,
 *  unreadable, or not of the state file's shape all resolve to undefined —
 *  this is an optional enrichment (repo/ws/transcript_path for a richer hello),
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
 * (subscribe/read/rooms/peers/status) treat null as user role (with a stderr
 * warning for subscribe). */
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
  // exported into Bash/Monitor subprocesses, so this is the normal path a
  // hook-suggested bare `ccmsg subscribe` resolves through). `strField`
  // collapses empty strings to undefined so `CCMSG_SID=""` (a shell/CI env
  // accident) doesn't shadow a real CLAUDE_CODE_SESSION_ID; same pattern used
  // elsewhere in this function for CCMSG_TRANSCRIPT_PATH and friends.
  const sid =
    sidOverride ?? strField(process.env.CCMSG_SID) ?? strField(process.env.CLAUDE_CODE_SESSION_ID);
  // The daemon refuses a session hello whose sid is not a Claude Code session
  // id (the sid is written into reply lines other sessions run); refuse it
  // here first so the reason names the flag or variable it came from.
  if (sid && !isSessionIdShape(sid)) {
    throw new Error(
      `session id must be a Claude Code session id (lowercase UUID), got "${sid}" ` +
        "(from --sid / --as-session / CCMSG_SID / CLAUDE_CODE_SESSION_ID)",
    );
  }
  if (sid) {
    // CCMSG_TRANSCRIPT_PATH/CCMSG_REPO/CCMSG_WS env vars are an override knob
    // (manual invocation, tests) — when present they win over whatever the
    // SessionStart hook wrote to the session file. Absent,
    // fall back to the file; absent there too, degrade to "" / no
    // transcript_path exactly like a session with no hook-derived metadata at
    // all always has.
    const stored = readSessionFile(resolvePaths().stateDir, sid);
    const transcriptPathCandidate =
      strField(process.env.CCMSG_TRANSCRIPT_PATH) ?? strField(stored?.transcript_path);
    // Only announce transcript_path if the file it names still exists — the
    // session file is written once at hook time and read here, possibly much
    // later; the transcript could have been rotated/removed meanwhile, and the
    // daemon (DR-0009) only checks path *shape*, not existence.
    const transcriptPath =
      transcriptPathCandidate !== undefined && fs.existsSync(transcriptPathCandidate)
        ? transcriptPathCandidate
        : undefined;
    // CCMSG_REPO_ROOT is the same override-knob pattern as CCMSG_REPO/CCMSG_WS
    // (manual invocation, tests) — env wins over the hook-written session file.
    // No existence/shape check here (unlike transcript_path's fs.existsSync):
    // the daemon's hello-time validation (DR-0008 addendum) is the actual trust
    // boundary (absolute + realpath-resolvable + strict ancestor of cwd + not
    // "/"/$HOME), so this CLI layer only needs to not forward a blank string.
    const repoRoot = strField(process.env.CCMSG_REPO_ROOT) ?? strField(stored?.repo_root);
    // CCMSG_BRANCH is the same override-knob pattern as CCMSG_REPO/CCMSG_WS/
    // CCMSG_REPO_ROOT (manual invocation, tests) — env wins over the
    // hook-written session file. Optional like repo_root (branch may be
    // unknown/detached), not defaulted to "" like repo/ws.
    const branch = strField(process.env.CCMSG_BRANCH) ?? strField(stored?.branch);
    // The config dir of THIS process is the session's own: the CLI runs as a
    // child of the Claude Code session, so it inherits whatever face that
    // session was launched under. Unset means Claude Code's default rather
    // than "unknown" (both ends of a comparison fall back to the same path),
    // so the flag still works for the common single-config-dir setup.
    const configDir = strField(process.env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude");
    // Where the session is, from the fixed sources alone (DR-0003 §3
    // 「所在の正本」): the CCMSG_CWD override knob, then the hook-written state
    // file (SessionStart's cwd, taken before the session ran anything), then
    // CLAUDE_PROJECT_DIR for a session whose state file never got written.
    // `process.cwd()` is deliberately not among them: this CLI runs as a child
    // of whichever Bash tool invocation called it, so its working directory is
    // wherever that tool last `cd`'d to — announcing it would move the session
    // there for everyone reading `peers` or a room's member events. Empty means
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
 * so post/create-room/next-room/leave/notify all reject the same way, and the
 * message names every env var and flag a caller might expect to work. */
function refuseWriteWithoutSid(cmd: string): never {
  process.stderr.write(
    `ccmsg: '${cmd}' requires a session identity; refusing to post as u1 (User).\n` +
      "  Set one of:\n" +
      "    CLAUDE_CODE_SESSION_ID=<sid>  (Claude Code's own env; auto-detected when exported)\n" +
      "    CCMSG_SID=<sid>            (explicit override, manual invocation / tests)\n" +
      "    --as-session <sid>         (explicit override on the command line)\n" +
      "  From a Claude Code session, CLAUDE_CODE_SESSION_ID is normally already set,\n" +
      "  so a bare `ccmsg subscribe` (or other command) is enough.\n",
  );
  process.exit(1);
}

/** Subscribe stays open under an identity-less env (kawaz's u1 observation
 * path, until webui is up). Warns loudly on stderr so a session sidecar that
 * lost its CCMSG_SID doesn't silently degrade into a no-op observer with no
 * peers entry and no echo suppression. stdout stays pure jsonl (Monitor
 * downstream). */
function warnSubscribingAsUser(): void {
  process.stderr.write(
    "ccmsg subscribe: no session id (CLAUDE_CODE_SESSION_ID / CCMSG_SID unset) — " +
      "subscribing as the User (u1). No peers entry, no echo suppression. " +
      "Inside a Claude Code session, CLAUDE_CODE_SESSION_ID is normally already set, " +
      "so a bare `ccmsg subscribe` is enough; for a manual sidecar, set CCMSG_SID=<session_id>.\n",
  );
}

// --- output ----------------------------------------------------------------

function output<R extends { readonly ok?: boolean }>(res: R): number {
  const line = `${JSON.stringify(res)}\n`;
  if (res.ok === false) {
    process.stderr.write(line);
    return 1;
  }
  // DR-0013 §2.9: daemon が付けた non-fatal warning (現状は broadcast の
  // --members 無視) は stderr に別行で流す。stdout の JSON にも `warning` は
  // 残しているので、pipeline consumer は JSON 側だけを見ていれば従来通り動く
  // — stderr 側は kawaz や AI が対話中に「その --members は意味がなかった」と
  // 気付くための誘導。
  if ("warning" in res && typeof res.warning === "string" && res.warning !== "") {
    process.stderr.write(`ccmsg: ${res.warning}\n`);
  }
  process.stdout.write(line);
  return 0;
}

// --- commands --------------------------------------------------------------

async function runOnce(identity: Identity, req: RequestInput): Promise<never> {
  const paths = resolvePaths();
  const client = await ensureDaemon(paths, identity);
  const res = await client.request(req);
  client.close();
  process.exit(output(res));
}

// --- direct send (DR-0036 §1) ---------------------------------------------

/** A room id (`r<N>`): `post` with one is a room post, with anything else a
 * direct send to a session. */
const ROOM_ID_RE = /^r\d+$/;

/** The sid a recipient argument names: a bare sid or the `ccmsg:<sid>` address.
 * The person is no recipient (DR-0036 §3), so `user` is refused with where
 * that traffic goes instead. */
function directRecipient(address: string): string {
  const sid = directAddressSid(address);
  if (sid === DIRECT_DELIVERY_USER_SENDER) {
    throw new Error(
      "セッションから人へは送れない。人の入力は webui から届き、人に知らせるには PushNotification を使う",
    );
  }
  if (!isSessionIdShape(sid)) {
    throw new Error(
      `宛先はセッション ID (ccmsg peers に出る sid) か ccmsg:<sid> で書く: ${address}`,
    );
  }
  return sid;
}

/** What a sender's agent reads when its message did not arrive: why, and what
 * it can do next. The message is held nowhere, so resending is its call. */
const NOT_DELIVERED: Record<MessageSendReason, (to: string) => string> = {
  session_not_found: (to) =>
    `宛先のセッション ${to} を daemon が知らない (終了したか、sid の誤り)。ccmsg peers で今いるセッションの sid を確かめて送り直すか、送るのをやめる`,
  no_config_dir: () =>
    "daemon が宛先のセッションの config dir を知らないため、peer socket を探せない。送り直しても同じ結果になるので、送るのをやめる",
  no_peer_socket: () =>
    "宛先のセッションの peer socket が見つからない (セッションが終了した、別の config dir で動いている、または peer messaging に対応しない Claude Code)。ccmsg peers で宛先がまだ居るか確かめ、居なければ送るのをやめる",
  no_status_socket: () =>
    "送り手側で、受け手からの受領拒否の知らせを受ける socket を作れなかったため、送っていない (届いたか確かめられない送り方はしない)。daemon の側の問題なので、少し置いて一度だけ送り直し、また同じなら送るのをやめる",
  unreachable: () =>
    "宛先のセッションの peer socket に書き込めなかった (終了した直後か、応答しない)。少し置いて一度だけ送り直すか、送るのをやめる",
  refused: () =>
    "宛先のセッションが受け取りを拒否した。送り直しても拒否されうるので、時間を置いて送り直すか、送るのをやめる",
};

/** One message_send. A delivered message prints `{"delivered":true,"mid":…}`
 * on stdout. Anything else is a line of text on stderr and a non-zero exit —
 * never JSON carrying `ok`, which the timeline and dump read as the room CLI's
 * answer and leave out (classifyCcmsgSendResult). One that may or may not have
 * arrived exits DIRECT_SEND_UNCONFIRMED_EXIT, which they read as such. */
async function runDirectSend(
  identity: Identity,
  req: Omit<MessageSendRequest, "op">,
): Promise<never> {
  const client = await ensureDaemon(resolvePaths(), identity);
  const res = await client.request({
    op: "message_send",
    ...req,
  });
  client.close();
  if (!res.ok) {
    process.stderr.write(`ccmsg: 送れなかった (${res.error.code}): ${res.error.msg}\n`);
    process.exit(1);
  }
  if (res.outcome === "delivered") {
    process.stdout.write(`${JSON.stringify({ delivered: true, mid: res.mid })}\n`);
    process.exit(0);
  }
  if (res.outcome === "unconfirmed") {
    process.stderr.write(
      `ccmsg: 届いたか確かめられなかった (unconfirmed)。宛先のセッションの peer socket への書き込みが途中で時間切れになり、届いたかどうか分からない。届いていれば相手には mid ${res.mid} として見えている。送り直すと二重に届くかもしれないので、まず相手の返事を待ち、送り直す時は重複しうることを本文に書く\n`,
    );
    process.exit(DIRECT_SEND_UNCONFIRMED_EXIT);
  }
  process.stderr.write(
    `ccmsg: 届かなかった (${res.reason})。メッセージは daemon に残らない。${NOT_DELIVERED[res.reason](req.to)}\n`,
  );
  process.exit(1);
}

// --- sidecar ---------------------------------------------------------------

const SIDECAR_HELP = `ccmsg sidecar — the child process the ccmsg hooks module starts for its
session, and the way the module's replies, what it knows of its session, and
the SendMessage messages it takes over go to the daemon. Not for direct use.
`;

/** `ccmsg sidecar`, `ccmsg sidecar reply`, `ccmsg sidecar facts` (DR-0035
 * §3) and `ccmsg sidecar send` (DR-0037 §2). All are the hooks module's: it
 * starts the first for its session's life, runs the second to answer a
 * request the first copied to it, the third to hand the daemon what it knows
 * of its session, and the fourth to send a SendMessage to a `ccmsg:` address.
 * The help says no more than that on purpose (DR-0035 §4). */
async function runSidecarCommand(args: string[]): Promise<void> {
  const { positionals, opts } = parseArgs(args);
  if (opts.help === true) {
    process.stdout.write(SIDECAR_HELP);
    return;
  }
  if (positionals[0] === "reply") {
    await runSidecarReply(opts);
    return;
  }
  if (positionals[0] === "send") {
    await runSidecarSend(positionals.slice(1), opts);
    return;
  }
  if (positionals[0] === "facts") {
    await runSidecarFacts(opts);
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

/** The reply is read from standard input, not taken as an argument: a reply
 * carries whatever its op returns, which may be long, and an argument is
 * bounded by the system's argument size and shown to every user by `ps`. The
 * module writes it there with `$.process.run`'s `stdin`, which is written once
 * and closed, so the end of input is the end of the reply. */
async function runSidecarReply(opts: Record<string, string | boolean>): Promise<never> {
  const usage = "ccmsg sidecar reply --sid <sid> < reply.json";
  const read = parseWith(SidecarReplyTextSchema, await Bun.stdin.text());
  if (!read.ok) {
    throw new Error(
      `standard input must be one JSON reply: ${read.failure.summary}\n  usage: ${usage}`,
    );
  }
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar reply");
  return runOnce(identity, { op: "sidecar_reply", reply: read.value });
}

/** `ccmsg sidecar facts --sid <sid> < facts.json`: hand the daemon what the
 * hooks module knows of its session (session_facts), read from standard input
 * for the reason a reply is. No daemon is started: facts that find none
 * listening are dropped, and exit 0 says so on stderr — the module has
 * nothing to do about it, and the next daemon asks the module for its facts
 * when the run's sidecar names the run. */
async function runSidecarFacts(opts: Record<string, string | boolean>): Promise<never> {
  const usage = "ccmsg sidecar facts --sid <sid> < facts.json";
  const read = parseWith(SessionFactsTextSchema, await Bun.stdin.text());
  if (!read.ok) {
    throw new Error(
      `standard input must be the session's facts as JSON: ${read.failure.summary}\n  usage: ${usage}`,
    );
  }
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar facts");
  if (!(await sendFactsNoSpawn(resolvePaths(), identity, read.value))) {
    process.stderr.write("ccmsg sidecar facts: no daemon took the facts; dropped\n");
  }
  process.exit(0);
}

/** What the sending agent reads when its SendMessage reached nobody: why,
 * and what it can do next. Inside the harness's "Not sent: a plugin hook
 * refused it (<reason>)", so no parenthesis of its own. */
const ADDRESS_NOT_DELIVERED: Record<AddressSendReason, (to: string) => string> = {
  invalid_address: (to) =>
    `宛先 ${to} は ccmsg:<sid>、ccmsg:<sid>.<pid>、ccmsg:path:<絶対パス> のどれでもない。ccmsg peers で宛先の綴りを確かめて送り直す`,
  self: (to) => `宛先 ${to} は送り主自身のセッションなので送らない`,
  no_recipient: (to) =>
    `宛先 ${to} に当たる生きているセッションが無い。終了したか、sid や pid の誤りか、そのディレクトリで動くセッションが送り主のほかに無い。ccmsg peers で今いるセッションの宛先を確かめて送り直すか、送るのをやめる`,
  no_peer_socket: () =>
    "宛先のセッションの peer socket が見つからない。終了した直後か、peer messaging に対応しない Claude Code。ccmsg peers で宛先がまだ居るか確かめ、居なければ送るのをやめる",
  no_status_socket: () =>
    "受け手の受領拒否を聞く socket を送り手側で作れなかったため、送っていない。daemon の側の問題なので、少し置いて一度だけ送り直し、また同じなら送るのをやめる",
  unreachable: () =>
    "宛先のセッションの peer socket に書き込めなかった。終了した直後か、応答しない。少し置いて一度だけ送り直すか、送るのをやめる",
  refused: () =>
    "宛先のセッションが受け取りを拒否した。送り直しても拒否されうるので、時間を置いて送り直すか、送るのをやめる",
};

/** The reason for a send whose arrival cannot be told: sending again may
 * deliver it twice. */
const ADDRESS_SEND_UNCONFIRMED =
  "届いたか確かめられなかった。宛先の peer socket への書き込みが途中で時間切れになった。送り直すと二重に届くかもしれないので、まず相手の返事を待ち、送り直す時は重複しうることを本文に書く";

/** `ccmsg sidecar send --sid <sid> --to <address> <file>` (DR-0037 §2): send
 * the text in `<file>` to a `ccmsg:` address as session `<sid>`, and print the
 * result the hooks module hands the harness for the SendMessage it took over
 * — `{"isDelivered":true}` or `{"isDelivered":false,"reason":…}` — exiting 0.
 * Only arguments that do not make a send exit non-zero, with why on stderr.
 *
 * The text comes from a file named by path: the module names `/dev/stdin` and
 * writes the text there with `$.process.run`'s `stdin`, so it never becomes an
 * argument (bounded in size, and shown to every user by `ps`). */
async function runSidecarSend(
  positionals: string[],
  opts: Record<string, string | boolean>,
): Promise<never> {
  const usage = "ccmsg sidecar send --sid <sid> --to <address> <file>";
  const to = str(opts, "to");
  const [file, ...extra] = positionals;
  if (to === undefined || file === undefined || extra.length > 0) {
    process.stderr.write(`ccmsg sidecar send: usage: ${usage}\n`);
    process.exit(2);
  }
  const identity = resolveSessionIdentity(opts, "sidecar");
  if (identity === null) refuseWriteWithoutSid("sidecar send");
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (e) {
    process.stderr.write(`ccmsg sidecar send: cannot read ${file}: ${errorText(e)}\n`);
    process.exit(2);
  }
  const result = await sendToAddress(identity, to, text);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

async function sendToAddress(
  identity: Identity,
  to: string,
  text: string,
): Promise<SendMessageResult> {
  let client: Client;
  try {
    client = await ensureDaemon(resolvePaths(), identity);
  } catch (e) {
    return {
      isDelivered: false,
      reason: `ccmsg の daemon に繋がらず、送っていない: ${errorText(e)}。少し置いて一度だけ送り直す`,
    };
  }
  let res: ReplyOf<"address_send">;
  try {
    res = await client.request({ op: "address_send", to, text });
  } catch (e) {
    return {
      isDelivered: false,
      reason: `daemon の返事を受け取れず、届いたか確かめられなかった: ${errorText(e)}。送り直すと二重に届くかもしれないので、まず相手の返事を待つ`,
    };
  } finally {
    client.close();
  }
  if (!res.ok) {
    return { isDelivered: false, reason: `daemon が送信を受け付けなかった: ${res.error.msg}` };
  }
  switch (res.outcome) {
    case "delivered":
      return { isDelivered: true };
    case "unconfirmed":
      return { isDelivered: false, reason: ADDRESS_SEND_UNCONFIRMED };
    case "not_delivered":
      return { isDelivered: false, reason: ADDRESS_NOT_DELIVERED[res.reason](to) };
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

Every argument is forwarded to ${SYSTEM_SAY} verbatim — ccmsg defines no options
of its own here, so \`say\`'s own flags (-v, -r, -o, ...) work unchanged and a
PATH shim can delegate to this command without altering behaviour. The one
exception is a lone --help / -h, which prints this text (${SYSTEM_SAY} has no
--help of its own to shadow).

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
  const proc = Bun.spawn([bin, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}

async function runSubscribe(
  identity: Identity,
  opts: Record<string, string | boolean>,
): Promise<never> {
  // The "subscribing as u1" stderr warning is emitted by main() before this
  // (see warnSubscribingAsUser) so the branch stays out of the hot path once
  // the connection is up. stdout is pure jsonl for the downstream Monitor.
  const paths = resolvePaths();
  const sinceStr = str(opts, "since");
  const sinceRead = sinceStr ? parseWith(SinceSeqTextSchema, sinceStr) : undefined;
  if (sinceRead !== undefined && !sinceRead.ok) {
    process.stderr.write(
      `ccmsg subscribe: --since must be a JSON object of room id to seq (${sinceRead.failure.summary})\n`,
    );
    process.exit(2);
  }
  const initialSince = sinceRead?.value;
  // sinceMap は「stdout に出した event の per-room 最大 seq」(DR-0016 §2.4)。
  // 再接続時に daemon へ since_seq として渡し、backlog を「未受信ぶんだけ」に絞る
  // (BBS delta model, DR-0003 §5)。ユーザ指定の --since を初期値として seed し、
  // 以降は受信した event 毎に更新する。
  const sinceMap: Record<string, number> = { ...initialSince };
  // Claude Code keeps one sessions/<pid>.json registry row for the current
  // conversation and rewrites its sessionId on /clear. Watch that row so this
  // sidecar cannot keep announcing the old sid after its owner moved on. The
  // watcher is conservative: absent/unreadable registry state disables this
  // supervision rather than terminating a potentially valid stream.
  const ownerWatch =
    identity.role === "session"
      ? watchSubscribeOwner(process.env.CLAUDE_CONFIG_DIR, identity.sid)
      : null;
  const OWNER_STALE: unique symbol = Symbol("owner-stale");
  const ownerStale = ownerWatch?.stale.then((): typeof OWNER_STALE => OWNER_STALE);
  const stopForStaleOwner = (): never => {
    ownerWatch?.close();
    process.exit(0);
  };
  const raceOwner = async <T>(operation: Promise<T>): Promise<Awaited<T>> => {
    if (!ownerStale) return await operation;
    const result = await Promise.race([operation, ownerStale]);
    if (result === OWNER_STALE) return stopForStaleOwner();
    return result;
  };
  let client: Client = await ensureDaemon(paths, identity);
  const ack = await client.request({
    op: "subscribe",
    ...(initialSince ? { since_seq: initialSince } : {}),
  });
  if (!ack.ok) process.exit(output(ack));
  // 再接続 backoff: 250ms から指数で上限 5s、無期限リトライ。subscribe は
  // Monitor 相当のセッション寿命プロセスなので、上限に達したら fixed 5s で
  // 回り続ける (docs/issue/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md)。
  const BACKOFFS_MS = [250, 500, 1000, 2000, 4000] as const;
  const MAX_BACKOFF_MS = 5000;
  let attempt = 0;
  outer: for (;;) {
    for (;;) {
      const next = await raceOwner(client.readLine());
      if (next === null) break; // socket closed → 再接続へ
      const { line, frame } = next;
      // 1 行を 1 回 frame のスキーマで読み、2 つの副作用を掛ける:
      //   (a) 接続制御イベント (`restarting` / `room_cursors`) は stdout に流さない。
      //       前者は透過再接続の内部信号、後者は接続ごとの初期 snapshot であり、
      //       Monitor へ通知して AI の応答を発生させる対象ではない。
      //   (b) seq を持つ全 StorageEvent 配信で sinceMap を更新し、再接続
      //       subscribe の since_seq 引数に反映する (DR-0016 §2.4、全 event 型
      //       横断)。`ev:"notify"` 等の ephemeral stream event は seq を持たない
      //       ので自然に対象外。
      // スキーマで読めない行は stdout に流さず、stderr に理由を残して捨てる。
      if (frame.kind === "invalid") {
        process.stderr.write(
          `ccmsg subscribe: dropped a line the daemon wrote outside the wire's schema (${frame.failure.summary})\n`,
        );
        continue;
      }
      if (frame.kind === "event") {
        const ev = frame.event;
        if ("ev" in ev) {
          if (ev.ev === "subscribe_superseded") {
            // 同一セッションに subscribe が 2 本立った状態は異常で、放置すると
            // 同じメッセージが二重に通知される。新しい方 (= 意図した起動) を残す
            // 契約なので、古いこちらは再接続せず正常終了する。
            process.stderr.write(
              "ccmsg subscribe: a newer subscribe started for this session " +
                "(duplicate detected). Exiting this older one so messages are not " +
                "delivered twice; the newer subscribe now receives them.\n",
            );
            ownerWatch?.close();
            process.exit(0);
          }
          if (ev.ev === "restarting" || ev.ev === "room_cursors") continue;
        } else if (ev.seq !== undefined && ev.seq > (sinceMap[ev.r] ?? 0)) {
          sinceMap[ev.r] = ev.seq;
        }
      }
      process.stdout.write(`${line}\n`);
    }
    // 再接続ループ: no-spawn で daemon に接触できるまで backoff。意図的な
    // `ccmsg daemon stop` を subscribe が resurrection しない契約。
    // 打ち切り条件は持たない (DR-0002 §4 設計意図): subscribe は daemon 更新を
    // またいで生き続ける側で、再起動も通知もしない。非互換に見えても subscribe 側で
    // exit / 再起動する方向には倒さない。protocol の互換を切るのは daemon 側の
    // 意図的な判断で、その時はセッションが張り直す (例: DR-0029 追補の request_id
    // 必須化)。
    for (;;) {
      const c = await raceOwner(reconnectSubscribeNoSpawn(paths, identity, sinceMap));
      if (c !== null) {
        client = c;
        attempt = 0;
        continue outer;
      }
      const delay = BACKOFFS_MS[attempt] ?? MAX_BACKOFF_MS;
      attempt++;
      await raceOwner(new Promise<void>((res) => setTimeout(res, delay)));
    }
  }
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
 * entry point, same as `status`/`read`/`rooms`/`peers`). */
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
 * rather than duplicated. Live `subscribe` clients reattach through their own
 * no-spawn reconnect backoff once the replacement is listening; the no-spawn
 * contract only keeps subscribe from resurrecting a daemon nobody replaced, and
 * here the restarting client is the one putting it back.
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
  post <sid> <text>                         セッションへ直送 (宛先の sid は peers で探す)
  reply <mid> --to <sid> <text>             直送への返信 (届いた封筒の返信行どおり)
  reply <rNmN> <msg>                        room への返信用
  post <room> [--to <aN[,aN...]>] <msg>     room への新規メッセージ用
  read <rNmN[,mN...]>                       メッセージ全文取得
  dump <session-id> [--since <ts>]          セッション会話を圧縮 JSONL/text で回収
  peers [cwd(partial)]                      セッション一覧と SendMessage の宛先 (addresses)
  create-room --members <sid[,sid...]> <title>  ルーム作成
  subscribe                                 Monitor常駐用
  notify --self --text <msg>                自セッション通知 (justfile等の組み込み用途)
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
  post <sid> <text>            Send a message straight to one session, no room.
                               <sid> is a session id as "peers" lists it, or
                               ccmsg:<sid>. Prints {"delivered":true,"mid":...};
                               a message that did not arrive exits 1 with why,
                               and is neither kept nor retried; one whose arrival
                               could not be told exits 3 (resending may deliver
                               it twice). The words after <sid> are the text,
                               quoted or not; only an exact --to / --sid /
                               --as-session / --help there is an option, and
                               everything after -- is text
  post <room> <msg>            Post a message to a room (--to to filter delivery)
  reply <mid> --to <sid> <text>
                               Answer a direct message: run the reply line of
                               the envelope it arrived in as it is
  reply <rNmN> <msg>           Reply to a received room message; the daemon
                               builds targets
  create-room [<title>]        Open a room with peers (--members, --msg, --title
                               or positional <title>; --title wins when both given,
                               --exclude-self to keep the caller out of the room,
                               --kind broadcast for a session-broadcast room)
  next-room <room>             Spawn the next thread of a room (--msg, --title)
  subscribe                    Stream live room events (membership, notify, ...)
                               as jsonl to stdout. Room messages are not on this
                               stream; a session receives them directly. Startup
                               and reconnect are silent; the bare default replays
                               no backlog
  read <rNmN[,mN...]>          Fetch messages by compact reference ("r7m10,m11")
  read <room> <mids>           Existing form ("r7" + "10-15,18" or "10,11")
  dump <session-id>            Export session handoff context (todos, agents, rooms) +
                               conversation entries as compact jsonl (default) or readable
                               text (--format text). --since/--until accept a
                               timezone-qualified ISO 8601 timestamp or a transcript
                               record uuid. Agents the dumped range never
                               involves fold to one line each (--agent expands one);
                               --no-thinking / --no-agent trim further. --out writes the
                               jsonl to a file and prints only its path (bare --out
                               auto-names it under <data>/dumps/)
  leave <room>                 Leave a room
  rooms                        List active rooms (id / title / members / last_mid /
                               live_members; archived rooms and rooms whose members
                               are all disconnected are omitted — use --all to include)
  peers [<cwd>]                List connected sessions; positional <cwd> filters
                               by substring match on each session's cwd. Each
                               lists in "addresses" what to write as SendMessage's
                               to, from any config dir: ccmsg:<sid>; one
                               ccmsg:<sid>.<pid> per process when the session runs
                               in several; ccmsg:path:<cwd>, every other session
                               working there
  notify                       Signal a session's subscribe stream (--self / --sid, --text)
  say [args...]                Speak via /usr/bin/say, first telling the daemon
                               which session spoke so the webui can show it in
                               that session's timeline. Every argument is
                               forwarded verbatim (say's own -v/-r/-o keep
                               working); speech still happens when there is no
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
                               Live "subscribe" clients reattach on their own

Command Options:
  --to <ids>                   post <room>: deliver only to these agent member id(s) +
                               sender, comma-separated (e.g. a2,a3); User delivery stays
                               implicit. reply <mid>: the session the answer goes to
  --members <sids>             create-room: participant sids, comma-separated
                               (do NOT pass 'u1' — the User admin is always implicit)
  --exclude-self               create-room: don't auto-add the caller session as a
                               member (observer/setup use case; default is include)
  --kind <kind>                create-room: 'normal' (default) or 'broadcast'
                               (broadcast: auto-populated session room, --members ignored)
  --msg <text>                 create-room / next-room: initial message
  --title <text>               create-room / next-room: room title
  --all                        rooms: include archived and all-disconnected rooms
                               (default: only rooms with a connected member)
  --since <value>              subscribe: per-room last-seen seq JSON, e.g. '{"r7":7}';
                               dump: inclusive lower bound — an ISO 8601 timestamp with
                               timezone, or a transcript record uuid. A uuid cuts at that
                               record itself, so records sharing its timestamp are not
                               dragged in (the webui shows each record's uuid)
  --until <timestamp|uuid>     dump: inclusive upper bound, same two forms as --since
  --format <format>            dump: 'jsonl' (default) or 'text'
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
  Write ops (post, reply, create-room, next-room, leave, notify) require a session
  identity (CCMSG_SID / CLAUDE_CODE_SESSION_ID / --as-session). Without one the
  CLI exits with a non-zero status rather than posting as the User (u1). The
  User admin identity is issued by the webui backend only; the CLI cannot act
  as u1 for write ops. subscribe still runs without a sid (with a stderr
  warning), giving kawaz a plain-terminal observation path until the webui.
  A 1on1 room is read-only: post, reply and next-room into it are refused;
  use a normal room instead.
  No command sends to the person: their input reaches a session from the
  webui, and a session tells them something with PushNotification.
  A session sends to another with SendMessage, an address from peers as its
  to; the ccmsg hooks module delivers it, across config dirs. The answer goes
  to the from the message arrived with.

Environment Variables:
  CCMSG_STATE_DIR              Override runtime dir (sock/lock/pid/log)
  CCMSG_CONFIG_DIR             Override config dir (config.ts, config.js, or
                               config.json, allowed-origins.json)
  CCMSG_DATA_DIR               Override data dir (rooms/<id>.jsonl, dumps/*.jsonl)
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
                               sent in hello (set by the SessionStart hook,
                               DR-0009); adopted only if the daemon accepts it
  CCMSG_REPO_ROOT              Absolute path of this repo's workspace/worktree
                               container, sent in hello (set by the SessionStart
                               hook, DR-0008 addendum); adopted only if the
                               daemon accepts it (widens fs_list/fs_read to
                               sibling workspaces instead of just cwd)
  CCMSG_SAY_BIN                say: speech binary to exec instead of /usr/bin/say
                               (test hook — exercise the path without audio)
  CCMSG_DEDUP_WINDOW_MS        create-room dedup window (daemon side, default 60000)
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
  const parsed = parseArgs(argv);
  const { positionals, opts } =
    (parsed.positionals[0] === "post" || parsed.positionals[0] === "reply") &&
    parsed.commandAt !== undefined
      ? parseSendArgs(argv, parsed.commandAt)
      : parsed;
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

  const sessionIdentity = resolveSessionIdentity(opts, cmd);
  // Write ops refuse to run without a sid — silently degrading to u1 was the
  // masquerade bug (docs/issue/2026-07-12-prevent-u1-masquerade-on-missing-sid.md).
  if (sessionIdentity === null && WRITE_OPS.has(cmd)) refuseWriteWithoutSid(cmd);
  // Observe ops fall back to user role. hello is required by the daemon for
  // subscribe/notify anyway (IDENTITY_OPS in server.ts); read/rooms/peers/status
  // don't need identity but hello with role=user is harmless and uniform.
  const identity: Identity = sessionIdentity ?? { role: "user" };

  switch (cmd) {
    case "post": {
      const usage = "ccmsg post <sid> <text>  |  ccmsg post <room> <msg> [--to <ids>]";
      const target = requireArg(args[0], "sid|room", usage);
      // The body: every word after the target, joined by one space
      // (parseSendArgs), as the timeline shows it.
      const body = args[1];
      if (!ROOM_ID_RE.test(target)) {
        const to = directRecipient(target);
        const text = requireArg(body, "text", usage);
        if (opts.to !== undefined) {
          throw new Error(
            "--to は room への post の配信先の指定で、セッションへの直送では使わない",
          );
        }
        await runDirectSend(identity, { to, text });
      }
      const room = target;
      const msg = requireArg(body, "msg", usage);
      const to = parseIdList(str(opts, "to"));
      await runOnce(identity, { op: "post", room, msg, ...(to ? { to } : {}) });
      return;
    }
    case "reply": {
      // DR-0017 §2.1: 返信先 msg (rNmN) を指すだけで、宛先 (to) は daemon が
      // 元 msg から構成する — 受信 event の reply_via が指す target を渡す。
      const usage =
        "ccmsg reply <mid> --to <sid> <text>  |  ccmsg reply <rNmN> <msg>   (e.g. ccmsg reply r17m16 'answer')";
      const ref = requireArg(args[0], "mid", usage);
      const msg = requireArg(args[1], "msg", usage);
      if (isDirectMid(ref)) {
        const address = str(opts, "to");
        if (address === undefined) {
          throw new Error(
            "reply <mid> には --to <送り主の sid> が要る (届いた封筒の返信行をそのまま実行する)。人へは返信しない: 人に知らせるには PushNotification を使う",
          );
        }
        await runDirectSend(identity, { to: directRecipient(address), text: msg, reply_to: ref });
      }
      const [, room, mid] = ref.match(/^(r\d+)m(\d+)$/) ?? [];
      if (room === undefined || mid === undefined) {
        process.stderr.write(
          `invalid reply target "${ref}" — expected <instance id>/<n> (a direct message, with --to) or r<N>m<M> (a room message, e.g. r17m16)\nusage: ${usage}\n`,
        );
        process.exit(1);
      }
      await runOnce(identity, { op: "reply", room, mid: Number(mid), msg });
      return;
    }
    case "create-room": {
      const membersStr = str(opts, "members");
      const members = membersStr
        ? membersStr
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "")
        : [];
      // u1 is the reserved User admin id, implicitly a member of every room
      // (DR-0006 §2) — passing it via --members would try to register u1 as a
      // regular sid entry, both nonsensical and error-prone. Reject up front
      // so the caller notices, rather than silently letting the daemon create
      // a room with a bogus "u1" member row.
      if (members.includes("u1")) {
        process.stderr.write(
          "ccmsg create-room: u1 is always implicitly a member of every room; " +
            "do not pass it via --members.\n",
        );
        process.exit(1);
      }
      // --exclude-self opt-out: default is include (session caller is added to
      // the room they create). The rare observe-without-join case (session
      // watching a room they set up between other peers) uses --exclude-self.
      const excludeSelf = opts["exclude-self"] === true;
      // DR-0013 broadcast: --kind で room の性格を切替える。指定なしは "normal"。
      // 値検証は CLI 側で先に (typo で silently normal room が立つのは意図と
      // 乖離するので早めに落とす)。
      const kindRaw = str(opts, "kind");
      if (kindRaw !== undefined && kindRaw !== "normal" && kindRaw !== "broadcast") {
        process.stderr.write(
          `ccmsg create-room: --kind must be 'normal' or 'broadcast' (got '${kindRaw}')\n`,
        );
        process.exit(1);
      }
      const kindPayload = kindRaw === "broadcast" ? { kind: "broadcast" as const } : {};
      // RL-Q2 (kawaz r26 mid=104、裁定=a): 最小 help の
      //   `create-room --members <sid[,sid...]> <title>`
      // に合わせ、positional <title> を受理する。--title 併用時は明示 flag が
      // 勝つ (positional は help 由来の shorthand 扱い、明示指定を優先)。
      // 現状 args[0] は silent drop されていたが、それを合法化する変更。
      const explicitTitle = str(opts, "title");
      const positionalTitle = args[0];
      const finalTitle =
        explicitTitle !== undefined
          ? explicitTitle
          : typeof positionalTitle === "string" && positionalTitle !== ""
            ? positionalTitle
            : undefined;
      await runOnce(identity, {
        op: "create_room",
        members,
        ...(excludeSelf ? { include_self: false } : {}),
        ...(str(opts, "msg") ? { msg: str(opts, "msg") } : {}),
        ...(finalTitle !== undefined ? { title: finalTitle } : {}),
        ...kindPayload,
      });
      return;
    }
    case "next-room": {
      const usage = "ccmsg next-room <room> [--msg <text>] [--title <text>]";
      const room = requireArg(args[0], "room", usage);
      await runOnce(identity, {
        op: "next_room",
        room,
        ...(str(opts, "msg") ? { msg: str(opts, "msg") } : {}),
        ...(str(opts, "title") ? { title: str(opts, "title") } : {}),
      });
      return;
    }
    case "read": {
      const usage =
        "ccmsg read <rNmN[,mN...]> | ccmsg read <room> <mids>   (e.g. ccmsg read r7m10,m11)";
      const { room, mids } = parseReadArgs(args, usage);
      await runOnce(identity, { op: "read", room, mids });
      return;
    }
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
    case "leave": {
      const usage = "ccmsg leave <room>";
      const room = requireArg(args[0], "room", usage);
      await runOnce(identity, { op: "leave", room });
      return;
    }
    case "rooms": {
      // デフォルトは「今この場で話せる room」だけ (kawaz r17 mid=23、
      // 2026-07-15 に archive 除外、r?? で無人 room 除外を追加):
      // AI セッションが rooms を叩くたびに、archive 済み room と、誰も
      // 接続していない古い room (誰も archive しないまま溜まる 1on1 が
      // 主) が全件 context に乗るのは無駄で、探す効率も落ちる。全件は
      // --all でオプトイン。絞りは CLI 側で行う — webui の op:"rooms"
      // (全件 + 表示側で折り畳み) に影響させないため。
      if (opts.all) {
        await runOnce(identity, { op: "rooms" });
        return;
      }
      const paths = resolvePaths();
      const client = await ensureDaemon(paths, identity);
      const res = await client.request({ op: "rooms" });
      client.close();
      if (res.ok) {
        const live = res.rooms.filter((r) => !r.archived);
        const archivedOmitted = res.rooms.length - live.length;
        // live_members === 0 = present member の誰一人 session を繋いでいない
        // room。post しても読む相手が居ないので既定では隠す。`undefined` は
        // フィールドを持たない古い daemon なので「不明」= 絞らない側に倒す
        // (0 と同一視すると全 room が消える)。
        const rooms = live.filter((r) => r.live_members === undefined || r.live_members > 0);
        const inactiveOmitted = live.length - rooms.length;
        // *_omitted で「絞られている」ことを機械可読に示す (0 件なら省略)。
        // 「見えない = 存在しない」と誤認して create-room で重複を作る事故を
        // 防ぐ ([[interface-wording]] の空状態原則)。
        process.exit(
          output({
            ...res,
            rooms,
            ...(archivedOmitted > 0 ? { archived_omitted: archivedOmitted } : {}),
            // inactive = 接続中メンバー 0 (room 自体は生きている、archive
            // でもない)。話しかけたい相手が居るなら --all で拾って post
            // できる。
            ...(inactiveOmitted > 0 ? { inactive_omitted: inactiveOmitted } : {}),
            ...(archivedOmitted > 0 || inactiveOmitted > 0 ? { hint: "--all で全件表示" } : {}),
          }),
        );
      }
      process.exit(output(res));
      return;
    }
    case "peers": {
      // RL-Q2 (kawaz r26 mid=104、裁定=a): help `peers [cwd(partial)]` に合わせ
      // positional 引数を cwd 部分一致 filter として実装する。現状 args[0] は
      // silent drop されていたのを合法化。絞りは CLI 側で行う (rooms と同じく
      // webui の op:"peers" を汚さない方針、interface-wording rule 準拠)。
      const cwdFilter = args[0];
      if (typeof cwdFilter !== "string" || cwdFilter === "") {
        await runOnce(identity, { op: "peers" });
        return;
      }
      const paths = resolvePaths();
      const client = await ensureDaemon(paths, identity);
      const res = await client.request({ op: "peers" });
      client.close();
      if (res.ok) {
        const peers = res.peers.filter((p) => p.cwd.includes(cwdFilter));
        process.exit(output({ ...res, peers }));
      }
      process.exit(output(res));
      return;
    }
    case "notify": {
      const text = requireArg(
        str(opts, "text"),
        "text",
        "ccmsg notify [--self | --sid <sid>] --text <text>",
      );
      const sid = str(opts, "sid");
      await runOnce(identity, { op: "notify", ...(sid ? { sid } : {}), text });
      return;
    }
    case "subscribe": {
      if (sessionIdentity === null) warnSubscribingAsUser();
      await runSubscribe(identity, opts);
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
