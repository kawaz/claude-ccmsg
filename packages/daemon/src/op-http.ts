// A hooks module's way to the daemon (DR-0046): HTTP over `<state dir>/
// http.sock`, one endpoint `POST /op`. The body is a request of the wire with
// the `hello` it is asked under; the answer is the wire's reply to it. Each
// request is a connection of its own: its hello, then its request, go through
// what a line on `daemon.sock` goes through (server.ts serveRequest), and the
// connection goes when the reply is written.
//
// Who asks is not what the body says but the process at the other end of the
// socket (peer-pid.ts): the Claude Code process whose `$.http.fetch` this is.
// Its `<config dir>/sessions/<pid>.json`, in a config dir this daemon reaches,
// names the session; a process no such file names is refused. The body's
// `hello` carries only what the process does not tell: the session id the
// module means (checked against the file), its build and the wire's
// generation.
//
// Design rationale: no Origin or source-address check, unlike http.ts. The
// socket is the daemon's uid's alone (0600), as `daemon.sock` is, and a
// browser's fetch or WebSocket cannot name a Unix socket, so no page reaches
// it.
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as v from "valibot";
import {
  ClaudeSessionFileTextSchema,
  ErrorCode,
  jsonText,
  JsonObjectSchema,
  type JsonObject,
  OP_HTTP_PATH,
  parseWith,
  type RequestOp,
} from "@ccmsg/protocol";
import { type Http1Request, type Http1Response, readHttp1, writeHttp1 } from "./http1.ts";
import { peerPid } from "./peer-pid.ts";
import { removeConn, serveRequest, sessionScope, type Conn, type Daemon } from "./server.ts";

export interface OpHttpListener {
  stop(): Promise<void>;
}

/** The ops that mean something only on a connection that stays open after
 * the reply: the hello (asked by the body's `hello`), the run a sidecar names
 * for as long as its connection is open, and the subscriptions of a
 * connection's pushes. A connection here closes with its reply. */
const CONNECTION_OPS = [
  "hello",
  "sidecar_hello",
  "subscribe",
  "transcript_subscribe",
  "transcript_unsubscribe",
  "session_status_subscribe",
  "session_status_unsubscribe",
] as const satisfies readonly RequestOp[];

const ConnectionOpSchema = v.object({ op: v.picklist(CONNECTION_OPS) });

const BodySchema = jsonText(JsonObjectSchema);

/** What the body's `hello` says: the session the module means, and what no
 * file of the process tells (its build, the wire's generation). The protocol
 * is read as any number, so a hello of another generation reaches the
 * generation check and is refused there with the generation this daemon
 * speaks. */
const OpHelloSchema = v.object({
  sid: v.string(),
  client_version: v.optional(v.string()),
  protocol: v.optional(v.number()),
});

/** A line the daemon wrote, as far as telling a reply apart: a reply has
 * `ok`, and names the request it answers unless its frame did not read. */
const ReplyLineSchema = jsonText(v.object({ ok: v.boolean(), request_id: v.optional(v.string()) }));

/** The correlation ids the two requests of a connection go under. */
const HELLO_ID = "hello";
const OP_ID = "op";

/** A reply as the wire writes one, as the answer. */
function answer(reply: string, status = 200): Http1Response {
  return { status, contentType: "application/json", body: reply };
}

/** A refusal the endpoint writes itself, as the wire writes one. */
function refusal(status: number, code: string, msg: string): Http1Response {
  return answer(JSON.stringify({ ok: false, error: { code, msg } }), status);
}

/** A connection that keeps the lines written to it. */
function capturingConn(): { conn: Conn; lines: string[] } {
  const lines: string[] = [];
  const conn: Conn = {
    write: (line) => {
      lines.push(line.trimEnd());
    },
    identity: null,
    subscribed: false,
  };
  return { conn, lines };
}

/** Serve `request` on `conn` under `id`, and the reply it got: the line that
 * answers `id`, or the one that answers no id (a request whose frame did not
 * read). */
async function ask(
  daemon: Daemon,
  capture: { conn: Conn; lines: string[] },
  request: object,
  id: string,
): Promise<{ line: string; ok: boolean } | undefined> {
  const from = capture.lines.length;
  await serveRequest(daemon, capture.conn, JSON.stringify({ ...request, request_id: id }));
  for (const line of capture.lines.slice(from)) {
    const read = parseWith(ReplyLineSchema, line);
    if (!read.ok) continue;
    if (read.value.request_id === id || read.value.request_id === undefined) {
      return { line, ok: read.value.ok };
    }
  }
  return undefined;
}

/** The session process `pid` runs, as its `sessions/<pid>.json` in a config
 * dir this daemon reaches names it (the dirs it serves, and the dir a
 * session's own hello named for that session), or why there is none. */
async function sessionOf(
  daemon: Daemon,
  pid: number,
): Promise<{ sid: string; configDir: string } | { why: string }> {
  const scope = sessionScope(daemon);
  for (const configDir of scope.dirs) {
    let text: string;
    try {
      text = await readFile(path.join(configDir, "sessions", `${String(pid)}.json`), "utf8");
    } catch {
      continue;
    }
    const read = parseWith(ClaudeSessionFileTextSchema, text);
    if (!read.ok || read.value.pid !== pid) continue;
    if (scope.has(configDir, read.value.sessionId)) {
      return { sid: read.value.sessionId, configDir };
    }
  }
  return {
    why: `process ${String(pid)} is not a Claude Code session in a config dir this daemon reaches`,
  };
}

/** Answer one request to the socket, from the process `pid` (undefined when
 * the socket did not say). */
