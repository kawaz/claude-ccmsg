// The wire's file requests (client -> daemon), as schemas (DR-0038): reading,
// listing, searching and writing a session's files, and the sandbox grants
// that open one in a browser. request.ts joins them into one request and
// reads a line with them.
//
// A path is only typed here. Whether it is relative or absolute, inside the
// session's root or on an allowlist, is the daemon's to decide per op, and
// each op answers a path it will not serve with its own error.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";

/**
 * Workspace file access (DR-0008 / DR-0021): read-only browsing from a
 * connected session or a daemon-resolved historical UUID. The client names a
 * session (`sid`), never a filesystem root, and `path` is always relative to
 * the derived containment root. The daemon resolves and containment-checks
 * every path (realpath prefix check, so symlinks cannot escape the root) before
 * touching the filesystem.
 */
export const FsListRequestSchema = v.object({
  op: v.literal("fs_list"),
  /** session whose project root (its cwd) to browse */
  sid: v.string(),
  /** directory path relative to the session root; "" / "." / absent = root */
  path: v.optional(v.string()),
});
export type FsListRequest = v.InferOutput<typeof FsListRequestSchema>;

export const FsReadRequestSchema = v.object({
  op: v.literal("fs_read"),
  sid: v.string(),
  /** file path relative to the session root */
  path: v.string(),
});
export type FsReadRequest = v.InferOutput<typeof FsReadRequestSchema>;

/** DR-0024 allowlist read for one transcript-observed file outside the
 * session containment root. Unlike fs_read, this path is absolute and grants
 * no directory/prefix access: it must exactly match external_files for sid. */
export const FsReadExternalRequestSchema = v.object({
  op: v.literal("fs_read_external"),
  sid: v.string(),
  /** absolute path — must exactly match the session's external_files allowlist */
  path: v.string(),
});
export type FsReadExternalRequest = v.InferOutput<typeof FsReadExternalRequestSchema>;

/**
 * DR-0026 workspace-folder allowlist list/read for `.code-workspace` folders
 * discovered under the session cwd. Unlike fs_list/fs_read (relative to the
 * containment root) and fs_read_external (single exact-file grant), these ops
 * take an absolute path and grant *directory-prefix* access: any realpath
 * inside one of the session's workspace_folders[].path is browseable. Both
 * ops are user-role only — the browsable folder set comes from the cwd's
 * workspace file, which is a first-class artifact the user themselves
 * maintains, but reading them is a viewer feature, not something the AI
 * session itself needs. Symlink escapes are rejected by realpath.
 */
export const FsListWorkspaceRequestSchema = v.object({
  op: v.literal("fs_list_workspace"),
  sid: v.string(),
  /** absolute directory path — must be a workspace_folders entry itself,
   * or a descendant of one (realpath-checked). */
  path: v.string(),
});
export type FsListWorkspaceRequest = v.InferOutput<typeof FsListWorkspaceRequestSchema>;

export const FsReadWorkspaceRequestSchema = v.object({
  op: v.literal("fs_read_workspace"),
  sid: v.string(),
  /** absolute file path — must be a descendant of some workspace_folders
   * entry (realpath-checked); a bare folder root refuses as "not a file". */
  path: v.string(),
});
export type FsReadWorkspaceRequest = v.InferOutput<typeof FsReadWorkspaceRequestSchema>;

/**
 * Inbox file creation (DR-0019 Phase W1): create one new UTF-8 text file under
 * docs/inbox/ in a connected session's cwd. The daemon applies the same
 * realpath containment boundary as fs_list/fs_read, rejects every other
 * cwd-relative directory, and never overwrites an existing path.
 */
export const FsWriteRequestSchema = v.object({
  op: v.literal("fs_write"),
  sid: v.string(),
  /** file path relative to the session cwd */
  path: v.string(),
  /** UTF-8 text content */
  content: v.string(),
});
export type FsWriteRequest = v.InferOutput<typeof FsWriteRequestSchema>;

/**
 * Create a new empty (or short-content) text file at `path` under the same
 * authorization surfaces fs_edit / fs_read use (kind ∈ {contained, workspace}
 * — external is not supported because that allowlist is per-file, not per-dir,
 * so there is no notion of a "directory to create in"). Unlike fs_write
 * (inbox-only) this op accepts any writable location inside the read
 * containment, making it the symmetric partner of fs_edit: fs_edit overwrites,
 * fs_create creates. Never overwrites — an existing path replies `file_exists`
 * (O_EXCL). Parent directory must already exist; the op does not mkdir. `kind`
 * mirrors fs_edit exactly so no new trust surface is introduced.
 */
