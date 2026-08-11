// Sandbox-origin serving (DR-0030 Phase 1): MIME-unrestricted delivery of raw
// files over a separate eTLD+1, reached through canddy's wildcard sandbox
// domain and dispatched off the existing 8642 listener by `Host` (§3.2).
//
//   https://ccmsg-files-<gid>.<sandbox-domain>/<token>/<relpath>
//
// `<gid>` is a non-secret origin-separation key that rides in the DNS label;
// `<token>` is the secret and lives in the path so a preview page's relative
// subresources (./style.css) inherit it through ordinary URL resolution (§3.3).
//
// Authorization is NOT what the grant provides. Every request re-runs
// `fsResolveForServe` — the same containment / allowlist checks fs_read,
// fs_read_external and fs_read_workspace apply — so a grant can only ever
// narrow (to one subtree, for 30 minutes, for whoever knows the URL), never
// widen (§5). The `X-Sandbox-Token` header canddy sets and the `Host` header
// itself are index material only, never authorization (§3.1).
import { timingSafeEqual } from "node:crypto";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode } from "@ccmsg/protocol";
import { mimeForExtension } from "./attachment.ts";
import { fsResolveForServe, type SessionLookup } from "./fs-access.ts";
import type { SessionStatusStore } from "./session-status.ts";

/** Grant lifetime, fixed at 30 minutes from mint (DR-0030 §4.3). Deliberately
 * not sliding: an open tab must not keep its origin alive indefinitely. The
 * webui re-mints (reusing the same gid, §4.1.2) when it needs longer. */
export const SANDBOX_GRANT_TTL_MS = 30 * 60 * 1000;

/** Character set of both gid and token: lowercase base32. Forced by canddy's
 * `host_regexp ^ccmsg-files-([a-z2-7]+)\.…$` (§3.1) for the gid; the token
 * shares it so both halves of a sandbox URL look alike and neither needs
 * percent-encoding. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** 256 / 32 is exact, so masking a random byte with 31 indexes the alphabet
 * uniformly — no modulo bias, no rejection loop. */
function randomBase32(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32_ALPHABET[bytes[i]! & 31];
  return out;
}

const GID_LENGTH = 16; // 80 bits — an identifier, not a secret
const TOKEN_LENGTH = 32; // 160 bits — the capability itself

export interface SandboxGrant {
  gid: string;
  token: string;
  sid: string;
  kind: "contained" | "external" | "workspace";
  /** Path the serve side rebases requests onto, in the spelling `kind`
   * requires: relative-to-containment-root for `contained`, absolute for
   * `workspace`, and (for `external`) the absolute file itself — DR-0024's
   * allowlist is exact-match, so that grant stays bound to one file (§4.1.1). */
  scopePath: string;
  /** Realpath of the scope root at mint time, used only as the closing belt on
   * the serve side: whatever `fsResolveForServe` hands back must still live
   * under (or, for `external`, be exactly) this. `fsResolveForServe` enforces
   * the *session's* containment root, which is wider than the grant's subtree
   * — this is what actually pins a grant to its directory. */
  scopeRealPath: string;
  /** Basename of the granted file, so `external` can bind its single legal
   * relpath and both other kinds can name the file in the minted URL. */
  fileName: string;
  /** Epoch ms after which the grant is gone (§4.3). */
  exp: number;
}

export interface SandboxGrants {
  /** gid → grant. Memory only: DR-0029 keeps this off the filesystem, and
   * §4.1.2 wants a daemon restart to invalidate everything. */
  byGid: Map<string, SandboxGrant>;
  /** `${sid}\0${kind}\0${scopePath}` → gid, backing the §4.1.2 reuse rule.
   * `kind` joins the key the DR states as (sid, scopeRoot) because the same
   * string means different things per kind — an absolute workspace path and an
   * absolute external file path can be spelled identically. */
  byScope: Map<string, string>;
  /** Injectable clock; production leaves it as Date.now. */
  now: () => number;
}

export function createSandboxGrants(now: () => number = Date.now): SandboxGrants {
  return { byGid: new Map(), byScope: new Map(), now };
}

function scopeKey(sid: string, kind: string, scopePath: string): string {
  return `${sid}\0${kind}\0${scopePath}`;
}

/** Drop everything already past its exp. Called from the paths that touch the
 * table anyway (mint / lookup) rather than from a timer — the table is small
 * and a sweep that only runs on use has no idle cost. */
