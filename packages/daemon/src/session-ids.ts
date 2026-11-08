// The tool_use ids the person's state holds (the says read, the requests for
// permission read and granted: say-unread.ts, permit-state.ts), each under
// the session whose transcript has the call, so that the state of a session
// can be dropped with it (pruneNotificationState).
import * as v from "valibot";

/** How a SessionIds is written: the ids of each session. */
export const SessionIdsFileSchema = v.record(v.string(), v.array(v.string()));

export class SessionIds {
  /** id → the session that has it. */
  private readonly sids = new Map<string, string>();

  constructor(bySession: Readonly<Record<string, readonly string[]>> = {}) {
    for (const [sid, ids] of Object.entries(bySession))
      for (const id of ids) this.sids.set(id, sid);
  }

  has(id: string): boolean {
    return this.sids.has(id);
  }

  /** Hold `id` as session `sid`'s (one held already keeps its session). */
  add(id: string, sid: string): void {
    if (!this.sids.has(id)) this.sids.set(id, sid);
  }

  ids(): string[] {
    return [...this.sids.keys()];
  }

  /** The sessions some id is held under. */
  sessions(): Set<string> {
    return new Set(this.sids.values());
  }

  /** Drop the ids of the sessions `gone` names; true when any went. */
  dropSessions(gone: ReadonlySet<string>): boolean {
    let dropped = false;
    for (const [id, sid] of this.sids) {
      if (gone.has(sid)) {
        this.sids.delete(id);
        dropped = true;
      }
    }
    return dropped;
  }

  /** The ids of each session, for the file. */
  bySession(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, sid] of this.sids) (out[sid] ??= []).push(id);
    return out;
  }
}
