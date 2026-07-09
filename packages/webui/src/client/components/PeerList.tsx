import type { PeerInfo } from "@ccmsg/protocol";

export function PeerList({ peers }: { peers: PeerInfo[] }) {
  return (
    <ul id="peer-list">
      {peers.map((peer) => (
        <li key={peer.sid} title={peer.cwd}>
          {peer.sid.slice(0, 8)} · {peer.repo || "?"} · {peer.ws || "?"}
        </li>
      ))}
    </ul>
  );
}
