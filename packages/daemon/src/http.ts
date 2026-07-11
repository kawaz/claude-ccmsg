// HTTP/WS transport (DR-0004). `/ws` speaks the same line protocol as UDS (DR-0003
// §1): 1 WS message frame = 1 JSON request in, 1 JSON response/event per frame out.
// The daemon's dispatch/delivery code (server.ts) never touches this file — it only
// sees `Conn.write`, so UDS and HTTP/WS are interchangeable to it.
import { isAllowed, type Cidr } from "./ip-allowlist.ts";
import type { OriginsFile } from "./origins-file.ts";
import { handleRequest, removeConn, type Conn, type Daemon } from "./server.ts";

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
    return JSON.stringify({ op: "hello", role: "user" });
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
    fetch(req, srv) {
      // Source-IP allowlist (DR-0004 §3 addendum): defense-in-depth belt in case
      // CCMSG_HTTP_BIND is misconfigured beyond loopback. Runs before the WS upgrade
      // too, since fetch() is where upgrade happens. requestIP() returning null (e.g.
      // a unix-socket-backed Request in tests) is treated as not-allowed — fail
      // closed, never fail open on an unknown remote.
      const remote = srv.requestIP(req);
      if (remote === null || !isAllowed(remote.address, allow)) {
        return new Response("Forbidden", { status: 403 });
      }
      // Origin check (see isAllowedOrigin doc comment above) — the actual trust
      // boundary for browser clients, source-IP allowlisting can't express it.
      // The persisted origins file is consulted only on failure of every other
      // check (env / self-origin / tailscale): the happy path stays fs-free and
      // an `origins add` takes effect on the next request without a restart.
      const origin = req.headers.get("Origin");
      if (
        !isAllowedOrigin(origin, srv, extraOrigins) &&
        !(origin !== null && originsFile?.get().has(origin))
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const conn: Conn = { write: () => {}, identity: null, subscribed: false };
        const upgraded = srv.upgrade(req, { data: { conn } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade required", { status: 400 });
      }
      if (fallback) return fallback(req);
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const conn = ws.data.conn;
        conn.write = (line: string) => {
          try {
            ws.send(line);
          } catch {
            // ws may be closing; delivery is best-effort, mirrors UDS send()
          }
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
