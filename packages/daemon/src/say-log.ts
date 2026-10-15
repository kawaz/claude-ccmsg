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

export interface SayLog {
  /** Record one say and return it (unread). */
  add(sid: string, text: string, ts: string): SayRecord;
  /** Mark the record `id` read. `"missing"` when no record has that id (never
   * recorded, recorded by another daemon process, or dropped by the bound);
   * `"unchanged"` when it was already read. */
  markRead(id: string): "read" | "unchanged" | "missing";
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
    markRead(id) {
      const target = records.find((r) => r.id === id);
      if (target === undefined) return "missing";
      if (target.read) return "unchanged";
      records = records.map((r) => (r.id === id ? { ...r, read: true } : r));
      return "read";
    },
    snapshot() {
      return records;
    },
  };
}
