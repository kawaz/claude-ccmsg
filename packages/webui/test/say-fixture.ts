// What ev:"say_unread" carries beside its unread says (DR-0050 §3): how many
// says each session has, read or not. A test that hands the store unread says
// hands it the totals the daemon would send with them.
import type { SessionSayTotal } from "@ccmsg/protocol";

/** The totals of a daemon that holds exactly `says`, each a session's say
 * (an unread say, or a worker's say, read or not). */
export function sayTotalsOf(says: readonly { session_id: string }[]): SessionSayTotal[] {
  const totals = new Map<string, number>();
  for (const say of says) totals.set(say.session_id, (totals.get(say.session_id) ?? 0) + 1);
  return [...totals].map(([session_id, count]) => ({ session_id, count }));
}