function prune(grants: SandboxGrants): void {
  const now = grants.now();
  for (const [gid, grant] of grants.byGid) {
    if (grant.exp <= now) {
      grants.byGid.delete(gid);
      grants.byScope.delete(scopeKey(grant.sid, grant.kind, grant.scopePath));
    }
  }
}

// --- origin template ----------------------------------------------------

export interface SandboxOrigin {
  /** The configured `sandbox_origin_template`, e.g.
   * `https://ccmsg-files-{gid}.host.example`. */
  template: string;
  /** Matches the `Host` header (port stripped) and captures the gid. */
  hostRe: RegExp;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a configured template into the host matcher the dispatcher needs.
 * Returns null for anything unusable, so a malformed config degrades to
 * "sandbox serving is off" rather than to a daemon that answers on a pattern
 * nobody intended.
 *
 * The `{gid}` placeholder must sit in the hostname: putting it in the path
 * would mean every grant shares one origin, which defeats the entire point
 * (§3.3). The captured label is constrained to `[a-z2-7]+` to match exactly
 * what canddy's own `host_regexp` will forward (§3.1) — a wider pattern here
 * would accept hosts that can never actually arrive through the proxy.
 */
export function compileSandboxOrigin(template: string | undefined): SandboxOrigin | null {
  if (!template) return null;
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  const host = url.hostname;
  const parts = host.split("{gid}");
  if (parts.length !== 2) return null;
  const hostRe = new RegExp(`^${escapeRegExp(parts[0]!)}([a-z2-7]+)${escapeRegExp(parts[1]!)}$`);
  return { template: template.replace(/\/+$/, ""), hostRe };
}

/** Strip the `:port` a browser may append before matching the pattern. IPv6
 * literals are bracketed and can never match a `{gid}`-bearing DNS name, so
 * the naive last-colon split is safe here. */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader; // IPv6 literal: never a sandbox host
  const colon = hostHeader.lastIndexOf(":");
  return colon < 0 ? hostHeader : hostHeader.slice(0, colon);
}

/** The gid this `Host` names, or null when the header is not a sandbox host.
 * Non-null is exactly the condition the dispatcher branches on (§3.2). */
export function sandboxGidFromHost(
  origin: SandboxOrigin | null,
  hostHeader: string | null,
): string | null {
  if (origin === null || hostHeader === null) return null;
  const m = origin.hostRe.exec(hostnameOf(hostHeader).toLowerCase());
  return m ? m[1]! : null;
}

// --- mint / revoke -------------------------------------------------------

export type MintResult =
  | { ok: true; grant: SandboxGrant; url: string }
  | { ok: false; code: ErrorCode; msg: string };

/**
 * Issue (or renew) a grant for one file (§4.1). The file is resolved through
 * `fsResolveForServe` first, so a path the caller could not read never becomes
 * a grant at all — the failure is the ordinary `path_forbidden` / `not_found`
 * the fs ops already return.
 *
 * The scope is the file's parent directory for `contained` / `workspace`
 * (§4.1.1: an HTML page's relative CSS/JS must resolve), and the file itself
 * for `external`, whose authorization is an exact-match allowlist that a
 * subtree claim could not widen anyway.
 *
 * A second mint for the same `(sid, kind, scopePath)` reuses the existing gid
 * AND token and only pushes `exp` out (§4.1.2), so a preview tab that is still
 * open keeps working and the browser cache stays warm.
 */