export const FsCreateRequestSchema = v.object({
  op: v.literal("fs_create"),
  sid: v.string(),
  /** relative when kind="contained", absolute when kind="workspace" — mirrors
   * the corresponding read op's path contract exactly. */
  path: v.string(),
  kind: v.picklist(["contained", "workspace"]),
  /** UTF-8 text content, capped at FS_READ_MAX_BYTES. Empty string is fine
   * (the common case — the UI creates an empty file and lets the user edit). */
  content: v.string(),
});
export type FsCreateRequest = v.InferOutput<typeof FsCreateRequestSchema>;

/**
 * Delete an existing regular file under fs_edit's authorization surfaces
 * (kind ∈ {contained, workspace} — external is not supported: the transcript
 * allowlist is read-oriented; deleting a file the user only observed via
 * transcript is out of scope). Refuses directories, symlinks, and every
 * non-regular file — this op only ever unlinks real files the user could see
 * as a leaf in the tree. Never recursive.
 */
export const FsDeleteRequestSchema = v.object({
  op: v.literal("fs_delete"),
  sid: v.string(),
  /** relative when kind="contained", absolute when kind="workspace" — same
   * path contract as fs_edit/fs_read. */
  path: v.string(),
  kind: v.picklist(["contained", "workspace"]),
});
export type FsDeleteRequest = v.InferOutput<typeof FsDeleteRequestSchema>;

/**
 * Overwrite an existing text file in place (webui file viewer's edit action).
 * Unlike fs_write (inbox-only create) this op EXCLUSIVELY overwrites an
 * existing regular file — it does not create, delete, or rename. `kind` picks
 * the same three authorization surfaces the read ops use (fs_read /
 * fs_read_external / fs_read_workspace); the daemon reuses their containment /
 * allowlist checks so no new trust surface is introduced. `expected_mtime` and
 * `expected_size` come straight from the FsReadResponse the viewer used to
 * populate its textarea — if the file changed on disk between read and edit,
 * the write is refused with `file_conflict` rather than clobbering the newer
 * copy. Binary files (NUL byte in current on-disk head) are refused with
 * `not_a_text_file` so this op can never turn a binary into a UTF-8 blob.
 */
export const FsEditRequestSchema = v.object({
  op: v.literal("fs_edit"),
  sid: v.string(),
  /** relative when kind="contained", absolute when kind="external"/"workspace" —
   * mirrors the corresponding read op's path contract exactly. */
  path: v.string(),
  kind: v.picklist(["contained", "external", "workspace"]),
  /** UTF-8 text content, capped at FS_READ_MAX_BYTES (same cap fs_read enforces
   * on the read side so the viewer never edits a truncated view). */
  content: v.string(),
  /** Optimistic-lock: the mtime the viewer originally read; a mismatch means
   * something else touched the file between the read and this edit. */
  expected_mtime: v.string(),
  /** Optimistic-lock companion: guards against a mutation that happens to
   * preserve the mtime (mtime resolution differs by filesystem). */
  expected_size: v.number(),
});
export type FsEditRequest = v.InferOutput<typeof FsEditRequestSchema>;

/** One `fs_stat_batch` path: the path, or `null` for an entry that is not a
 * string. Such an entry is answered with `null` in its slot like any other
 * path the daemon will not serve, rather than refusing the whole batch. */
const StatPathSchema = v.fallback(v.nullable(v.string()), null);

/**
 * Batch file-existence probe for the message-body path linkifier.
 * Client extracts inline-code tokens shaped like
 * `filepath[:LINE[:COL]]` / `filepath[:L1-L2]` from an agent message, absolute-
 * resolves them against the sender's cwd / repo_root, and asks the daemon
 * which ones point at real regular files it is willing to serve. Only paths
 * that come back non-null are turned into FileViewer links; unknowns stay as
 * plain inline code.
 *
 * Each requested path is tried against the same three authorization surfaces
 * the read ops use — `fs_read` (contained containment root), `fs_read_workspace`
 * (DR-0026 workspace_folders directory-prefix allowlist), and `fs_read_external`
 * (DR-0024 exact-file transcript allowlist), in that order — and the first
 * surface that admits the path *and* whose target is a regular file wins.
 * Everything else (not found, forbidden, not-a-file/dir/symlink) collapses to
 * `null` so the daemon does not leak "does this exist?" information about
 * paths outside the caller's authorization: an allowlist miss and a genuine
 * ENOENT are indistinguishable from the response shape.
 *
 * User-role only (viewer feature), like the other absolute-path fs ops.
 */
