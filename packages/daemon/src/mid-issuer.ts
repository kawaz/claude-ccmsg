// The ids this daemon gives what it sends into a session's peer socket and
// what it records of a `ccmsg say`.
import { randomBytes } from "node:crypto";

/** Issues ids `<instance id>/<n>`, counting from 1.
 *
 * The instance id is drawn afresh for each daemon process and the counter
 * lives in memory, so a restarted daemon starts a new series rather than
 * reusing numbers of the old one.
 *
 * Design rationale: an id exists so one message can be told from another
 * (it is the harness's `msg_id`, and the refusal a recipient answers names
 * the message it refuses by it), which needs ids that never repeat, not ids
 * that name the same daemon across restarts.
 * Persisting the instance id would also mean persisting the counter (or
 * `<id>/1` would be issued twice), which is state this daemon would keep for
 * no other use; DR-0036 §3 adds no v1-only persistent state. */
export function createMidIssuer(
  instanceId: string = randomBytes(16).toString("hex"),
): () => string {
  let counter = 0;
  return () => `${instanceId}/${++counter}`;
}
