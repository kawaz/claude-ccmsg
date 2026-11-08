// Requests for the person's permission (DR-0040): what an agent the auto mode
// classifier stopped asked for, with the paths of the files it named. Kept in
// `<stateDir>/permit-requests.json` across restarts (DR-0040 §4) and pushed to
// the webui as `ev:"permit_requests"` / `ev:"permit_request"`
// (stream-event.ts); a file is read when the person opens it
// (permit_attachment_read).
//
// Design rationale: the second state the daemon keeps on disk for the webui
// alone, after say-read.json (DR-0036 §3 keeps v1 from growing such state). A
// restart comes with every push of the daemon, and a request held in memory
// only went with it: its bubble, its 🔐 and its 許可する were lost while the
// session that asked was still waiting.
import * as fs from "node:fs";
import { open } from "node:fs/promises";
import * as path from "node:path";
import * as v from "valibot";
import {
  jsonText,
  PERMIT_ATTACHMENT_MAX_BYTES,
  parseWith,
  PermitRequestRecordSchema,
  type PermitAttachment,
  type PermitAttachmentUnreadable,
  type PermitInput,
  type PermitProjectPermission,
  type PermitProjectPermissionRecord,
  type PermitRequestRecord,
  projectPermissionRule,
} from "@ccmsg/protocol";

/** How many requests the daemon keeps of one session. The session's oldest
 * goes first once a new one would exceed this; other sessions' are not
 * touched.
 *
 * Design rationale: a request is kept as long as the transcript that asked
 * it, with no time limit, so the bound is what keeps the file and the
 * subscribe-time set from growing with a session that asks without end. Per
 * session, so that one such session does not push another's requests out. */
export const PERMIT_REQUESTS_PER_SESSION = 200;

/** permit-requests.json: every request held, oldest first. */
const PermitRequestsFileSchema = jsonText(
  v.object({ requests: v.array(PermitRequestRecordSchema) }),
);

/** Where a log keeps its requests across restarts, and where it says that
 * the file did not read or could not be written. */
export interface PermitRequestFile {
  file: string;
  log: { warn(msg: string): void };
}

/** What `markRead` did: the records it changed (none when every one was
 * read already), or the ids no record has, in which case nothing is marked
 * (never recorded, or dropped by the bound). */
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
  /** Settles once every change made so far is in the file (at once without
   * one). Never rejects: a write that fails is said in the log, and the
   * requests stay held in memory. */
  written(): Promise<void>;
}

/** `records` with no session holding more than `limit`: each session's
 * oldest go first. The order is kept. */
function bounded(
  records: readonly PermitRequestRecord[],
  limit: number,
): readonly PermitRequestRecord[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.sid, (counts.get(r.sid) ?? 0) + 1);
  const drop = new Map<string, number>();
  for (const [sid, count] of counts) if (count > limit) drop.set(sid, count - limit);
  if (drop.size === 0) return records;
  return records.filter((r) => {
    const left = drop.get(r.sid) ?? 0;
    if (left === 0) return true;
    drop.set(r.sid, left - 1);
    return false;
  });
}

/** The requests `persist` holds: none when the file is missing, or does not
 * read (said in the log). */
function loadPermitRequests(persist: PermitRequestFile): readonly PermitRequestRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(persist.file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      persist.log.warn(
        `permit-requests: ${persist.file}: ${e instanceof Error ? e.message : "unreadable"} — starting with none`,
      );
    }
    return [];
  }
  const read = parseWith(PermitRequestsFileSchema, text);
  if (!read.ok) {
    persist.log.warn(
      `permit-requests: ${persist.file}: ${read.failure.summary} — starting with none`,
    );
    return [];
  }
  return read.value.requests;
}

export function createPermitRequestLog(
  issueId: () => string,
  limit: number = PERMIT_REQUESTS_PER_SESSION,
  persist?: PermitRequestFile,
): PermitRequestLog {
  let records: readonly PermitRequestRecord[] =
    persist === undefined ? [] : bounded(loadPermitRequests(persist), limit);
  let written: Promise<void> = Promise.resolve();
  /** Write the file whole, after the writes before it: to a temporary file
   * beside it, then renamed over it, so a crash leaves the old file or the
   * new one. The text is taken now, so the last change is the last to land. */
  const save = (): void => {
    if (persist === undefined) return;
    const { file, log } = persist;
    const text = `${JSON.stringify({ requests: records })}\n`;
    const tmp = path.join(path.dirname(file), `.permit-requests.${String(process.pid)}.tmp`);
    written = written.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, text, { mode: 0o600 });
        await fs.promises.rename(tmp, file);
      } catch (e) {
        log.warn(`permit-requests: ${file}: ${e instanceof Error ? e.message : "not written"}`);
      }
    });
  };
  return {
    add(fields) {
      const record: PermitRequestRecord = { id: issueId(), ...fields, read: false };
      records = bounded([...records, record], limit);
      save();
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
      if (changed.length > 0) save();
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
      if (marked !== undefined) save();
      return marked;
    },
    snapshot() {
      return records;
    },
    written() {
      return written;
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
