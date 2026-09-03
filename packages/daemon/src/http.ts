// HTTP/WS transport (DR-0004). `/ws` speaks the same line protocol as UDS (DR-0003
// §1): 1 WS message frame = 1 JSON request in, 1 JSON response/event per frame out.
// The daemon's dispatch/delivery code (server.ts) never touches this file — it only
// sees `Conn.write`, so UDS and HTTP/WS are interchangeable to it.
import { handleAttachmentServe, handleAttachmentUpload } from "./attachment.ts";
import { handleFsServe } from "./fs-serve.ts";
import { isAllowed, type Cidr } from "./ip-allowlist.ts";
import type { OriginsFile } from "./origins-file.ts";
import { handleSandboxRequest, sandboxGidFromHost } from "./sandbox.ts";
import { handleRequest, removeConn, type Conn, type Daemon } from "./server.ts";
import { handleWebhookRequest } from "./webhook.ts";

export interface HttpFallback {
  (req: Request): Response | Promise<Response>;
}

export interface HttpListener {
  /** actual bound "host:port" — resolved even when the configured port was 0 (ephemeral). */
  address: string;
  stop(): void;
}

interface WsData {
  conn: Conn;
  /** Lines `ws.send()` reported as DROPPED (status 0 — Bun/uWebSockets returns this
   *  once bufferedAmount exceeds backpressureLimit, regardless of closeOnBackpressureLimit;
   *  verified against packages/bun-uws/src/WebSocket.h's send()). A -1 (BACKPRESSURE)
   *  status is NOT queued here: that message is already buffered internally by Bun and
   *  will be sent, so re-queuing it would double-send. `flushPending` below is the
   *  retry for actually-dropped lines, driven by both the writer and the socket's own
   *  `drain` event — the WS-side counterpart to the UDS pending queue in server.ts
   *  (`UdsConnState.pending` / `flushPending`), closing the gap where a large `join`
   *  backlog (server.ts sendBacklog, now uncapped for user-role subscribers) could
   *  silently drop lines past 16MB with no retry. */
  pending: string[];
}

/** Drain queued lines for one WS connection, same retry-until-still-dropped shape as
 *  the UDS side's flushPending. Stops (without emptying the queue) on the first line
 *  that's still over backpressureLimit, so it doesn't busy-loop; the next `drain`
 *  event resumes from there. */
function flushWsPending(ws: { data: WsData; send(line: string): number }): void {
  const state = ws.data;
  while (state.pending.length > 0) {
    const line = state.pending[0]!;
    let status: number;
    try {
      status = ws.send(line);
    } catch {
      // ws closing mid-flush; drop the rest, delivery is best-effort
      state.pending.length = 0;
      return;
    }
    if (status === 0) return; // still dropped: wait for the next drain
    state.pending.shift(); // -1 (already buffered by Bun) or >0 (sent): done with this line
  }
}

function parseBindSpec(spec: string): { hostname: string; port: number } {
  const idx = spec.lastIndexOf(":");
  if (idx < 0) throw new Error(`invalid CCMSG_HTTP_BIND entry (want host:port): ${spec}`);
  const hostname = spec.slice(0, idx);
  const port = Number(spec.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`invalid port in CCMSG_HTTP_BIND entry: ${spec}`);
  }
  return { hostname, port };
}

/**
 * Identity pinning (DR-0004 §2): anyone who can reach /ws past the Origin check below
 * is, by construction, kawaz (this daemon's own webui, or an explicitly configured
 * reverse-proxy Origin). A `hello` is repinned to role:"user" regardless of what it
 * claims — silently, not with a bad_request — because the trust boundary here is
 * "reachable == user", not "well-formed session claim == session". Rejecting a session
 * claim would suggest sessions are a legitimate thing to ask for over this transport;
 * they aren't (AI sessions only ever connect over UDS).
 */
function pinHelloToUser(line: string): string {
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    return line; // malformed JSON: let handleRequest's own parse report bad_request
  }
  if (req !== null && typeof req === "object" && (req as { op?: unknown }).op === "hello") {
    // Everything the client claimed about its identity is dropped; its
    // correlation id is not — the reply still has to reach the caller that is
    // waiting for it.
    const { request_id: requestId } = req as { request_id?: unknown };
    return JSON.stringify({
      op: "hello",
      role: "user",
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    });
  }
  return line;
}

