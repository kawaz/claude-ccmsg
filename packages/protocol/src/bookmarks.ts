// The person's bookmarks of Timeline items (DR-0058), as schemas (DR-0038):
// the ops that set one and read the rows of a session's, their replies, and
// the push of every session's. A bookmark is the uuid of a transcript row,
// under the session whose transcript has the row. Only the webui reads them
// (user role), and the daemon serves the webui's bundle, so they move no
// protocol version (protocol-version.ts).
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** Bookmark the row `uuid` of session `sid`'s transcript (`on`), or take
 * the bookmark off. User role only: a bookmark is the person's mark. The
 * daemon writes the file before answering and pushes ev:"bookmarks" to every
 * tab. Setting what is already set changes nothing. */
export const BookmarkSetRequestSchema = v.object({
  op: v.literal("bookmark_set"),
  sid: v.pipe(v.string(), v.nonEmpty("Expected the session id")),
  uuid: v.pipe(v.string(), v.nonEmpty("Expected the row's uuid")),
  on: v.boolean(),
});
export type BookmarkSetRequest = Output<typeof BookmarkSetRequestSchema>;

export const BookmarkSetResponseSchema = v.object({
  ok: v.literal(true),
});
export type BookmarkSetResponse = Output<typeof BookmarkSetResponseSchema>;

/** The rows of session `sid`'s bookmarks, as its transcript has them (the
 * webui's ⭐ filter, for the ones outside the loaded window). User role only.
 * The daemon reads the session's own transcript for the bookmarks it has not
 * found before, and keeps what it found (a row of a transcript never
 * changes). */
export const BookmarkRowsRequestSchema = v.object({
  op: v.literal("bookmark_rows"),
  sid: v.pipe(v.string(), v.nonEmpty("Expected the session id")),
});
export type BookmarkRowsRequest = Output<typeof BookmarkRowsRequestSchema>;

/** One bookmarked row and the lines that complete it. */
export const BookmarkRowSchema = v.object({
  uuid: v.string(),
  /** The row's jsonl line first, then the lines a reader of it needs to draw
   * it: the line right after it (a `! <command>`'s output is the next row)
   * and the lines of the results of the tool calls it makes, in file order.
   * Only the first is the bookmarked row. */
  lines: v.pipe(v.array(v.string()), v.nonEmpty("Expected the row's line")),
});
export type BookmarkRow = Output<typeof BookmarkRowSchema>;

export const BookmarkRowsResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** In file order. A bookmark whose row the transcript does not have is
   * not here. */
  rows: v.array(BookmarkRowSchema),
});
export type BookmarkRowsResponse = Output<typeof BookmarkRowsResponseSchema>;

/** One session's bookmarks: the uuids of its rows, in the order they were
 * set. */
export const SessionBookmarksSchema = v.object({
  session_id: v.string(),
  uuids: v.array(v.string()),
});
export type SessionBookmarks = Output<typeof SessionBookmarksSchema>;

/** Every session's bookmarks (user-role subscribers only, like
 * ev:"say_unread"). Sent at subscribe time, even when empty, and again
 * whenever one is set or taken off: always the full set, so a tab replaces
 * what it held. A session with none is not listed. */
export const BookmarksStreamEventSchema = v.object({
  ev: v.literal("bookmarks"),
  sessions: v.array(SessionBookmarksSchema),
});
export type BookmarksStreamEvent = Output<typeof BookmarksStreamEventSchema>;
