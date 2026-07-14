// Attachment upload/serve HTTP endpoints (DR-0015). Two routes only:
//   POST /attachment            — multipart file upload, saves to
//                                 TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>
//                                 and returns metadata for the webui Composer.
//   GET  /attachment/<uuid.ext> — serves the saved bytes with the extension's
//                                 MIME type and `Content-Disposition: inline`.
//
// Same-UID trust boundary (DR-0001 §5, DR-0015 §2.1): anyone who can reach
// these endpoints has already passed the source-IP + Origin gate in http.ts
// (either this daemon's own webui, or an explicitly-configured tailscale
// serve Origin). No additional auth is layered on here — the file paths
// themselves are readable by every process running as the same UID, which
// matches the semantics the webui advertises to the agents (Bash/Read on the
// path directly). TMPDIR cleanup is deferred to the OS (§2.1: "cleanup: OS の
// TMPDIR 削除ポリシーに任せる") — the daemon never scans or GCs the directory.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AttachmentUploadResponse, DEFAULT_ATTACHMENT_MAX_BYTES } from "@ccmsg/protocol";

/** Extension → MIME. Extension-based lookup only, per DR-0015 Open question §5
 * ("拡張子ベースで開始、実運用で false-positive が出たら sniff 追加"). Keys
 * include the leading `.`; unknown extensions fall back to
 * `application/octet-stream`. Image types drive the webui's inline `<img>`
 * rendering path (markdown-view.tsx), so keep this list in sync with the
 * frontend's image-extension set when adding new entries. */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** Extract the extension (including leading `.`) from an upload's filename.
 * Only ASCII alphanumeric characters are accepted in the extension: this is
 * the same character class the GET route re-validates against, so anything
 * outside it never reaches the filesystem in the first place. Unknown or
 * malformed extensions return "" — the file is still stored (as `<uuid>` with
 * no suffix) and served as `application/octet-stream`. Multi-part extensions
 * like `.tar.gz` collapse to just the last part (`.gz`) — matching how
 * downloads and MIME lookup treat them. */
export function extractExtension(filename: string): string {
  const base = path.basename(filename); // strip any embedded directory parts
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  const raw = base.slice(dot + 1);
  if (raw === "" || raw.length > 16) return "";
  if (!/^[a-zA-Z0-9]+$/.test(raw)) return "";
  return `.${raw.toLowerCase()}`;
}

/** Resolve the MIME type for a given extension (leading-dot form).
 * Falls back to `application/octet-stream` for anything not in the table. */
export function mimeForExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

/** UUID v4 (RFC 4122) validation for the GET route. Enforces both the format
 * AND the version/variant nibbles (`4` in the 15th char, `8/9/a/b` in the
 * 20th) so a caller can't smuggle "../evil" through a UUID-shaped path
 * segment: crypto.randomUUID's output is the only string this regex accepts. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidUuidV4(uuid: string): boolean {
  return UUID_V4_RE.test(uuid);
}

/** Directory holding all attachments for this daemon's UID.
 * `TMPDIR/claude-ccmsg-<uid>/attachment/` per DR-0015 §2.1. `process.geteuid`
 * is Linux/macOS only (undefined on Windows in Node/Bun); Windows falls back
 * to a `w` marker so the path is still valid — this daemon isn't supported on
 * Windows regardless. */
export function attachmentDir(): string {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : "w";
  return path.join(os.tmpdir(), `claude-ccmsg-${uid}`, "attachment");
}

/** Cap on upload size, from `CCMSG_ATTACHMENT_MAX_BYTES` (bytes) or the
 * default DEFAULT_ATTACHMENT_MAX_BYTES. Invalid values (non-integer, ≤ 0)
 * fall back to the default rather than becoming a hard error at startup —
 * misconfiguration should degrade to sane behavior, not brick the daemon. */
export function maxAttachmentBytes(): number {
  const raw = process.env.CCMSG_ATTACHMENT_MAX_BYTES;
  if (!raw) return DEFAULT_ATTACHMENT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_ATTACHMENT_MAX_BYTES;
  return n;
}

/**
 * Handle `POST /attachment` (DR-0015 §2.2). Consumes `multipart/form-data`
 * with a `file` field, saves the bytes to
 * `TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>`, and returns a JSON
 * `AttachmentUploadResponse` for the webui Composer to embed into the next
 * message body via `[FILE<N>:<name>](<path>)`.
 *
 * Failure modes:
 *   - non-multipart body / missing `file` field  → 400
 *   - upload size > cap                           → 413
 *   - internal write failure (disk full, EPERM)   → 500
 *
 * Size gating is defense-in-depth: `Content-Length` is checked before the
 * body is fully read (short-circuits huge uploads that would otherwise buffer
 * in memory during `formData()`), and the resulting `File`'s `.size` is
 * checked again after parsing — a client that lies about Content-Length
 * (chunked upload, custom fetch, ...) can't sneak past the pre-check.
 */
