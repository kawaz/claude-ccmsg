#!/usr/bin/env bun
// ccmsg CLI. Subcommand style, long options, no-args prints help (per kawaz CLI
// conventions). Every command except `daemon run` goes through ensure-daemon.
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION, resolvePaths, type Identity } from "@ccmsg/protocol";
import { runDaemon } from "@ccmsg/daemon/run";
import {
  Client,
  connectIfRunning,
  ensureDaemon,
  reconnectSubscribeNoSpawn,
  waitDaemonGone,
} from "./client.ts";

// --- arg parsing -----------------------------------------------------------

const BOOL_FLAGS = new Set(["as-user", "self", "foreground", "help", "version"]);

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

function resolveIdentity(opts: Record<string, string | boolean>, cmd: string): Identity {
  if (opts["as-user"] === true) return { role: "user" };
  // `notify` uses --sid for its target, so it must not double as an identity override
  // there; --as-session still works everywhere.
  const sidOverride =
    cmd === "notify" ? str(opts, "as-session") : (str(opts, "sid") ?? str(opts, "as-session"));
  const sid = sidOverride ?? process.env.CCMSG_SID ?? process.env.CLAUDE_SESSION_ID;
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
  return { role: "user" };
}

// --- output ----------------------------------------------------------------

function output(res: { ok?: boolean } & Record<string, unknown>): number {
  const line = `${JSON.stringify(res)}\n`;
  if (res && res.ok === false) {
    process.stderr.write(line);
    return 1;
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
  // A session sidecar that lost its sid (CCMSG_SID / CLAUDE_SESSION_ID unset in
  // the Monitor subprocess env) silently degrades to a User subscribe: no peers
  // entry, no echo suppression. Surface that on stderr (stdout stays pure jsonl);
  // an intentional User subscribe states it with --as-user and is not warned.
  if (identity.role === "user" && opts["as-user"] !== true) {
    process.stderr.write(
      "ccmsg subscribe: no session id (CCMSG_SID / CLAUDE_SESSION_ID unset) — subscribing as the User (u1). For a session sidecar, run: CCMSG_SID=<session_id> ccmsg subscribe\n",
    );
  }
  const paths = resolvePaths();
  const sinceStr = str(opts, "since");
  const initialSince = sinceStr ? (JSON.parse(sinceStr) as Record<string, number>) : undefined;
  // sinceMap は「これまで stdout に出したことがある msg の per-room 最大 mid」。
  // 再接続時に daemon へ渡し、backlog を「未受信ぶんだけ」に絞る (BBS delta model,
  // DR-0003 §5)。ユーザ指定の --since を初期値として seed し、以降は受信した msg
  // 毎に更新する。
  const sinceMap: Record<string, number> = { ...initialSince };
  let client: Client = await ensureDaemon(paths, identity);
  const ack = await client.request<{ ok?: boolean }>({
    op: "subscribe",
    ...(initialSince ? { since: initialSince } : {}),
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
      //   (b) `type:"msg"` の r/mid で sinceMap を更新し、再接続 subscribe の
      //       since 引数に反映する。他の event (member/leave/next/prev/title/notify)
      //       は mid を持たないので sinceMap を触らない。
      let filtered = false;
      try {
        const ev = JSON.parse(line) as {
          ev?: string;
          type?: string;
          r?: string;
          mid?: number;
        };
        if (ev.ev === "restarting") {
          filtered = true;
        } else if (ev.type === "msg" && typeof ev.r === "string" && typeof ev.mid === "number") {
          const prev = sinceMap[ev.r] ?? 0;
          if (ev.mid > prev) sinceMap[ev.r] = ev.mid;
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
  process.stdout.write(`ccmsg v${VERSION} — central-daemon messenger for Claude Code sessions

Usage:
  ccmsg <command> [args] [options]

Commands:
  post <room> <msg>            Post a message to a room (--to to filter delivery)
  create-room                  Open a room with peers (--members, --msg, --title)
  next-room <room>             Spawn the next thread of a room (--msg, --title)
  subscribe                    Stream room events as jsonl to stdout (--since)
  read <room> <mids>           Fetch messages by mid ("10-15,18" or "10,11")
  leave <room>                 Leave a room
  rooms                        List rooms (id / title / members / last_mid)
  peers                        List connected sessions
  notify                       Signal a session's subscribe stream (--self / --sid, --text)
  status                       Show daemon liveness / version / uptime / pid
  origins [list]               List persisted extra allowed Origins (webui reverse proxy)
  origins add <origin>         Allow an Origin (e.g. "https://ccmsg.example.com"), effective immediately
  origins remove <origin>      Remove a persisted Origin
  version                      Print the ccmsg version and exit
  daemon run [--foreground]    Run the daemon in this process
  daemon stop                  Gracefully stop the running daemon

Command Options:
  --to <ids>                   post: deliver only to these member id(s) + sender + u1,
                               comma-separated (e.g. u1,a2); others can still read it
  --members <sids>             create-room: participant sids, comma-separated
  --msg <text>                 create-room / next-room: initial message
  --title <text>               create-room / next-room: room title
  --since <json>               subscribe: per-room last-seen mid, e.g. '{"r7":7}'
  --self                       notify: target own session (default when no --sid)
  --sid <sid>                  notify: target session id
  --text <text>                notify: notification text
  --foreground                 daemon run: also log to stderr

Global Options:
  --as-user                    Act as the User (u1), overriding session detection
  --sid <sid>                  Act as this session id (for 'notify', --sid is the
                               target instead; use --as-session to set identity there)
  --as-session <sid>           Act as this session id (works for every command)
  -h, --help                   Show this help
  --version                    Print the ccmsg version and exit

Environment Variables:
  CCMSG_STATE_DIR              Override runtime dir (sock/lock/pid/log)
  CCMSG_DATA_DIR               Override data dir (rooms/<id>.jsonl)
  CCMSG_SID / CLAUDE_SESSION_ID  Session id for identity auto-detection
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

  const identity = resolveIdentity(opts, cmd);

  switch (cmd) {
    case "post": {
      const usage = "ccmsg post <room> <msg> [--to <ids>]";
      const room = requireArg(args[0], "room", usage);
      const msg = requireArg(args[1], "msg", usage);
      const to = parseIdList(str(opts, "to"));
      await runOnce(identity, { op: "post", room, msg, ...(to ? { to } : {}) });
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
      await runOnce(identity, {
        op: "create_room",
        members,
        ...(str(opts, "msg") ? { msg: str(opts, "msg") } : {}),
        ...(str(opts, "title") ? { title: str(opts, "title") } : {}),
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
      const usage = 'ccmsg read <room> <mids>   (e.g. ccmsg read r7 "10-15,18")';
      const room = requireArg(args[0], "room", usage);
      const mids = requireArg(args[1], "mids", usage);
      await runOnce(identity, { op: "read", room, mids });
      return;
    }
    case "leave": {
      const usage = "ccmsg leave <room>";
      const room = requireArg(args[0], "room", usage);
      await runOnce(identity, { op: "leave", room });
      return;
    }
    case "rooms": {
      await runOnce(identity, { op: "rooms" });
      return;
    }
    case "peers": {
      await runOnce(identity, { op: "peers" });
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
