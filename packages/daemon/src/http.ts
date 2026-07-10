// HTTP/WS transport (DR-0004). `/ws` speaks the same line protocol as UDS (DR-0003
// §1): 1 WS message frame = 1 JSON request in, 1 JSON response/event per frame out.
// The daemon's dispatch/delivery code (server.ts) never touches this file — it only
// sees `Conn.write`, so UDS and HTTP/WS are interchangeable to it.
import { isAllowed, type Cidr } from "./ip-allowlist.ts";
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
 * Identity pinning (DR-0004 §2): anyone who can reach /ws is, by construction, kawaz
 * (127.0.0.1 = this machine, tailscale = a device he owns). A `hello` is repinned to
 * role:"user" regardless of what it claims — silently, not with a bad_request — because
 * the trust boundary here is "reachable == user", not "well-formed session claim ==
 * session". Rejecting a session claim would suggest sessions are a legitimate thing to
 * ask for over this transport; they aren't (AI sessions only ever connect over UDS).
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

export function startHttpListener(
  daemon: Daemon,
  bindSpec: string,
  allow: Cidr[],
  fallback?: HttpFallback,
): HttpListener {
  const { hostname, port } = parseBindSpec(bindSpec);
  const server = Bun.serve<WsData>({
    hostname,
    port,
    fetch(req, srv) {
      // Source-IP allowlist (DR-0004 §3 addendum): the default 0.0.0.0 bind means
      // "reachable" no longer implies "kawaz" by itself, so this gate is what makes
      // identity pinning's threat model (pinHelloToUser below) hold. Runs before the
      // WS upgrade too, since fetch() is where upgrade happens. requestIP() returning
      // null (e.g. a unix-socket-backed Request in tests) is treated as not-allowed —
      // fail closed, never fail open on an unknown remote.
      const remote = srv.requestIP(req);
      if (remote === null || !isAllowed(remote.address, allow)) {
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
