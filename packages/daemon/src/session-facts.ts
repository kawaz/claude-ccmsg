// What each session's hooks module knows of its session through Claude Code
// itself (session_facts, DR-0035 §3), as the daemon holds it: the module's
// latest facts per session, kept until the session is forgotten. The module
// sends the whole of them each time, so the held facts are replaced, never
// merged. What they mean for a session's status is session-status.ts's.
import type { SessionFacts } from "@ccmsg/protocol";

export class SessionFactsStore {
  readonly #bySid = new Map<string, SessionFacts>();

  /** Take `facts` for `sid` unless they are older than the ones held: a send
   * and the reply to the daemon's own `session.facts` request can cross, and
   * the later-composed facts are the module's latest. True when taken. */
  take(sid: string, facts: SessionFacts): boolean {
    const held = this.#bySid.get(sid);
    if (held !== undefined && held.at > facts.at) return false;
    this.#bySid.set(sid, facts);
    return true;
  }

  get(sid: string): SessionFacts | undefined {
    return this.#bySid.get(sid);
  }

  /** Drop `sid`'s facts (the session ended). True when there were any. */
  forget(sid: string): boolean {
    return this.#bySid.delete(sid);
  }
}
