// `ccmsg say` records (DR-0036 §3): which session made the speakers talk, and
// whether the person watching has acked it. Held in memory only and pushed to
// the webui as `ev:"says"` (stream-event.ts SayRecord).
import type { SayRecord } from "@ccmsg/protocol";

/** How many records the daemon keeps. The oldest goes first once a new say
 * would exceed this, read or not.
 *
 * Design rationale: the log lives as long as the daemon, which runs for days,
 * so it needs a bound; and every change pushes the whole set to each webui
 * tab, so the bound also caps that push. Far more says than any person
 * leaves unacked, so dropping the oldest does not lose the badges that
 * matter. */
export const SAY_LOG_LIMIT = 200;

/** What `markRead` did. `missing` lists the ids no record has (never
 * recorded, recorded by another daemon process, or dropped by the bound);
 * when any is missing nothing is marked. `unchanged` is every id already
 * read. */
export type MarkReadResult =
  | { kind: "read" }
  | { kind: "unchanged" }
  | { kind: "missing"; ids: readonly string[] };

export interface SayLog {
  /** Record one say and return it (unread). */
  add(sid: string, text: string, ts: string): SayRecord;
  /** Mark the records `ids` read, all of them or none. */
  markRead(ids: readonly string[]): MarkReadResult;
  /** Every record held, oldest first. */
  snapshot(): readonly SayRecord[];
}

export function createSayLog(issueId: () => string, limit: number = SAY_LOG_LIMIT): SayLog {
  let records: readonly SayRecord[] = [];
  return {
    add(sid, text, ts) {
      const record: SayRecord = { id: issueId(), sid, text, ts, read: false };
      records = [...records, record].slice(-limit);
      return record;
    },
    markRead(ids) {
      const held = new Set(records.map((r) => r.id));
      const missing = ids.filter((id) => !held.has(id));
      if (missing.length > 0) return { kind: "missing", ids: missing };
      const targets = new Set(ids);
      if (records.every((r) => !targets.has(r.id) || r.read)) return { kind: "unchanged" };
      records = records.map((r) => (targets.has(r.id) ? { ...r, read: true } : r));
      return { kind: "read" };
    },
    snapshot() {
      return records;
    },
  };
}