export async function handleAttachmentUpload(req: Request): Promise<Response> {
  const maxBytes = maxAttachmentBytes();

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) {
      return new Response(`payload too large (max ${maxBytes} bytes)`, { status: 413 });
    }
  }

  let entry: unknown;
  try {
    const form = await req.formData();
    entry = (form as unknown as { get(name: string): unknown }).get("file");
  } catch (err) {
    return new Response(`invalid multipart body: ${String(err)}`, { status: 400 });
  }
  if (!(entry instanceof File)) {
    return new Response("missing 'file' field in multipart body", { status: 400 });
  }
  if (entry.size > maxBytes) {
    return new Response(`payload too large (max ${maxBytes} bytes)`, { status: 413 });
  }

  const originalName = entry.name || "upload";
  const ext = extractExtension(originalName);
  const headerMime = entry.type && entry.type !== "" ? entry.type : null;
  const mime = headerMime ?? mimeForExtension(ext);

  const dir = attachmentDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return new Response(`attachment dir create failed: ${String(err)}`, { status: 500 });
  }

  const uuid = crypto.randomUUID();
  const savePath = path.join(dir, ext ? `${uuid}${ext}` : uuid);

  // Existence check (DR-0015 Open question §5): UUID v4 collision is
  // astronomically unlikely, but reject rather than overwrite so a bug that
  // reuses a UUID surfaces loudly instead of silently corrupting a prior
  // upload.
  if (fs.existsSync(savePath)) {
    return new Response(`attachment path collision on ${uuid}${ext}`, { status: 500 });
  }

  try {
    const buf = new Uint8Array(await entry.arrayBuffer());
    fs.writeFileSync(savePath, buf);
  } catch (err) {
    return new Response(`attachment write failed: ${String(err)}`, { status: 500 });
  }

  const body: AttachmentUploadResponse = {
    ok: true,
    uuid,
    ext,
    size: entry.size,
    mime,
    path: savePath,
    name: originalName,
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Handle `GET /attachment/<uuid>.<ext>` (DR-0015 §2.7). The uuid path segment
 * is validated against `UUID_V4_RE` and the extension against `[a-zA-Z0-9]+`,
 * so any traversal-shaped input (`..`, absolute paths, slashes, encoded
 * slashes) is rejected before the daemon touches the filesystem. Missing
 * files return 404 (the OS may have GC'd the TMPDIR entry — §2.1 explicitly
 * accepts that possibility).
 */
export async function handleAttachmentServe(pathnameTail: string): Promise<Response> {
  // pathnameTail is everything after "/attachment/" — one filesystem segment,
  // no slashes allowed. Any slash or backslash rejects the request outright,
  // so a percent-decoded traversal like "..%2F" can't split into components
  // this code interprets separately.
  if (pathnameTail === "" || pathnameTail.includes("/") || pathnameTail.includes("\\")) {
    return new Response("not found", { status: 404 });
  }

  // Split into <uuid>[.<ext>]. Bare uuid (no extension) is allowed because
  // extractExtension returns "" for extension-less uploads, which the save
  // path preserves — otherwise those files would be un-serveable.
  const dot = pathnameTail.indexOf(".");
  const uuid = dot < 0 ? pathnameTail : pathnameTail.slice(0, dot);
  const extRaw = dot < 0 ? "" : pathnameTail.slice(dot + 1);
  if (!isValidUuidV4(uuid)) {
    return new Response("not found", { status: 404 });
  }
  if (extRaw !== "" && !/^[a-zA-Z0-9]+$/.test(extRaw)) {
    return new Response("not found", { status: 404 });
  }
  const ext = extRaw === "" ? "" : `.${extRaw.toLowerCase()}`;

  const dir = attachmentDir();
  const filePath = path.join(dir, ext ? `${uuid}${ext}` : uuid);

  // Belt-and-suspenders: even after the character-class checks above, verify
  // the resolved path stays inside `dir`. `path.join` normalizes segments, so
  // if any traversal survived it would collapse the join and land outside —
  // fail closed if that ever happens.
  if (!filePath.startsWith(`${dir}${path.sep}`)) {
    return new Response("not found", { status: 404 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("not found", { status: 404 });
  }

  // Bun's Response accepts a Bun.file() body for zero-copy streaming; fall
  // back to a Buffer when running under plain Node (tests may exercise this
  // path via `bun test`, but the guard keeps the file usable elsewhere).
  const mime = mimeForExtension(ext);
  const bunFile = (globalThis as { Bun?: { file: (p: string) => Blob } }).Bun?.file;
  const body = bunFile ? bunFile(filePath) : fs.readFileSync(filePath);
  return new Response(body, {
    headers: {
      "content-type": mime,
      "content-disposition": "inline",
      "content-length": String(stat.size),
    },
  });
}
