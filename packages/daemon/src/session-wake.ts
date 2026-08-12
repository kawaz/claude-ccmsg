// Which stopped sessions to wake when the host comes back online, and what to
// send them.
//
// The wake is deliberately the smallest thing that works: one line on the
// session's existing `subscribe` stream, which its Monitor surfaces and which
// re-prompts the session — the mechanical equivalent of typing one character
// into the stalled window. No room, no stored message, no reply expected.
//
// Everything here is a pure fold over the api-error list session-errors.ts
// already maintains, so the delivery side (server.ts) stays a loop over
// subscribers and the "who and how often" rules stay testable on their own.
import type { NetworkOnlineStreamEvent, SessionErrorEntry } from "@ccmsg/protocol";

export const WAKE_TEXT =
  "Network is back online. Your last turn stopped on an API error — retry it.";

export interface SessionWakeState {
  /** sid → the error a wake was already sent for. Keyed by error identity, not
   * by sid alone, so a session that stalls again on a *later* error is woken
   * again while a still-unchanged stall is never re-notified. */
  notified: Map<string, string>;
}

export function createSessionWakeState(): SessionWakeState {
  return { notified: new Map() };
}

function errorKey(entry: SessionErrorEntry): string {
  return `${entry.timestamp}\u0000${entry.text}`;
}

export interface SessionWake {
  sid: string;
  /** Identity of the stall this wake answers, as `recordWoken` stores it. */
  key: string;
  event: NetworkOnlineStreamEvent;
}

/**
 * The wakes one online transition should produce, given the sessions currently
 * stopped on an API error: every stall not already woken. Recording is the
 * caller's job (`recordWoken`) so that a wake nobody could receive — a stalled
 * session with no live subscribe — is not counted as done and can still be
 * woken by a later recovery.
 *
 * Sessions that recovered (or disconnected) since the last call are forgotten
 * here, which is what allows a *new* stall on the same sid to be woken later.
 */
export function wakesForOnline(
  state: SessionWakeState,
  errors: readonly SessionErrorEntry[],
): SessionWake[] {
  const live = new Set(errors.map((e) => e.sid));
  // Deleting the key the iterator is on is well-defined for Map.
  for (const sid of state.notified.keys()) {
    if (!live.has(sid)) state.notified.delete(sid);
  }
  const wakes: SessionWake[] = [];
  for (const entry of errors) {
    if (state.notified.get(entry.sid) === errorKey(entry)) continue;
    wakes.push({
      sid: entry.sid,
      key: errorKey(entry),
      event: { ev: "net_online", text: WAKE_TEXT, error_ts: entry.timestamp },
    });
  }
  return wakes;
}

/** Mark a wake as delivered, so the same stall is not poked again. */
export function recordWoken(state: SessionWakeState, wake: SessionWake): void {
  state.notified.set(wake.sid, wake.key);
}