export const FsStatBatchRequestSchema = v.object({
  op: v.literal("fs_stat_batch"),
  sid: v.string(),
  /** Absolute paths (client-side pre-resolved from cwd / repo_root). Any
   * non-string / empty / relative entry is answered with `null` in the
   * corresponding response slot rather than rejecting the whole batch —
   * one client-side rendering bug shouldn't blank every link on the screen. */
  paths: v.array(StatPathSchema),
});
export type FsStatBatchRequest = v.InferOutput<typeof FsStatBatchRequestSchema>;

/**
 * Recursive file-name search under one of the browsable roots (Files pane's
 * "Search files by name"). The lazy tree (fs_list per expanded directory)
 * cannot answer "where is the file whose path contains X" without the user
 * having already opened every candidate directory, so the walk happens on the
 * daemon where the whole subtree is reachable in one request.
 *
 * `kind` selects the authorization surface, exactly mirroring the list ops it
 * is built on: `contained` walks the fs_list containment root and returns
 * root-relative paths; `workspace` walks one DR-0026 workspace folder (or a
 * directory inside one) named by an absolute `root` and returns absolute
 * paths. There is no `external` variant — DR-0024's allowlist is per-file with
 * no directory to descend, so nothing could be enumerated.
 *
 * User-role only, like the other viewer-side fs ops: a session AI searches its
 * own filesystem through its own tool loop, never through the daemon.
 */
export const FsFindRequestSchema = v.object({
  op: v.literal("fs_find"),
  sid: v.string(),
  kind: v.picklist(["contained", "workspace"]),
  /** Directory to search under. Relative to the containment root for
   * `contained` ("" / absent = the root itself); absolute for `workspace`. */
  root: v.optional(v.string()),
  /** Whitespace-separated words ANDed against each candidate's path, with a
   * `-word` exclusion prefix — the grammar `parseFileSearchQuery` defines (see
   * file-search-query.ts for the full rules and their rationale). Matching is
   * case-insensitive. A query with nothing to include (empty, whitespace-only,
   * or exclusions alone) matches nothing rather than dumping the entire tree,
   * so a cleared input box costs no walk. */
  query: v.string(),
  /** Skip paths a `.gitignore` hides, and don't descend into ignored
   * directories. Absent = true.
   *
   * Filtering is the default because the unfiltered result is dominated by
   * vendored trees: searching this repo for "package.json" reaches ~100 hits
   * inside `node_modules` before the user's own, and with FS_FIND_RESULT_MAX
   * capping the reply those hits don't merely add noise — they push the real
   * answer out of it. A default that is usually wrong would be toggled on
   * every search, which is a worse trade than the occasional deliberate
   * "search build output too". */
  respect_gitignore: v.optional(v.boolean()),
});
export type FsFindRequest = v.InferOutput<typeof FsFindRequestSchema>;

/**
 * Mint a capability URL on the sandbox origin (DR-0030 §4.1). The webui calls
 * this when the user asks to open a file as HTML or download it raw; the reply
 * is a URL on a different eTLD+1 that serves the file with its real MIME type,
 * which the same-origin `/fs-serve` deliberately refuses to do.
 *
 * The grant does not widen anything. The daemon runs `fsResolveForServe` here
 * at mint time AND again on every request the URL produces, so this op can
 * only fail the way the corresponding read op would (`path_forbidden` /
 * `not_found`) and can never reach a file the caller could not already read.
 *
 * Scope is the file's parent directory for `contained` / `workspace` — an HTML
 * page's relative CSS/JS has to resolve — and the single file for `external`,
 * whose authorization is an exact-match allowlist (§4.1.1). Re-minting the
 * same scope returns the same `gid` and `token` with a later `exp` (§4.1.2),
 * so an already-open preview tab keeps working.
 *
 * User role only: this is a viewer feature, like the other absolute-path fs ops.
 */
export const SandboxGrantRequestSchema = v.object({
  op: v.literal("sandbox_grant"),
  sid: v.string(),
  /** relative when kind="contained", absolute when kind="external"/"workspace"
   * — the same path contract as the matching read op. */
  path: v.string(),
  kind: v.picklist(["contained", "external", "workspace"]),
});
export type SandboxGrantRequest = v.InferOutput<typeof SandboxGrantRequestSchema>;

/**
 * Drop a grant early (DR-0030 §4.3). The webui fires this when a preview tab
 * closes. Best-effort by design: `exp` is what actually bounds a grant's life,
 * so an unknown or already-expired gid is still `ok:true` — there is nothing
 * for the caller to do differently either way, and reporting "no such gid"
 * would turn revoke into an existence oracle.
 */
export const SandboxRevokeRequestSchema = v.object({
  op: v.literal("sandbox_revoke"),
  /** The `gid` a previous `sandbox_grant` returned. */
  gid: v.string(),
});
export type SandboxRevokeRequest = v.InferOutput<typeof SandboxRevokeRequestSchema>;
