import type { PeerInfo } from "@ccmsg/protocol";
import { sessionHref } from "../locator.ts";
import { sessionLabel } from "../utils.ts";

/** Sidebar "Sessions" section (DR-0008, developed from the original Peers
 * list): each connected session's cwd is the browsable root of the
 * SessionView file tree, so clicking navigates to `#s<sid>` instead of just
 * displaying read-only peer info. */
export function SessionList({
  peers,
  currentSid,
}: {
  peers: PeerInfo[];
  currentSid: string | null;
}) {
  return (
    <ul id="session-list">
      {peers.map((peer) => (
        <li key={peer.sid} class={peer.sid === currentSid ? "active" : undefined} title={peer.cwd}>
          <a href={sessionHref(peer.sid)}>{sessionLabel(peer)}</a>
        </li>
      ))}
    </ul>
  );
}
