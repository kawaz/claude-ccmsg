// The wire's replies to file requests (daemon -> client), as schemas
// (DR-0038): reading, listing, searching and writing a session's files, and
// the sandbox grants that open one in a browser. response.ts joins them with
// the other topics' replies, by the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** One resolved entry in `FsStatBatchResponse.results`. `path` is the shape
 * the client passes to `fileHref` / FileViewer — relative to the session's
 * containment root for `contained`, absolute (echoed as requested / normalized)
 * for `workspace` and `external`. Mirrors the read-op dispatch FileViewer
 * already uses (relative → fs_read, absolute → fs_read_workspace or
 * fs_read_external). */
export const FsStatEntrySchema = v.object({
  kind: v.picklist(["contained", "workspace", "external"]),
  path: v.string(),
});
export type FsStatEntry = Output<typeof FsStatEntrySchema>;

export const FsStatBatchResponseSchema = v.object({
  ok: v.literal(true),
  /** Parallel to `request.paths` — same length, same order. Slot values:
   *   - `FsStatEntry` when the daemon is willing to serve the target as a
   *     regular file under one of the three authorization surfaces;
   *   - `null` otherwise (client renders that token as plain inline code). */
  results: v.array(v.nullable(FsStatEntrySchema)),
});
export type FsStatBatchResponse = Output<typeof FsStatBatchResponseSchema>;

/** One fs_find hit. `path` is directly usable as a locator/FileViewer key:
 * root-relative for `kind:"contained"`, absolute for `kind:"workspace"` —
 * the same two path shapes the tree already stores. */
export const FsFindHitSchema = v.object({
  path: v.string(),
  type: v.picklist(["file", "dir", "symlink"]),
});
export type FsFindHit = Output<typeof FsFindHitSchema>;

export const FsFindResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  hits: v.array(FsFindHitSchema),
  /** The walk stopped early — either the result cap or the visited-entry
   * budget was reached, so `hits` is not the complete match set. The client
   * says so instead of implying "these are all the matches". */
  truncated: v.boolean(),
});
export type FsFindResponse = Output<typeof FsFindResponseSchema>;

/** One directory entry from fs_list. `type:"symlink"` is reported as-is for
 * links whose target stays inside the root (out-of-root links are listed but
 * refuse to resolve); sockets/FIFOs/devices collapse to "other". */
export const FsEntrySchema = v.object({
  name: v.string(),
  type: v.picklist(["file", "dir", "symlink", "other"]),
  /** bytes, files only */
  size: v.optional(v.number()),
  /** ISO 8601 mtime, best-effort */
  mtime: v.optional(v.string()),
});
export type FsEntry = Output<typeof FsEntrySchema>;

/** Reply to fs_list and fs_list_workspace. */
export const FsListResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** normalized directory path relative to the root ("" = root itself) */
  path: v.string(),
  entries: v.array(FsEntrySchema),
});
export type FsListResponse = Output<typeof FsListResponseSchema>;

/** Reply to fs_read, fs_read_external and fs_read_workspace. */
export const FsReadResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  path: v.string(),
  /** true byte size on disk (may exceed what `content` carries) */
  size: v.number(),
  /** content was cut at FS_READ_MAX_BYTES */
  truncated: v.boolean(),
  /** NUL byte seen in the first 8 KiB — content omitted for binaries */
  binary: v.boolean(),
  /** UTF-8 text content; "" when binary */
  content: v.string(),
  /** ISO 8601 mtime — used by fs_edit as an optimistic-lock token so a
   * concurrent external edit between read and write is detected as
   * `file_conflict` instead of silently clobbered. */
  mtime: v.string(),
});
export type FsReadResponse = Output<typeof FsReadResponseSchema>;

export const FsWriteResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** normalized path relative to the session root */
  path: v.string(),
});
export type FsWriteResponse = Output<typeof FsWriteResponseSchema>;

export const FsCreateResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** normalized path (relative for contained — always relative to the session
   * containment root, matching fs_list — absolute for workspace, matching the
   * FsListWorkspace echo). */
  path: v.string(),
});
export type FsCreateResponse = Output<typeof FsCreateResponseSchema>;

export const FsDeleteResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** echoed request path (relative for contained, absolute for workspace) */
  path: v.string(),
});
export type FsDeleteResponse = Output<typeof FsDeleteResponseSchema>;

export const FsEditResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** echoed request path (relative for contained, absolute for external/workspace) */
  path: v.string(),
  /** post-write size on disk */
  size: v.number(),
  /** post-write mtime — the client uses this as the new optimistic-lock token
   * so a subsequent edit in the same viewer session doesn't need a full refetch. */
  mtime: v.string(),
});
export type FsEditResponse = Output<typeof FsEditResponseSchema>;

export const SandboxGrantResponseSchema = v.object({
  ok: v.literal(true),
  /** Origin-separation key, non-secret: it rides in a DNS label and therefore
   * leaks to every recursive resolver on the way (DR-0030 §3.3). Pass it back
   * to `sandbox_revoke`. */
  gid: v.string(),
  /** The capability. Secret, and the only thing that authorizes a request —
   * echoed here because the client needs it to build sibling URLs (a download
   * link next to a preview link) without a second mint. */
  token: v.string(),
  /** Ready-to-open URL for the granted file, preview mode. Append `?dl=1` for
   * the download mode (DR-0030 §6.2). */
  url: v.string(),
  /** Epoch ms the grant expires at (30 minutes from this mint). */
  exp: v.number(),
});
export type SandboxGrantResponse = Output<typeof SandboxGrantResponseSchema>;

export const SandboxRevokeResponseSchema = v.object({
  ok: v.literal(true),
});
export type SandboxRevokeResponse = Output<typeof SandboxRevokeResponseSchema>;
