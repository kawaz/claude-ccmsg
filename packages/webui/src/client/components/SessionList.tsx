import { useEffect, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import { sessionHref } from "../locator.ts";
import { formatDuration, sessionLabel } from "../utils.ts";

const TICK_MS = 10_000;

/** Re-renders every `TICK_MS` so idle-time text keeps advancing. Lives here
 * (not in Sidebar) so the tick never touches `peers`/sortKey and can't
 * trigger Sidebar's `sortPeers` memo — row text moves, row order doesn't,
 * until the next actual peers update (see Sidebar.tsx). */
function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

/** Sidebar "Sessions" section (DR-0008, developed from the original Peers
 * list): each connected session's cwd is the browsable root of the
 * SessionView file tree, so clicking navigates to `#s<sid>` instead of just
 * displaying read-only peer info. `peers` is expected pre-sorted by the
 * caller (Sidebar.tsx's sortPeers) — this component only renders rows and
 * their idle-time text, never reorders. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: PeerInfo[];
  currentSid: string | null;
}) {
  useTick(TICK_MS);
  return (
    <ul id="session-list">
      {peers.map((peer) => {
        const title = peer.connected_at
          ? `${peer.cwd}\nconnected: ${peer.connected_at}${
              peer.last_activity_at ? `\nlast activity: ${peer.last_activity_at}` : ""
            }`
          : peer.cwd;
        return (
          <li key={peer.sid} class={peer.sid === currentSid ? "active" : undefined} title={title}>
            <a href={sessionHref(peer.sid)}>{sessionLabel(peer)}</a>
            {peer.last_activity_at && (
              <span class="session-idle">
                {formatDuration(Date.now() - new Date(peer.last_activity_at).getTime())}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
