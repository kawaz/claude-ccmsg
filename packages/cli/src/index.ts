#!/usr/bin/env bun
// ccmsg CLI. Subcommand style, long options, no-args prints help (per kawaz CLI
// conventions). Every command except `daemon run` goes through ensure-daemon.
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION, resolvePaths, type Identity } from "@ccmsg/protocol";
import { runDaemon } from "@ccmsg/daemon/run";
import { dumpSession, type SessionDump, type SessionDumpEntry } from "@ccmsg/daemon/session-dump";
import {
  Client,
  connectIfRunning,
  ensureDaemon,
  reconnectSubscribeNoSpawn,
  waitDaemonGone,
} from "./client.ts";

// --- arg parsing -----------------------------------------------------------

const BOOL_FLAGS = new Set([
  "all",
  "exclude-self",
  "self",
  "foreground",
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
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
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
  const compact = args[0]?.match(/^(r\d+)m(\d+(?:,m\d+)*)$/);
  if (compact) {
    if (args[1] !== undefined)
      throw new Error(`unexpected argument "${args[1]}"\n  usage: ${usage}`);
    return { room: compact[1]!, mids: compact[2]!.replaceAll(",m", ",") };
  }
  return {
    room: requireArg(args[0], "room", usage),
    mids: requireArg(args[1], "mids", usage),
  };
}

// --- identity --------------------------------------------------------------

/** Shape the SessionStart/UserPromptSubmit hooks write to
 *  `<stateDir>/sessions/<sid>.json` (see hooks/session-start.ts's
 *  SessionFileData). Kept as a separate, loosely-typed mirror here rather than
 *  importing that type: hooks/ isn't a workspace package the CLI can depend on
 *  (only packages/* are), and this file only ever reads string fields off of
 *  it — a shared protocol-level type was considered but deferred to keep this
 *  change's footprint small (see the delegation report). */
interface StoredSessionFile {
  transcript_path?: unknown;
  repo?: unknown;
  ws?: unknown;
  repo_root?: unknown;
  branch?: unknown;
}

/** Mirrors hooks/session-start.ts's sessionFilePath — same reasoning as
 *  StoredSessionFile above for why this isn't a shared import. */
function sessionFilePath(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.json`);
}

/** Best-effort read of the hook-written session state file. Missing file,
 *  unreadable, or malformed/non-object JSON all resolve to undefined — this is
 *  an optional enrichment (repo/ws/transcript_path for a richer hello), never a
 *  hard requirement for `hello` to succeed (mirrors the pre-existing "session
 *  file didn't exist" degrade path this replaces). */
function readSessionFile(stateDir: string, sid: string): StoredSessionFile | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sessionFilePath(stateDir, sid), "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as StoredSessionFile;
  } catch {
    return undefined;
  }
}

/** Non-empty-string coercion: `undefined`, non-string, and `""` all collapse to
 *  `undefined` — an env var present-but-blank (a CI/shell environment accident)
 *  must not shadow a real value from the session file, and a session file field
 *  of the wrong JSON type must not be trusted. */
function strField(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
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
  // Env auto-detect: CCMSG_SID first (kawaz's explicit hook prefix, session-
  // start.ts / user-prompt-submit.ts), then CLAUDE_CODE_SESSION_ID (Claude
  // Code's own env, present in the parent process but NOT reliably exported
  // into Monitor/Bash subprocesses — that's the very gap the hook's CCMSG_SID
  // prefix exists to close). The old CLAUDE_SESSION_ID (never actually set by
  // Claude Code — inherited from the pre-hook design) is removed to shrink the
  // "which env do I set?" surface area. `strField` collapses empty strings to
  // undefined so `CCMSG_SID=""` (a shell/CI env accident) doesn't shadow a
  // real CLAUDE_CODE_SESSION_ID; same pattern used elsewhere in this function
  // for CCMSG_TRANSCRIPT_PATH and friends.
  const sid =
    sidOverride ?? strField(process.env.CCMSG_SID) ?? strField(process.env.CLAUDE_CODE_SESSION_ID);
  if (sid) {
    // CCMSG_TRANSCRIPT_PATH/CCMSG_REPO/CCMSG_WS env vars are an override knob
    // (manual invocation, tests) — when present they win over whatever the
    // SessionStart/UserPromptSubmit hooks wrote to the session file. Absent,
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
    return {
      role: "session",
      sid,
      repo: strField(process.env.CCMSG_REPO) ?? strField(stored?.repo) ?? "",
      ws: strField(process.env.CCMSG_WS) ?? strField(stored?.ws) ?? "",
      cwd: process.cwd(),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      ...(branch ? { branch } : {}),
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
      "    CCMSG_SID=<sid>            (the SessionStart / UserPromptSubmit hook prefix)\n" +
      "    CLAUDE_CODE_SESSION_ID=<sid>  (Claude Code's own env; auto-detected when exported)\n" +
      "    --as-session <sid>         (explicit override on the command line)\n" +
      "  From a Claude Code session, prefer the exact command the hook suggested\n" +
      "  (it already carries CCMSG_SID=).\n",
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
    "ccmsg subscribe: no session id (CCMSG_SID / CLAUDE_CODE_SESSION_ID unset) — " +
      "subscribing as the User (u1). No peers entry, no echo suppression. " +
      "For a session sidecar, run: CCMSG_SID=<session_id> ccmsg subscribe\n",
  );
}

// --- output ----------------------------------------------------------------

function dumpEndpoint(value: SessionDumpEntry["to"] | SessionDumpEntry["from"]): string {
  if (value === null) return "-";
  return Array.isArray(value) ? value.join(",") : value;
}

function formatTextDump(dump: SessionDump): string {
  const { header, entries } = dump;
  const lines = [
    `Session: ${header.session}`,
    `Since: ${header.since}`,
    `Until: ${header.until ?? "(end)"}`,
    `Generated: ${header.generated}`,
    `Format: ${header.format} text`,
    "",
  ];
  for (const entry of entries) {
    lines.push(
      `[+${entry.t}ms ${entry.kind} ${dumpEndpoint(entry.from)}→${dumpEndpoint(entry.to)}]`,
      entry.text,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function output(res: { ok?: boolean } & Record<string, unknown>): number {
  const line = `${JSON.stringify(res)}\n`;
  if (res && res.ok === false) {
    process.stderr.write(line);
    return 1;
  }
  // DR-0013 §2.9: daemon が付けた non-fatal warning (現状は broadcast の
  // --members 無視) は stderr に別行で流す。stdout の JSON にも `warning` は
  // 残しているので、pipeline consumer は JSON 側だけを見ていれば従来通り動く
  // — stderr 側は kawaz や AI が対話中に「その --members は意味がなかった」と
  // 気付くための誘導。
  if (res && typeof res.warning === "string" && res.warning !== "") {
    process.stderr.write(`ccmsg: ${res.warning}\n`);
  }
  process.stdout.write(line);
  return 0;
}

// --- commands --------------------------------------------------------------

async function runOnce(identity: Identity, req: Record<string, unknown>): Promise<never> {
  const paths = resolvePaths();
  const client = await ensureDaemon(paths, identity);
  const res = await client.request<{ ok?: boolean } & Record<string, unknown>>(req);
  client.close();
  process.exit(output(res));
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
  const initialSince = sinceStr ? (JSON.parse(sinceStr) as Record<string, number>) : undefined;
  // sinceMap は「stdout に出した event の per-room 最大 seq」(DR-0016 §2.4)。
  // 再接続時に daemon へ since_seq として渡し、backlog を「未受信ぶんだけ」に絞る
  // (BBS delta model, DR-0003 §5)。ユーザ指定の --since を初期値として seed し、
  // 以降は受信した event 毎に更新する。
  const sinceMap: Record<string, number> = { ...initialSince };
  let client: Client = await ensureDaemon(paths, identity);
  const ack = await client.request<{ ok?: boolean }>({
    op: "subscribe",
    ...(initialSince ? { since_seq: initialSince } : {}),
  });
  if (ack.ok === false) process.exit(output(ack as Record<string, unknown>));
  // 再接続 backoff: 250ms から指数で上限 5s、無期限リトライ。subscribe は
  // Monitor 相当のセッション寿命プロセスなので、上限に達したら fixed 5s で
  // 回り続ける (docs/issue/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md)。
  const BACKOFFS_MS = [250, 500, 1000, 2000, 4000, 5000] as const;
  let attempt = 0;
  outer: for (;;) {
    for (;;) {
      const line = await client.readLine();
      if (line === null) break; // socket closed → 再接続へ
      // 1 行 parse して 2 つの副作用を掛ける:
      //   (a) `ev:"restarting"` は stdout に流さない (透過再接続が目的で、上流の
      //       Monitor へノイズ行を送らない)。この行の直後に daemon が socket を閉じる
      //       ので、次ループで readLine() が null を返し再接続経路に入る。
      //   (b) r + seq を持つ全 StorageEvent 配信で sinceMap を更新し、再接続
      //       subscribe の since_seq 引数に反映する (DR-0016 §2.4、全 event 型
      //       横断)。`ev:"notify"` 等の ephemeral stream event は seq を持たない
      //       ので自然に対象外。
      let filtered = false;
      try {
        const ev = JSON.parse(line) as {
          ev?: string;
          r?: string;
          seq?: number;
        };
        if (ev.ev === "restarting") {
          filtered = true;
        } else if (typeof ev.r === "string" && typeof ev.seq === "number") {
          const prev = sinceMap[ev.r] ?? 0;
          if (ev.seq > prev) sinceMap[ev.r] = ev.seq;
        }
      } catch {
        // 非 JSON 行 (現契約では発生しないが、防御的に素通し)
      }
      if (!filtered) process.stdout.write(`${line}\n`);
    }
    // 再接続ループ: no-spawn で daemon に接触できるまで backoff。意図的な
    // `ccmsg daemon stop` を subscribe が resurrection しない契約。
    for (;;) {
      const c = await reconnectSubscribeNoSpawn(paths, identity, sinceMap);
      if (c !== null) {
        client = c;
        attempt = 0;
        continue outer;
      }
      const delay = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)]!;
      attempt++;
      await new Promise<void>((res) => setTimeout(res, delay));
    }
  }
}

async function runStatus(): Promise<never> {
  const paths = resolvePaths();
  const client = await connectIfRunning(paths);
  if (!client) {
    output({ ok: true, running: false, stateDir: paths.stateDir, dataDir: paths.dataDir });
    process.exit(0);
  }
  const pong = await client.request<Record<string, unknown>>({ op: "ping" });
  client.close();
  output({ ok: true, running: true, ...pong, stateDir: paths.stateDir, dataDir: paths.dataDir });
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

function handleDaemon(positionals: string[], opts: Record<string, string | boolean>): void {
  const sub = positionals[0];
  if (sub === "run") {
    // blocks: the listen socket keeps the event loop alive
    runDaemon({ foreground: opts.foreground === true });
    return;
  }
  if (sub === "stop") {
    void runDaemonStop();
    return;
  }
  process.stderr.write("ccmsg: usage: ccmsg daemon <run|stop>\n");
  process.exitCode = 1;
}

// --- help ------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`Commands:
  reply <rNmN> <msg>                        返信用
  post <room> [--to <aN[,aN...]>] <msg>     新規メッセージ用
  read <rNmN[,mN...]>                       メッセージ全文取得 (msg_via 指示時など)
  dump <session-id> [--since <ts>]          セッション会話を圧縮 JSONL/text で回収
  peers [cwd(partial)]                      セッション一覧取得
  create-room --members <sid[,sid...]> <title>  ルーム作成
  subscribe                                 Monitor常駐用
  notify --self --text <msg>                自セッション通知 (justfile等の組み込み用途)

Options:
  --help-full
`);
}

function printFullHelp(): void {
  process.stdout.write(`ccmsg v${VERSION} — central-daemon messenger for Claude Code sessions

Usage:
  ccmsg <command> [args] [options]

Commands:
  post <room> <msg>            Post a message to a room (--to to filter delivery)
  reply <rNmN> <msg>           Reply using the target named by the received
                               reply_via instruction; the daemon builds targets
  create-room [<title>]        Open a room with peers (--members, --msg, --title
                               or positional <title>; --title wins when both given,
                               --exclude-self to keep the caller out of the room,
                               --kind broadcast for a session-broadcast room,
                               --kind 1on1 --members <sid> for a webui 1on1 priv room)
  next-room <room>             Spawn the next thread of a room (--msg, --title)
  subscribe                    Stream room events as jsonl to stdout. Bare default:
                               no backlog, just a room_cursors summary
                               ({room, last_mid} per visible room) — read to
                               catch up rooms you're behind on. --since replays
                               history for the rooms it names; each msg carries
                               its reply_via instruction
  read <rNmN[,mN...]>          Fetch messages by compact reference ("r7m10,m11")
  read <room> <mids>           Existing form ("r7" + "10-15,18" or "10,11")
  dump <session-id>            Export conversation entries as compact jsonl (default)
                               or readable text (--format text). --since/--until
                               accept timezone-qualified ISO 8601
  leave <room>                 Leave a room
  rooms                        List active rooms (id / title / members / last_mid;
                               archived rooms are omitted — use --all to include)
  peers [<cwd>]                List connected sessions; positional <cwd> filters
                               by substring match on each session's cwd
  notify                       Signal a session's subscribe stream (--self / --sid, --text)
  status                       Show daemon liveness / version / uptime / pid
  origins [list]               List persisted extra allowed Origins (webui reverse proxy)
  origins add <origin>         Allow an Origin (e.g. "https://ccmsg.example.com"), effective immediately
  origins remove <origin>      Remove a persisted Origin
  version                      Print the ccmsg version and exit
  daemon run [--foreground]    Run the daemon in this process
  daemon stop                  Gracefully stop the running daemon

Command Options:
  --to <ids>                   post: deliver only to these agent member id(s) + sender,
                               comma-separated (e.g. a2,a3); User delivery stays implicit
  --members <sids>             create-room: participant sids, comma-separated
                               (do NOT pass 'u1' — the User admin is always implicit)
  --exclude-self               create-room: don't auto-add the caller session as a
                               member (observer/setup use case; default is include)
  --kind <kind>                create-room: 'normal' (default), 'broadcast', or '1on1'
                               (broadcast: auto-populated session room, --members ignored;
                               1on1: User + one session, --members must be a single sid)
  --msg <text>                 create-room / next-room: initial message
  --title <text>               create-room / next-room: room title
  --all                        rooms: include archived rooms (default: active only)
  --since <value>              subscribe: per-room last-seen seq JSON, e.g. '{"r7":7}';
                               dump: inclusive ISO 8601 lower bound with timezone
  --until <timestamp>          dump: inclusive ISO 8601 upper bound with timezone
  --format <format>            dump: 'jsonl' (default) or 'text'
  --self                       notify: target own session (default when no --sid)
  --sid <sid>                  notify: target session id
  --text <text>                notify: notification text
  --foreground                 daemon run: also log to stderr

Global Options:
  --sid <sid>                  Act as this session id (for 'notify', --sid is the
                               target instead; use --as-session to set identity there)
  --as-session <sid>           Act as this session id (works for every command)
  -h, --help                   Show the minimal command rail
  --help-full                  Show this complete reference
  --version                    Print the ccmsg version and exit

Notes:
  Write ops (post, create-room, next-room, leave, notify) require a session
  identity (CCMSG_SID / CLAUDE_CODE_SESSION_ID / --as-session). Without one the
  CLI exits with a non-zero status rather than posting as the User (u1). The
  User admin identity is issued by the webui backend only; the CLI cannot act
  as u1 for write ops. subscribe still runs without a sid (with a stderr
  warning), giving kawaz a plain-terminal observation path until the webui.

Environment Variables:
  CCMSG_STATE_DIR              Override runtime dir (sock/lock/pid/log)
  CCMSG_DATA_DIR               Override data dir (rooms/<id>.jsonl)
  CCMSG_SID / CLAUDE_CODE_SESSION_ID  Session id for identity auto-detection
                               (CCMSG_SID wins; both are ignored for --as-session)
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
  if (opts.help === true || positionals.length === 0) {
    printHelp();
    return;
  }
  const cmd = positionals[0]!;
  const args = positionals.slice(1);

  if (cmd === "daemon") {
    handleDaemon(args, opts);
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
      const usage = "ccmsg post <room> <msg> [--to <ids>]";
      const room = requireArg(args[0], "room", usage);
      const msg = requireArg(args[1], "msg", usage);
      const to = parseIdList(str(opts, "to"));
      await runOnce(identity, { op: "post", room, msg, ...(to ? { to } : {}) });
      return;
    }
    case "reply": {
      // DR-0017 §2.1: 返信先 msg (rNmN) を指すだけで、宛先 (to) は daemon が
      // 元 msg から構成する — 受信 event の reply_via が指す target を渡す。
      const usage = "ccmsg reply <rNmN> <msg>   (e.g. ccmsg reply r17m16 'answer')";
      const ref = requireArg(args[0], "rNmN", usage);
      const msg = requireArg(args[1], "msg", usage);
      const m = ref.match(/^(r\d+)m(\d+)$/);
      if (!m) {
        process.stderr.write(
          `invalid reply target "${ref}" — expected r<N>m<M> (e.g. r17m16)\nusage: ${usage}\n`,
        );
        process.exit(1);
      }
      await runOnce(identity, { op: "reply", room: m[1]!, mid: Number(m[2]), msg });
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
      // DR-0013 broadcast / DR-0014 1on1: --kind で room の性格を切替える。
      // 指定なしは "normal"。値検証は CLI 側で先に (typo で silently normal room
      // が立つのは意図と乖離するので早めに落とす)。1on1 の member 個数チェックは
      // daemon 側の one_on_one_requires_single_member に任せる (CLI で二重に持つと
      // ドリフトするため)。
      const kindRaw = str(opts, "kind");
      if (
        kindRaw !== undefined &&
        kindRaw !== "normal" &&
        kindRaw !== "broadcast" &&
        kindRaw !== "1on1"
      ) {
        process.stderr.write(
          `ccmsg create-room: --kind must be 'normal', 'broadcast', or '1on1' (got '${kindRaw}')\n`,
        );
        process.exit(1);
      }
      const kindPayload =
        kindRaw === "broadcast"
          ? { kind: "broadcast" as const }
          : kindRaw === "1on1"
            ? { kind: "1on1" as const }
            : {};
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
        "ccmsg dump <session-id> [--since <timestamp>] [--until <timestamp>] [--format <jsonl|text>]";
      const sid = requireArg(args[0], "session-id", usage);
      if (args[1] !== undefined)
        throw new Error(`unexpected argument "${args[1]}"\n  usage: ${usage}`);
      const format = str(opts, "format") ?? "jsonl";
      if (format !== "jsonl" && format !== "text") {
        throw new Error(`--format must be 'jsonl' or 'text' (got '${format}')\n  usage: ${usage}`);
      }
      const dump = dumpSession(sid, {
        dataDir: resolvePaths().dataDir,
        ...(str(opts, "since") ? { since: str(opts, "since") } : {}),
        ...(str(opts, "until") ? { until: str(opts, "until") } : {}),
      });
      if (format === "text") {
        process.stdout.write(formatTextDump(dump));
      } else {
        process.stdout.write(`${JSON.stringify(dump.header)}\n`);
        for (const entry of dump.entries) process.stdout.write(`${JSON.stringify(entry)}\n`);
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
      // デフォルトは active (非 archive) のみ (kawaz r17 mid=23、2026-07-15):
      // AI セッションが rooms を叩くたびに archive 済み room 全件 (運用が
      // 進むほど増える) が context に乗るのは無駄で、探す効率も落ちる。
      // 全件は --all でオプトイン。絞りは CLI 側で行う — webui の op:"rooms"
      // (全件 + 表示側で折り畳み) に影響させないため。
      if (opts.all) {
        await runOnce(identity, { op: "rooms" });
        return;
      }
      const paths = resolvePaths();
      const client = await ensureDaemon(paths, identity);
      const res = await client.request<
        { ok?: boolean; rooms?: Array<{ archived?: boolean }> } & Record<string, unknown>
      >({ op: "rooms" });
      client.close();
      if (res.ok && Array.isArray(res.rooms)) {
        const total = res.rooms.length;
        const rooms = res.rooms.filter((r) => !r.archived);
        // archived_omitted で「絞られている」ことを機械可読に示す (0 件なら
        // 省略)。「見えない = 存在しない」と誤認して create-room で重複を
        // 作る事故を防ぐ ([[interface-wording]] の空状態原則)。
        const omitted = total - rooms.length;
        process.exit(
          output({
            ...res,
            rooms,
            ...(omitted > 0 ? { archived_omitted: omitted, hint: "--all で全件表示" } : {}),
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
      const res = await client.request<
        { ok?: boolean; peers?: Array<{ cwd?: string }> } & Record<string, unknown>
      >({ op: "peers" });
      client.close();
      if (res.ok && Array.isArray(res.peers)) {
        const peers = res.peers.filter(
          (p) => typeof p.cwd === "string" && p.cwd.includes(cwdFilter),
        );
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
 * allowed Origins file (<dataDir>/allowed-origins.json) that the daemon's
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
  const file = paths.allowedOrigins;
  const load = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  const save = (origins: string[]): void => {
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
      const origins = load();
      const already = origins.includes(origin);
      if (!already) {
        origins.push(origin);
        save(origins);
      }
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
