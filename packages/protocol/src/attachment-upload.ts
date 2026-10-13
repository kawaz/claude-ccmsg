// The body `POST /attachment` answers with (DR-0015 §2.3), as a schema
// (DR-0038). The upload runs over multipart HTTP, not the wire protocol, so
// this is not one of the replies in response.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** DR-0015 §2.2 `POST /attachment` success body. `path` is the absolute file
 * path under `TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>` (same-UID
 * trust per DR-0001 §5 — the webui inlines it verbatim into the message body's
 * Markdown link so agents on the same UID can `Read`/`Bash` it directly). */
export const AttachmentUploadResponseSchema = v.object({
  ok: v.literal(true),
  uuid: v.string(),
  /** filename extension including the leading `.` (e.g. `.png`), or `""` when
   * the uploaded filename had no extension. */
  ext: v.string(),
  size: v.number(),
  /** MIME type, from `Content-Type` header if the client sent one, else
   * extension-based lookup (DR-0015 Open question §5: extension-based to
   * start, magic-byte sniff only if false positives show up in practice). */
  mime: v.string(),
  path: v.string(),
  /** original filename basename (display-only label for the Markdown link). */
  name: v.string(),
});
export type AttachmentUploadResponse = Output<typeof AttachmentUploadResponseSchema>;