export async function mintSandboxGrant(
  grants: SandboxGrants,
  origin: SandboxOrigin | null,
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  sid: string,
  reqPath: string,
  kind: "contained" | "external" | "workspace",
): Promise<MintResult> {
  if (origin === null) {
    return {
      ok: false,
      code: ErrorCode.sandbox_not_configured,
      msg: "sandbox_origin_template is not configured",
    };
  }
  const resolved = await fsResolveForServe(sessions, statusStore, sid, reqPath, kind);
  if (!resolved.ok) return resolved;
  const { realPath } = resolved.data;

  const fileName = path.basename(realPath);
  let scopePath: string;
  let scopeRealPath: string;
  if (kind === "external") {
    scopePath = reqPath;
    scopeRealPath = realPath;
  } else {
    const dir = path.dirname(reqPath);
    // dirname("foo.html") is "." — the containment root itself, which the
    // relative-path contract spells as the empty string.
    scopePath = kind === "contained" && (dir === "." || dir === "") ? "" : dir;
    scopeRealPath = path.dirname(realPath);
  }

  prune(grants);
  const key = scopeKey(sid, kind, scopePath);
  const now = grants.now();
  const exp = now + SANDBOX_GRANT_TTL_MS;
  const existingGid = grants.byScope.get(key);
  const existing = existingGid ? grants.byGid.get(existingGid) : undefined;
  const grant: SandboxGrant = existing
    ? { ...existing, scopeRealPath, fileName, exp }
    : {
        gid: randomBase32(GID_LENGTH),
        token: randomBase32(TOKEN_LENGTH),
        sid,
        kind,
        scopePath,
        scopeRealPath,
        fileName,
        exp,
      };
  grants.byGid.set(grant.gid, grant);
  grants.byScope.set(key, grant.gid);

  return { ok: true, grant, url: sandboxUrl(origin, grant, fileName) };
}

/** Build the URL for one file inside a grant's scope. Each path segment is
 * percent-encoded so a filename containing `#`, `?` or a space still names the
 * file the serve side re-decodes. */
export function sandboxUrl(origin: SandboxOrigin, grant: SandboxGrant, relPath: string): string {
  const base = origin.template.replace("{gid}", grant.gid);
  const encoded = relPath
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
  return `${base}/${grant.token}/${encoded}`;
}

/** Explicit failure (§4.3): the webui fires this when a preview tab closes.
 * Returns whether a grant was actually dropped; the caller treats either
 * outcome as success, since exp is the backstop when this never arrives. */
export function revokeSandboxGrant(grants: SandboxGrants, gid: string): boolean {
  const grant = grants.byGid.get(gid);
  if (!grant) return false;
  grants.byGid.delete(gid);
  grants.byScope.delete(scopeKey(grant.sid, grant.kind, grant.scopePath));
  return true;
}

// --- serve ---------------------------------------------------------------

/** Fixed-length secrets, so a length mismatch reveals nothing worth having;
 * equal-length candidates are compared without an early exit. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Split `/<token>/<relpath...>` into its two halves. Rejects any segment that
 * could re-enter the path resolver as something other than one plain name:
 * `..` and `.` never reach `fsResolveForServe`, and a segment that decodes to
 * contain a separator or a NUL is refused rather than re-split. */
