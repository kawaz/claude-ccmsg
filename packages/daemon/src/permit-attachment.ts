// The files a request for permission names (DR-0040 §3), read when the
// person opens one in the request's bubble: the start of a regular file, as
// text, or why it cannot be shown. The settings file a request's project
// permissions go into is read the same way (DR-0040 §12).
import { open } from "node:fs/promises";
import {
  PERMIT_ATTACHMENT_MAX_BYTES,
  type PermitAttachment,
  type PermitAttachmentUnreadable,
} from "@ccmsg/protocol";

/** Why an attachment that failed to open or read cannot be shown, by its
 * errno. */
function unreadableOf(error: unknown): PermitAttachmentUnreadable {
  switch (error instanceof Error && "code" in error ? error.code : undefined) {
    case "ENOENT":
    case "ENOTDIR":
      return "missing";
    case "EACCES":
    case "EPERM":
      return "denied";
    case "EISDIR":
      return "not_a_file";
    default:
      return "failed";
  }
}

/** The first `limit` bytes of `bytes` as UTF-8 text, or null when they are
 * not text: a NUL, or a sequence UTF-8 does not have. A character the limit
 * cuts in two is left out rather than taken for a broken one (the decoder's
 * `stream`, which holds back an incomplete sequence at the end). */
function textOf(bytes: Uint8Array, cut: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
  } catch {
    return null;
  }
}

/** Read one attachment as the person is to see it now: the first
 * PERMIT_ATTACHMENT_MAX_BYTES of a regular file at `path`, or why not. The
 * path is opened as given (a symlink is followed); the caller reads only the
 * paths the asking session named (DR-0040 §3). Never rejects. */
export async function readPermitAttachment(path: string): Promise<PermitAttachment> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return { path, read: false, reason: unreadableOf(error) };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { path, read: false, reason: "not_a_file" };
    const buffer = new Uint8Array(Math.min(stat.size, PERMIT_ATTACHMENT_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = stat.size > bytesRead;
    const content = textOf(buffer.subarray(0, bytesRead), truncated);
    if (content === null) return { path, read: false, reason: "not_text" };
    return { path, read: true, content, bytes: stat.size, truncated };
  } catch (error) {
    return { path, read: false, reason: unreadableOf(error) };
  } finally {
    await handle.close();
  }
}