/**
 * 127.0.0.0/8, ::1, and the "localhost" name all resolve to this same machine.
 * "[::1]" (bracketed) is included because Bun's `srv.hostname` reports an IPv6 bind
 * in bracket notation, verbatim as configured.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Origin verification (2026-07-10, DR-0004 trust-model addendum). The source-IP
 * allowlist alone does not stop a browser page from opening a cross-origin WebSocket
 * here: the Fetch spec's Same-Origin Policy does not gate WebSocket connections, and
 * the connecting IP is always "this machine" regardless of which page's JS opened the
 * socket — the browser IS the local machine. `Origin` is the only signal that tells
 * this daemon's own webui apart from any other page kawaz happens to have open.
 *
 * A browser always sends an `Origin` header on a WS handshake (RFC 6455 §4.1) and on
 * fetch/XHR; a *missing* header means a non-browser client (curl, a CLI health-check,
 * or Bun's own `WebSocket`/`fetch`, which this daemon's own tests use). The literal
 * string `"null"` is deliberately NOT treated as equivalent to missing: that's what a
 * browser sends for an opaque-origin context (`<iframe sandbox="allow-scripts">`,
 * `file://`, a `data:` URL) — exactly the shape an attacker's page would use to defeat
 * this check via a sandboxed iframe. No client in this codebase needs `"null"` to pass;
 * add it to `CCMSG_HTTP_ALLOW_ORIGIN` explicitly if one ever legitimately does.
 *
 * Loopback aliasing (2026-07-10, addendum to the addendum): when bound to a loopback
 * address, the exact-match check above only accepts the literal bind hostname (e.g.
 * `http://127.0.0.1:8642`). Opening the webui via `http://localhost:8642` instead —
 * an equally legitimate way to reach this same daemon — served the page fine but
 * failed every WS Origin check, since the page's origin is `http://localhost:8642`
 * while the bind's self-origin is `http://127.0.0.1:8642`: the socket 403'd and the
 * client reconnect-looped forever. `localhost` / `127.0.0.1` / `[::1]` on the same
 * port are accepted interchangeably whenever the bind itself is loopback, since they
 * all name this same machine. This does not widen the trust boundary: reaching this
 * daemon via any of these three names already requires being on this machine (the
 * only way `origin` could be forged to one of them from elsewhere is rewriting
 * `/etc/hosts` or DNS for `localhost`, which requires having already compromised the
 * host — at that point the attacker doesn't need this check bypassed).
 */
function isAllowedOrigin(
  origin: string | null,
  srv: { hostname?: string; port?: number },
  extraOrigins: Set<string>,
): boolean {
  if (origin === null) return true;
  if (srv.hostname !== undefined && srv.port !== undefined) {
    if (origin === `http://${srv.hostname}:${srv.port}`) return true;
    if (isLoopbackHostname(srv.hostname)) {
      const port = srv.port;
      if (
        origin === `http://localhost:${port}` ||
        origin === `http://127.0.0.1:${port}` ||
        origin === `http://[::1]:${port}`
      ) {
        return true;
      }
    }
  }
  return extraOrigins.has(origin);
}

/**
 * Origins a sandbox preview may be framed by, for the CSP `frame-ancestors`
 * DR-0030 §6.1 requires to come from config rather than a literal. The apps-
 * side webui origin is exactly the set this daemon already trusts to talk to
 * it — env `CCMSG_HTTP_ALLOW_ORIGIN`, the persisted `origins add` file, the
 * tailscale auto-allow additions, plus its own bind origin — so that set is
 * the config, and no second place to name the same host is introduced.
 *
 * Computed per request because two of those sources mutate after startup
 * (tailscale auto-allow writes into `extraOrigins`; `ccmsg origins add` writes
 * the file the listener re-reads). An empty set yields `'none'` at the call
 * site, which is the right default: nothing is allowed to frame it.
 */
async function frameAncestorsFor(
  srv: { hostname?: string; port?: number },
  extraOrigins: Set<string>,
  originsFile?: OriginsFile,
): Promise<string[]> {
  const out = new Set<string>(extraOrigins);
  for (const o of (await originsFile?.get()) ?? []) out.add(o);
  if (srv.hostname !== undefined && srv.port !== undefined) {
    out.add(`http://${srv.hostname}:${srv.port}`);
  }
  return [...out];
}

