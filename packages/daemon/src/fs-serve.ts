// HTTP serve for viewer-accessible files (image display in FileViewer).
//
// GET /fs-serve?sid=<sid>&path=<path>&kind=<contained|external|workspace>
//
// Reuses the same three authorization ops fs_read / fs_read_external /
// fs_read_workspace apply (via fsResolveForServe in fs-access.ts). The trust
// boundary is identical: source-IP + Origin have already gated the request
// in http.ts, and the session's containment root / external allowlist /
// workspace_folders decide whether the caller is allowed to read the target.
//
// The response is a small image-only allowlist by extension. Serving arbitrary
// MIME types over this same-origin endpoint would enable content-sniffing /
// script-execution vectors the FileViewer image case does not need — text
// files are already displayed via the WS fs_read path with syntax highlighting
// and search, and non-image binaries stay as the existing "バイナリファイル"
// notice. Extending the allowlist is an intentional decision (e.g. video / pdf
// preview) rather than an accidental widening.
import * as fs from "node:fs";
import { fsResolveForServe } from "./fs-access.ts";
import type { SessionStatusStore } from "./session-status.ts";
import type { SessionLookup } from "./fs-access.ts";

/** Extension → served MIME type. Image-only by design (see file header). */
const SERVE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

export function serveMimeForPath(p: string): string | null {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = p.slice(dot).toLowerCase();
  return SERVE_MIME_BY_EXT[ext] ?? null;
}

export function handleFsServe(
  sessions: SessionLookup,
  statusStore: SessionStatusStore,
  url: URL,
): Response {
  const sid = url.searchParams.get("sid");
  const reqPath = url.searchParams.get("path");
  const kindRaw = url.searchParams.get("kind");
  if (!sid || !reqPath || !kindRaw) {
    return new Response("missing sid/path/kind", { status: 400 });
  }
  if (kindRaw !== "contained" && kindRaw !== "external" && kindRaw !== "workspace") {
    return new Response("invalid kind", { status: 400 });
  }
  const mime = serveMimeForPath(reqPath);
  if (!mime) {
    // Only image extensions are served — non-image binaries stay as the
    // existing FileViewer "バイナリファイル" notice, text files use fs_read.
    return new Response("unsupported media type", { status: 415 });
  }
  const result = fsResolveForServe(sessions, statusStore, sid, reqPath, kindRaw);
  if (!result.ok) {
    const status =
      result.code === "not_found"
        ? 404
        : result.code === "path_forbidden"
          ? 403
          : result.code === "session_not_found"
            ? 404
            : 400;
    return new Response(result.msg, { status });
  }
  const { realPath, size } = result.data;
  // Belt: match /attachment/'s inline-only serve — this endpoint hands raw
  // bytes to the browser, an inline disposition keeps <img src=...> working
  // without prompting a download.
  const bunFile = (globalThis as { Bun?: { file: (p: string) => Blob } }).Bun?.file;
  const body = bunFile ? bunFile(realPath) : fs.readFileSync(realPath);
  const headers: Record<string, string> = {
    "content-type": mime,
    "content-disposition": "inline",
    "content-length": String(size),
    // Same-origin resource; a strict CSP-ish default keeps SVG rendered via
    // <img src> XSS-safe (SVG scripts do not execute in <img> context) and
    // blocks the raw URL from being framed cross-origin.
    "x-content-type-options": "nosniff",
  };
  return new Response(body, { headers });
}