export async function answerOp(
  daemon: Daemon,
  request: Http1Request,
  pid: number | undefined,
): Promise<Http1Response> {
  if (request.path !== OP_HTTP_PATH) {
    return { status: 404, contentType: "text/plain", body: "Not Found: the one path is POST /op" };
  }
  if (request.method !== "POST") {
    return {
      status: 405,
      contentType: "text/plain",
      body: "Method Not Allowed: POST /op",
      headers: { allow: "POST" },
    };
  }
  const body = parseWith(BodySchema, request.body, { firstIssue: true });
  if (!body.ok) {
    return refusal(
      400,
      ErrorCode.bad_request,
      `the body is a request of the wire as one JSON object: ${body.failure.summary}`,
    );
  }
  const { hello, ...op } = body.value;
  const named = parseWith(OpHelloSchema, hello);
  if (!named.ok) {
    return refusal(
      400,
      ErrorCode.bad_request,
      `the body names the hello the request is asked under in \`hello\` ({ sid, client_version?, protocol? }): ${named.failure.summary}`,
    );
  }
  const bound = parseWith(ConnectionOpSchema, op);
  if (bound.ok) {
    return refusal(
      200,
      ErrorCode.bad_request,
      `op '${bound.value.op}' needs a connection that stays open; POST /op closes it with the reply (use daemon.sock)`,
    );
  }
  if (pid === undefined) {
    return refusal(
      200,
      ErrorCode.unknown_peer,
      "the process at the other end of the socket cannot be told",
    );
  }
  const session = await sessionOf(daemon, pid);
  if ("why" in session) return refusal(200, ErrorCode.unknown_peer, session.why);
  if (session.sid !== named.value.sid) {
    return refusal(
      200,
      ErrorCode.unknown_peer,
      `process ${String(pid)} runs session ${session.sid}, not ${named.value.sid} (its id may have just changed: /clear, /resume)`,
    );
  }
  const greeting: JsonObject = {
    op: "hello",
    role: "session",
    sid: session.sid,
    config_dir: session.configDir,
    ...(named.value.client_version !== undefined
      ? { client_version: named.value.client_version }
      : {}),
    ...(named.value.protocol !== undefined ? { protocol: named.value.protocol } : {}),
  };
  const capture = capturingConn();
  daemon.connections.add(capture.conn);
  try {
    const greeted = await ask(daemon, capture, greeting, HELLO_ID);
    if (greeted === undefined)
      return refusal(500, "internal", "the hello was answered with no reply");
    if (!greeted.ok) return answer(greeted.line);
    const answered = await ask(daemon, capture, op, OP_ID);
    return answered === undefined
      ? refusal(500, "internal", "the request was answered with no reply")
      : answer(answered.line);
  } finally {
    removeConn(daemon, capture.conn);
  }
}

/** A Bun socket's file descriptor, which Bun has and its types do not. */
const SocketFdSchema = v.object({ fd: v.pipe(v.number(), v.integer(), v.minValue(0)) });

/** What one connection has sent, and who sent it. */
interface OpConnState {
  pid: number | undefined;
  received: Uint8Array;
  answering: boolean;
  /** The response's bytes the socket has not taken yet. A write takes what
   * the socket has room for and keeps nothing, so the rest goes on `drain`,
   * and the connection ends once none is left. */
  unsent: Uint8Array | undefined;
}

function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head);
  bytes.set(tail, head.length);
  return bytes;
}

/** Hand the socket as much of the response as it takes now, and end the
 * connection once it has taken all of it. */
function flush(socket: { data: OpConnState; write(bytes: Uint8Array): number; end(): void }): void {
  const unsent = socket.data.unsent;
  if (unsent === undefined) return;
  const taken = socket.write(unsent);
  if (taken < 0) {
    socket.data.unsent = undefined;
    socket.end();
    return;
  }
  socket.data.unsent = unsent.subarray(taken);
  if (socket.data.unsent.length === 0) {
    socket.data.unsent = undefined;
    socket.end();
  }
}

/** Bind `paths.httpSock` and answer `POST /op` there, one request per
 * connection. Whatever is at the path is a predecessor's: this daemon holds
 * the lock, as for `daemon.sock`. No connection is cut for idling: when a
 * reply is written is the op's to say (send_message waits for its deliveries,
 * session_launch for its launch command). */
export function listenOpHttp(daemon: Daemon): OpHttpListener {
  const socketPath = daemon.paths.httpSock;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // nothing there
  }
  const server = Bun.listen<OpConnState>({
    unix: socketPath,
    socket: {
      open(socket) {
        const fd = parseWith(SocketFdSchema, socket);
        socket.data = {
          pid: fd.ok ? peerPid(fd.value.fd) : undefined,
          received: new Uint8Array(0),
          answering: false,
          unsent: undefined,
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.answering) return;
        state.received = joined(state.received, chunk);
        const read = readHttp1(state.received);
        if (read.kind === "incomplete") return;
        state.answering = true;
        const responding: Promise<Http1Response> =
          read.kind === "refused"
            ? Promise.resolve({ status: read.status, contentType: "text/plain", body: read.reason })
            : answerOp(daemon, read.request, state.pid);
        void responding
          .catch((e: unknown): Http1Response => {
            daemon.log.error(`POST /op failed: ${String(e)}`);
            return refusal(500, "internal", String(e));
          })
          .then((response) => {
            state.unsent = writeHttp1(response);
            flush(socket);
          });
      },
      drain(socket) {
        flush(socket);
      },
      error(_socket, err) {
        daemon.log.error(`op http socket error: ${String(err)}`);
      },
    },
  });
  fs.chmodSync(socketPath, 0o600);
  return {
    stop: async () => {
      server.stop(true);
    },
  };
}
