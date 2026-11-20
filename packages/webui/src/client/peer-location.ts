// How the web UI names where a session works, from its peer row's
// `repository` and `vcs` (DR-0003 §3): the repository as an `owner/name`
// slug, and the label the session list shows for the workspace.
//
// Lives apart from utils.ts because store.ts and pinned-sessions.ts read it
// too, and utils.ts imports store.ts.
import type { PeerInfo } from "@ccmsg/protocol";

/** The `owner/name` of the session's forge repository, "" when the daemon
 * could not tell one. */
export function peerRepoSlug(peer: Pick<PeerInfo, "repository">): string {
  return peer.repository ? `${peer.repository.owner}/${peer.repository.name}` : "";
}

/** What the session list shows as the session's workspace: the jj workspace /
 * git linked worktree it is in, else the branch / bookmark checked out, so
 * that a plain checkout is still told apart by its branch. "" when neither is
 * known. */
export function peerWorkspaceLabel(peer: Pick<PeerInfo, "vcs">): string {
  return peer.vcs?.workspace ?? peer.vcs?.branch ?? "";
}
