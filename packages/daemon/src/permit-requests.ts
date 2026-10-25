// Requests for the person's permission (DR-0040): what an agent the auto mode
// classifier stopped asked for, with the files it named as the daemon read
// them then. Held in memory only and pushed to the webui as
// `ev:"permit_requests"` / `ev:"permit_request"` (stream-event.ts).
import { open } from "node:fs/promises";
import {
  PERMIT_ATTACHMENT_MAX_BYTES,
  type PermitAttachment,
  type PermitAttachmentUnreadable,
  type PermitInput,
  type PermitRequestRecord,
} from "@ccmsg/protocol";

/** How many requests the daemon keeps. The oldest goes first once a new one
 * would exceed this.
 *
 * Design rationale: smaller than the say log's bound because a request holds
 * its attachments (up to PERMIT_ATTACHMENTS_MAX files of
 * PERMIT_ATTACHMENT_MAX_BYTES), and a request matters while its agent waits
 * for the permission, which is far shorter than the daemon lives. */
export const PERMIT_REQUEST_LOG_LIMIT = 50;

export interface PermitRequestLog {
  /** Record one request and return it. */
  add(record: Omit<PermitRequestRecord, "id">): PermitRequestRecord;
  /** Every request held, oldest first. */
  snapshot(): readonly PermitRequestRecord[];
}

export function createPermitRequestLog(
  issueId: () => string,
  limit: number = PERMIT_REQUEST_LOG_LIMIT,
): PermitRequestLog {
  let records: readonly PermitRequestRecord[] = [];
  return {
    add(fields) {
      const record: PermitRequestRecord = { id: issueId(), ...fields };
      records = [...records, record].slice(-limit);
      return record;
    },
    snapshot() {
      return records;
    },
  };
}

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

/** Read one attachment as the person is to see it: the first
 * PERMIT_ATTACHMENT_MAX_BYTES of a regular file at `path`, or why not. The
 * path is opened as given (a symlink is followed); the daemon reads only the
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

/** A request as the daemon records it for session `sid`: its attachments
 * read, in the order named, and the fields an absent list leaves out as
 * empty lists. */
export async function permitRequestFields(
  sid: string,
  permit: PermitInput,
  ts: string,
): Promise<Omit<PermitRequestRecord, "id">> {
  const attachments = await Promise.all((permit.attachments ?? []).map(readPermitAttachment));
  return {
    sid,
    ts,
    blocked: permit.blocked,
    attachments,
    intents: permit.intents ?? [],
    commands: permit.commands ?? [],
  };
}