function parseSandboxPath(pathname: string): { token: string; relPath: string } | null {
  const raw = pathname.split("/").filter((s) => s !== "");
  if (raw.length < 1) return null;
  const decoded: string[] = [];
  for (const seg of raw) {
    let value: string;
    try {
      value = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (value === "" || value === "." || value === "..") return null;
    if (value.includes("/") || value.includes("\\") || value.includes("\0")) return null;
    decoded.push(value);
  }
  const token = decoded[0]!;
  return { token, relPath: decoded.slice(1).join("/") };
}

export interface SandboxServeDeps {
  grants: SandboxGrants;
  origin: SandboxOrigin | null;
  sessions: SessionLookup;
  statusStore: SessionStatusStore;
  /** Origins allowed to frame a preview, for the CSP `frame-ancestors` in
   * §6.1. Read per request (rather than captured) because the daemon's allowed
   * origin set grows at runtime — tailscale auto-allow and `ccmsg origins add`
   * both mutate it after startup. */
  frameAncestors: () => Promise<string[]>;
}

/** Headers canddy also sets for the whole sandbox site. Repeated here so a
 * direct hit on 127.0.0.1:8642 (tests, or a canddy-less host) behaves the same
 * as one through the proxy (§6.2). */
const COMMON_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function previewCsp(frameAncestors: string[]): string {
  const ancestors = frameAncestors.length > 0 ? frameAncestors.join(" ") : "'none'";
  // `connect-src 'self'` is the load-bearing directive: without it a preview's
  // JS could fetch across the whole tailnet (§6.1).
  return [
    "sandbox allow-scripts allow-same-origin",
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${ancestors}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** RFC 6266 disposition carrying both an ASCII-safe fallback and the real
 * UTF-8 name. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function status4(code: ErrorCode): number {
  if (code === ErrorCode.path_forbidden) return 403;
  if (code === ErrorCode.not_found || code === ErrorCode.session_not_found) return 404;
  return 400;
}

/**
 * The whole sandbox surface: one GET, four checks, two response modes.
 *
 * 1. gid (from `Host`) must name a live grant                → 404
 * 2. the leading path segment must be that grant's token     → 404
 * 3. the grant must not have expired                         → 410
 * 4. the relpath, rebased on the scope root, must survive a
 *    fresh `fsResolveForServe` AND still land inside the
 *    scope                                                   → 403 / 404
 *
 * 404 rather than 403 for a token mismatch is deliberate (§4.2): the two
 * failures are indistinguishable, so probing gids reveals nothing about which
 * ones exist. No route other than this one exists on a sandbox host — an
 * unknown shape is 404, never a fallthrough to the webui (§3.2).
 */
export async function handleSandboxRequest(
  deps: SandboxServeDeps,
  gid: string,
  req: Request,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: COMMON_HEADERS });
  }
  const url = new URL(req.url);

  const grant = deps.grants.byGid.get(gid);
  if (!grant) return new Response("not found", { status: 404, headers: COMMON_HEADERS });

  const parsed = parseSandboxPath(url.pathname);
  if (!parsed || !tokensMatch(parsed.token, grant.token)) {
    return new Response("not found", { status: 404, headers: COMMON_HEADERS });
  }

  if (grant.exp <= deps.grants.now()) {
    revokeSandboxGrant(deps.grants, gid);
    return new Response("gone", { status: 410, headers: COMMON_HEADERS });
  }

  // Rebase onto the scope root in the spelling this kind's resolver expects.
  // `external` is bound to its single file: the only legal relpath is that
  // file's own name, and the request path is the allowlisted absolute path
  // rather than anything assembled from client input.
  let servePath: string;
  if (grant.kind === "external") {
    if (parsed.relPath !== grant.fileName) {
      return new Response("not found", { status: 404, headers: COMMON_HEADERS });
    }
    servePath = grant.scopePath;
  } else if (parsed.relPath === "") {
    return new Response("not found", { status: 404, headers: COMMON_HEADERS });
  } else {
    servePath = grant.scopePath === "" ? parsed.relPath : `${grant.scopePath}/${parsed.relPath}`;
  }

  const resolved = await fsResolveForServe(
    deps.sessions,
    deps.statusStore,
    grant.sid,
    servePath,
    grant.kind,
  );
  if (!resolved.ok) {
    return new Response(resolved.msg, {
      status: status4(resolved.code),
      headers: COMMON_HEADERS,
    });
  }
  const { realPath, size } = resolved.data;

  // Closing belt (see SandboxGrant.scopeRealPath): fsResolveForServe answers
  // for the session's whole containment root, which is wider than this grant.
  const scopePrefix = grant.scopeRealPath.endsWith(path.sep)
    ? grant.scopeRealPath
    : grant.scopeRealPath + path.sep;
  const inScope =
    grant.kind === "external" ? realPath === grant.scopeRealPath : realPath.startsWith(scopePrefix);
  if (!inScope) {
    return new Response("path escapes grant scope", { status: 403, headers: COMMON_HEADERS });
  }

  const fileName = path.basename(realPath);
  const download = url.searchParams.get("dl") === "1";
  const headers: Record<string, string> = {
    ...COMMON_HEADERS,
    "content-length": String(size),
    // Never cached by a shared cache: the URL is the capability, and it dies
    // in 30 minutes.
    "cache-control": "private, no-store",
  };
  if (download) {
    // §6.2: nothing is rendered, so `sandbox` without allow-scripts. A CSP
    // sandbox blocks downloads, which is exactly why the two modes are split
    // instead of merged into one set of headers.
    headers["content-type"] = "application/octet-stream";
    headers["content-disposition"] = contentDisposition(fileName);
    headers["content-security-policy"] = "sandbox";
  } else {
    headers["content-type"] = mimeForExtension(path.extname(fileName));
    headers["content-disposition"] = "inline";
    headers["content-security-policy"] = previewCsp(await deps.frameAncestors());
  }

  if (req.method === "HEAD") return new Response(null, { headers });
  // DR-0029 / §4.5: stream rather than read the file into daemon memory — the
  // sizes this endpoint exists for (large binaries, long transcript dumps) are
  // exactly the ones that would stall the shared event loop.
  const bunFile = (globalThis as { Bun?: { file: (p: string) => Blob } }).Bun?.file;
  const body = bunFile ? bunFile(realPath) : fs.readFileSync(realPath);
  return new Response(body, { headers });
}
