#!/usr/bin/env bun
// ccmsg CLI. Subcommand style, long options, no-args prints help (per kawaz CLI
// conventions). Every command except `daemon run` goes through ensure-daemon.
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

function resolveIdentity(opts: Record<string, string | boolean>, cmd: string): Identity {
  if (opts["as-user"] === true) return { role: "user" };
  // `notify` uses --sid for its target, so it must not double as an identity override
  // there; --as-session still works everywhere.
  const sidOverride =
    cmd === "notify" ? str(opts, "as-session") : (str(opts, "sid") ?? str(opts, "as-session"));
  const sid = sidOverride ?? process.env.CCMSG_SID ?? process.env.CLAUDE_SESSION_ID;
  if (sid) {
    // Empty string is treated the same as unset (falsy `?` guard below) — an
    // env var present-but-blank must not turn into transcript_path: "".
    const transcriptPath = process.env.CCMSG_TRANSCRIPT_PATH;
    return {
      role: "session",
      sid,
      repo: process.env.CCMSG_REPO ?? "",
      ws: process.env.CCMSG_WS ?? "",
      cwd: process.cwd(),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
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
  post <room> <msg>            Post a message to a room (--to for mentions)
  create-room                  Open a room with peers (--members, --msg, --title)
  next-room <room>             Spawn the next thread of a room (--msg, --title)
  subscribe                    Stream room events as jsonl to stdout (--since)
  read <room> <mids>           Fetch messages by mid ("10-15,18" or "10,11")
  leave <room>                 Leave a room
  rooms                        List rooms (id / title / members / last_mid)
  peers                        List connected sessions
  notify                       Signal a session's subscribe stream (--self / --sid, --text)
  status                       Show daemon liveness / version / uptime / pid
  version                      Print the ccmsg version and exit
  daemon run [--foreground]    Run the daemon in this process
  daemon stop                  Gracefully stop the running daemon

Command Options:
  --to <ids>                   post: mention member id(s), comma-separated (e.g. u1,a2)
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
  CCMSG_TRANSCRIPT_PATH        This session's Claude Code transcript jsonl path,
                               sent in hello (set by the SessionStart hook,
                               DR-0009); adopted only if the daemon accepts it
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
    default: {
      process.stderr.write(`ccmsg: unknown command '${cmd}'\n\n`);
      printHelp();
      process.exitCode = 1;
      return;
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ccmsg: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// re-export for tests / embedding
export { Client, ensureDaemon };