export function startHttpListener(
  daemon: Daemon,
  bindSpec: string,
  allow: Cidr[],
  extraOrigins: Set<string>,
  fallback?: HttpFallback,
  originsFile?: OriginsFile,
): HttpListener {
  const { hostname, port } = parseBindSpec(bindSpec);
  const server = Bun.serve<WsData>({
    hostname,
    port,
    async fetch(req, srv) {
      // Source-IP allowlist (DR-0004 §3 addendum): defense-in-depth belt in case
      // CCMSG_HTTP_BIND is misconfigured beyond loopback. Runs before the WS upgrade
      // too, since fetch() is where upgrade happens. requestIP() returning null (e.g.
      // a unix-socket-backed Request in tests) is treated as not-allowed — fail
      // closed, never fail open on an unknown remote.
      const remote = srv.requestIP(req);
      if (remote === null || !isAllowed(remote.address, allow)) {
        return new Response("Forbidden", { status: 403 });
      }
      // Sandbox origin branch (DR-0030 §3.2). Placed between the source-IP
      // belt and the Origin check, and it RETURNS UNCONDITIONALLY: a request
      // whose Host names the sandbox domain is consumed here and can never
      // fall through to /ws, /attachment, /webhook, /fs-serve or the webui
      // fallback below, whatever its path happens to be. That structural
      // property — not a second listener on a second port — is what keeps the
      // control plane unreachable from the untrusted origin, and it is the one
      // invariant this file must preserve: keep this above the Origin check
      // and above the route table, and keep the branch returning.
      //
      // It sits above the Origin check rather than inside it because a
      // cross-site sandbox request either sends no Origin (top-level
      // navigation) or one that can never be on the allowlist; running it
      // through step 3 would 403 the feature out of existence. Adding a
      // sandbox exemption *inside* isAllowedOrigin would be the dangerous
      // shape — that exemption would then also apply to /ws. Authorization for
      // this branch is the URL capability token, checked in handleSandbox.
      const sandboxGid = sandboxGidFromHost(daemon.sandboxOrigin, req.headers.get("Host"));
      if (sandboxGid !== null) {
        return await handleSandboxRequest(
          {
            grants: daemon.sandboxGrants,
            origin: daemon.sandboxOrigin,
            sessions: daemon.sessions,
            statusStore: daemon.sessionStatus,
            frameAncestors: () => frameAncestorsFor(srv, extraOrigins, originsFile),
          },
          sandboxGid,
          req,
        );
      }
      // Origin check (see isAllowedOrigin doc comment above) — the actual trust
      // boundary for browser clients, source-IP allowlisting can't express it.
      // The persisted origins file is consulted only on failure of every other
      // check (env / self-origin / tailscale): the happy path stays fs-free and
      // an `origins add` takes effect on the next request without a restart.
      const origin = req.headers.get("Origin");
      if (
        !isAllowedOrigin(origin, srv, extraOrigins) &&
        !(origin !== null && (await originsFile?.get())?.has(origin))
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const conn: Conn = { write: () => {}, identity: null, subscribed: false };
        const upgraded = srv.upgrade(req, { data: { conn, pending: [] } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade required", { status: 400 });
      }
      // DR-0015 attachment endpoints. Must fire before the fallback so the
      // webui Hono app never sees these paths (it would 404 them, drowning
      // out the real 400/413/500 status the upload/serve routes produce).
      if (url.pathname === "/attachment" && req.method === "POST") {
        return handleAttachmentUpload(req);
      }
      if (url.pathname.startsWith("/attachment/") && req.method === "GET") {
        return handleAttachmentServe(url.pathname.slice("/attachment/".length));
      }
      // Inbound webhooks (webhook.ts). Authorization is per-source and lives
      // in that module — the source-IP and Origin checks above are about
      // browsers, and a producer posting from another host with a valid token
      // is a legitimate caller the moment CCMSG_HTTP_ALLOW admits it.
      if (url.pathname.startsWith("/webhook/") && req.method === "POST") {
        return await handleWebhookRequest(
          req,
          url.pathname.slice("/webhook/".length),
          daemon.webhooks,
          daemon.log,
        );
      }
      // Image serve for the FileViewer (see fs-serve.ts). Same trust boundary
      // (source-IP + Origin already checked above); per-request authorization
      // reuses fs_read / fs_read_external / fs_read_workspace containment.
      if (url.pathname === "/fs-serve" && req.method === "GET") {
        return await handleFsServe(daemon.sessions, daemon.sessionStatus, url);
      }
      if (fallback) return fallback(req);
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const conn = ws.data.conn;
        conn.write = (line: string) => {
          const state = ws.data;
          if (state.pending.length > 0) {
            // already draining a backlog: queue behind it to keep delivery order
            state.pending.push(line);
            return;
          }
          let status: number;
          try {
            status = ws.send(line);
          } catch {
            // ws may be closing; delivery is best-effort, mirrors UDS send()
            return;
          }
          if (status === 0) state.pending.push(line); // dropped: retry on drain
        };
        daemon.connections.add(conn);
      },
      message(ws, message) {
        const conn = ws.data.conn;
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        for (const rawLine of text.split("\n")) {
          const trimmed = rawLine.trim();
          if (trimmed === "") continue;
          handleRequest(daemon, conn, pinHelloToUser(trimmed));
        }
      },
      drain(ws) {
        flushWsPending(ws);
      },
      close(ws) {
        removeConn(daemon, ws.data.conn);
      },
    },
  });
  return {
    address: `${server.hostname}:${server.port}`,
    stop: () => {
      void server.stop();
    },
  };
}
