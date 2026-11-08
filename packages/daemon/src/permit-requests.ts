// Requests for the person's permission (DR-0040): what an agent the auto mode
// classifier stopped asked for, with the paths of the files it named. Held in
// memory only and pushed to the webui as `ev:"permit_requests"` /
// `ev:"permit_request"` (stream-event.ts); a file is read when the person
// opens it (permit_attachment_read).
import { open } from "node:fs/promises";
import {
  PERMIT_ATTACHMENT_MAX_BYTES,
  type PermitAttachment,
  type PermitAttachmentUnreadable,
  type PermitInput,
  type PermitProjectPermission,
  type PermitProjectPermissionRecord,
  type PermitRequestRecord,
  projectPermissionRule,
} from "@ccmsg/protocol";

/** How many requests the daemon keeps. The oldest goes first once a new one
 * would exceed this.
 *
 * Design rationale: a request matters while its agent waits for the
 * permission, which is far shorter than the daemon lives, and the set is
 * what a tab is sent when it subscribes. */
export const PERMIT_REQUEST_LOG_LIMIT = 50;

/** What `markRead` did: the records it changed (none when every one was
 * read already), or the ids no record has, in which case nothing is marked
 * (never recorded, recorded by another daemon process, or dropped by the
 * bound). */
export type MarkPermitReadResult =
  | { kind: "read"; changed: readonly PermitRequestRecord[] }
  | { kind: "missing"; ids: readonly string[] };

export interface PermitRequestLog {
  /** Record one request and return it (unread). */
  add(record: Omit<PermitRequestRecord, "id" | "read">): PermitRequestRecord;
  /** The record `id`, or undefined when none is held. */
  find(id: string): PermitRequestRecord | undefined;
  /** Mark the records `ids` read, all of them or none. */
  markRead(ids: readonly string[]): MarkPermitReadResult;
  /** Mark the project permission `permission` of the record `id` applied at
   * `at`, and the record read (the person has acted on it, as with 許可する),
   * and return the record; undefined when no record `id` is held (it went out
   * by the bound while the file was written). */
  markApplied(
    id: string,
    permission: PermitProjectPermission,
    at: string,
  ): PermitRequestRecord | undefined;
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
      const record: PermitRequestRecord = { id: issueId(), ...fields, read: false };
      records = [...records, record].slice(-limit);
      return record;
    },
    find(id) {
      return records.find((r) => r.id === id);
    },
    markRead(ids) {
      const held = new Set(records.map((r) => r.id));
      const missing = ids.filter((id) => !held.has(id));
      if (missing.length > 0) return { kind: "missing", ids: missing };
      const targets = new Set(ids);
      const changed: PermitRequestRecord[] = [];
      records = records.map((r) => {
        if (!targets.has(r.id) || r.read) return r;
        const marked = { ...r, read: true };
        changed.push(marked);
        return marked;
      });
      return { kind: "read", changed };
    },
    markApplied(id, permission, at) {
      let marked: PermitRequestRecord | undefined;
      records = records.map((r) => {
        if (r.id !== id || r.project_settings === undefined) return r;
        const settings = r.project_settings;
        marked = {
          ...r,
          read: true,
          project_settings: {
            ...settings,
            permissions: settings.permissions.map((asked) =>
              sameChange(asked, permission) ? { ...asked, applied_at: at } : asked,
            ),
          },
        };
        return marked;
      });
      return marked;
    },
    snapshot() {
      return records;
    },
  };
}

/** Whether `asked` is the change `permission`: the same rule, added or
 * removed alike. */
function sameChange(
  asked: PermitProjectPermissionRecord,
  permission: PermitProjectPermission,
): boolean {
  return (
    "add" in asked === "add" in permission &&
    projectPermissionRule(asked) === projectPermissionRule(permission)
  );
}

/** Whether a request asked for the change `permission` among its project
 * permissions `asked` (the person applies only what the session asked). */
export function askedFor(
  asked: readonly PermitProjectPermissionRecord[],
  permission: PermitProjectPermission,
): boolean {
  return asked.some((held) => sameChange(held, permission));
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

/** A request as the daemon records it for session `sid`: the fields an
 * absent list leaves out as empty lists, and the project permissions (none
 * applied yet) with `settingsPath`, the file they go into, when it asked for
 * any. */
export function permitRequestFields(
  sid: string,
  permit: PermitInput,
  ts: string,
  settingsPath?: string,
): Omit<PermitRequestRecord, "id" | "read"> {
  const asked = permit.project_permissions ?? [];
  return {
    sid,
    ts,
    blocked: permit.blocked,
    attachments: permit.attachments ?? [],
    intents: permit.intents ?? [],
    commands: permit.commands ?? [],
    ...(permit.voice !== undefined ? { voice: permit.voice } : {}),
    ...(settingsPath !== undefined && asked.length > 0
      ? { project_settings: { path: settingsPath, permissions: [...asked] } }
      : {}),
  };
}
