// Zero-config tailscale serve origin auto-allow (docs/issue/2026-07-11-tailscale-serve-
// origin-auto-allow.md, DR-0004 trust-model addendum). `tailscale serve status --json`
// reports which ts.net hostnames this machine's tailscale serve is proxying to which
// local port. If one of those ports is a port this daemon itself is bound to, the page
// served at that ts.net hostname *is* this daemon's own webui (TLS-terminated on this
// machine by serve) — so its origin can be trusted the same way a loopback bind's own
// origin is, without requiring CCMSG_HTTP_ALLOW_ORIGIN to be set by hand on every daemon
// respawn. Everything here is best-effort: tailscale not installed, not running, not
// serving, or any parse hiccup all resolve to an empty set, never an error the caller
// has to handle.

import type { Logger } from "./log.ts";

/** Shape of the parts of `tailscale serve status --json` this module reads. Everything
 *  else in the real payload (TCP block, Handlers.Path/Text for non-proxy handler kinds,
 *  etc.) is irrelevant here and deliberately left untyped (`unknown`) rather than
 *  modeled, since a schema drift there must never break origin detection. */
interface ServeStatusShape {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

function extractPort(proxyUrl: string): number | undefined {
  try {
    const port = new URL(proxyUrl).port;
    return port === "" ? undefined : Number(port);
  } catch {
    return undefined;
  }
}

/** `Web` keys are `"<hostname>:<port>"` (e.g.
 *  `"kawaz-mbp16-20211217.tail3c970.ts.net:443"`, observed 2026-07-11 via `tailscale
 *  serve status --json`). Split off the trailing `:<port>`, not the first colon, so an
 *  IPv6-literal hostname (not a real tailscale case today, but Web key parsing shouldn't
 *  assume otherwise) wouldn't be mis-split either. */
function splitWebKey(key: string): { hostname: string; port: number } | undefined {
  const idx = key.lastIndexOf(":");
  if (idx < 0) return undefined;
  const port = Number(key.slice(idx + 1));
  if (!Number.isInteger(port)) return undefined;
  return { hostname: key.slice(0, idx), port };
}

/** Pure JSON->origins extraction (RED/GREEN unit-testable without a real tailscale
 *  binary). `status` is `unknown` because it's untrusted subprocess output — every shape
 *  assumption is guarded rather than asserted.
 *
 *  A `Web` entry is trusted iff at least one of its Handlers proxies to a port in
 *  `boundPorts` (this daemon's own HTTP bind ports): that's the "serve is fronting *this*
 *  daemon" signal the trust model relies on (DR-0004 addendum). The serve entry's own
 *  front-end port (443 in the `Web` key, always HTTPS per tailscale serve semantics) is
 *  what the browser's Origin will actually carry, not the backend port being proxied to
 *  — so the returned origin omits :443 (the standard "https implies 443" elision) and
 *  keeps other ports explicit. */
export function extractProxiedOrigins(status: unknown, boundPorts: Set<number>): Set<string> {
  const origins = new Set<string>();
  if (status === null || typeof status !== "object") return origins;
  const web = (status as ServeStatusShape).Web;
  if (web === null || typeof web !== "object") return origins;
  for (const [key, entry] of Object.entries(web)) {
    const parsed = splitWebKey(key);
    if (!parsed) continue;
    if (entry === null || typeof entry !== "object") continue;
    const handlers = entry.Handlers;
    if (handlers === null || typeof handlers !== "object") continue;
    const proxiesToBoundPort = Object.values(handlers).some((h) => {
      if (h === null || typeof h !== "object" || typeof h.Proxy !== "string") return false;
      const port = extractPort(h.Proxy);
      return port !== undefined && boundPorts.has(port);
    });
    if (!proxiesToBoundPort) continue;
    // hostname trailing dot: not observed on Web keys in practice (tailscale renders
    // them without one), but strip defensively since DNSName elsewhere in tailscale's
    // own output does carry one and a future tailscale version drifting here must not
    // silently produce a `..ts.net.` origin that never matches anything.
    const hostname = parsed.hostname.replace(/\.$/, "");
    origins.add(parsed.port === 443 ? `https://${hostname}` : `https://${hostname}:${parsed.port}`);
  }
  return origins;
}

export interface FetchServeOriginsOptions {
  /** overrides the `tailscale` binary looked up on PATH (test seam, mirrors
   *  CCMSG_DAEMON_ENTRY's "test-only knob via env var" precedent in cli/src/client.ts). */
  bin?: string;
  timeoutMs?: number;
  log?: Logger;
}

/** `CCMSG_TAILSCALE_STATUS_TIMEOUT_MS` (mirrors resolveDedupWindow's
 *  parse-or-fall-back-to-default shape in server.ts): missing, empty, or non-finite/negative
 *  values all fall through to the caller-supplied default rather than throwing. Test-only
 *  knob to widen the timeout on loaded CI runners; production leaves it unset. */
export function resolveStatusTimeoutMs(defaultMs: number): number {
  const raw = process.env.CCMSG_TAILSCALE_STATUS_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return defaultMs;
}

/** Best-effort: runs `tailscale serve status --json`, parses it, and returns the origins
 *  it proxies to `boundPorts`. Never throws and never blocks longer than `timeoutMs` —
 *  binary absent (ENOENT), non-zero exit, malformed JSON, and timeout all collapse to an
 *  empty Set. One log line either way (issue's "best-effort... failure is a single log
 *  line" contract), never more: this must stay cheap to call from every daemon start. */
export async function fetchTailscaleServeOrigins(
  boundPorts: Set<number>,
  opts: FetchServeOriginsOptions = {},
): Promise<Set<string>> {
  const bin = opts.bin ?? "tailscale";
  // Design rationale: production default stays 1000ms (DR-0004 best-effort contract —
  // never delay daemon startup waiting on tailscale). CCMSG_TAILSCALE_STATUS_TIMEOUT_MS
  // exists only so tests can widen the timeout past scheduler jitter on loaded runners.
  const timeoutMs = opts.timeoutMs ?? resolveStatusTimeoutMs(1000);
  try {
    const proc = Bun.spawn([bin, "serve", "status", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) {
      opts.log?.info(`tailscale serve status exited ${exitCode}, skipping origin auto-allow`);
      return new Set();
    }
    const parsed: unknown = JSON.parse(stdout);
    const origins = extractProxiedOrigins(parsed, boundPorts);
    opts.log?.info(
      origins.size > 0
        ? `tailscale serve origin auto-allow: ${[...origins].join(", ")}`
        : "tailscale serve status has no entry proxying to this daemon's bind ports",
    );
    return origins;
  } catch (e) {
    opts.log?.info(`tailscale serve status unavailable, skipping origin auto-allow: ${String(e)}`);
    return new Set();
  }
}
