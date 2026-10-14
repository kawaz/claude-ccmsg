// What the model reads as the result of the ccmsg tools (DR-0039 §3). A tool's
// result is plain text the model acts on next, so each says what happened and,
// where something did not go, what to do about it. Session fields are written
// in the spelling `send` takes back (`session_id`, `name`, `cwd`), so the
// model can copy them into the next call as they are.
import type { PeerListEntry, PeerSendReason, PeerSendResult } from "@ccmsg/protocol/peer-tools";

/** The advice for a send whose arrival cannot be told. */
export const UNCONFIRMED_ADVICE = "送り直すと二重に届くかもしれないので、まず相手の返事を待つ";

const NOT_DELIVERED: Record<PeerSendReason, string> = {
  self: "送り主自身なので送っていない",
  no_module:
    "ccmsg の hooks module が動いていないセッションなので送っていない。そのセッションには ccmsg で届けられない",
  session_changed:
    "その session_id はもう使われていない (/clear か /resume で別の id に移った)。peers で今の session_id を確かめて送り直す",
  ended: "そのセッションは終了している",
  no_peer_socket:
    "peer socket が見つからない。終了した直後か、peer messaging に対応しない Claude Code。peers でまだ居るか確かめる",
  no_status_socket:
    "受け手の受領拒否を聞く socket を送り手側で作れず、送っていない。少し置いて一度だけ送り直し、また同じなら送るのをやめる",
  unreachable: "peer socket に書き込めなかった。少し置いて一度だけ送り直すか、送るのをやめる",
  refused: "受け手が受け取りを拒否した。時間を置いて送り直すか、送るのをやめる",
};

function spelled(session: { sid: string; name?: string; cwd?: string }): string {
  return [
    `session_id: ${session.sid}`,
    ...(session.name !== undefined ? [`name: ${JSON.stringify(session.name)}`] : []),
    ...(session.cwd !== undefined ? [`cwd: ${JSON.stringify(session.cwd)}`] : []),
  ].join(", ");
}

/** A send's results, one line per session it matched, after a line that
 * counts them. */
export function sendResultText(results: readonly PeerSendResult[]): string {
  if (results.length === 0) {
    return "宛先に当たる生きているセッションが無いので、送っていない。peers で今いるセッションを確かめて送り直すか、送るのをやめる";
  }
  if (results.every((r) => r.outcome === "not_delivered" && r.reason === "self")) {
    return "宛先に当たったのは送り主自身だけなので、送っていない。相手の session_id・name・cwd を peers で確かめて送り直す";
  }
  const delivered = results.filter((r) => r.outcome === "delivered").length;
  const head =
    delivered === results.length
      ? `${String(results.length)} 件の宛先すべてに届いた。`
      : `${String(results.length)} 件の宛先のうち ${String(delivered)} 件に届いた。届いた宛先には送り直さない。`;
  const lines = results.map((r) => {
    switch (r.outcome) {
      case "delivered":
        return `- ${spelled(r)}: 届いた`;
      case "unconfirmed":
        return `- ${spelled(r)}: 届いたか確かめられなかった。${UNCONFIRMED_ADVICE}`;
      case "not_delivered":
        return `- ${spelled(r)}: 届かなかった。${NOT_DELIVERED[r.reason]}`;
    }
  });
  return [head, ...lines].join("\n");
}

/** The sessions a send could go to, one line each. */
export function peersText(peers: readonly PeerListEntry[]): string {
  const others = peers.filter((p) => !p.self);
  if (others.length === 0) return "送れる相手のセッションは無い。";
  const lines = others.map((p) => {
    const pids = p.pids.length > 1 ? `, pid: ${p.pids.join(" / ")}` : "";
    const module = p.module ? "" : " (ccmsg の hooks module が動いていないので送れない)";
    return `- ${spelled(p)}${pids}${module}`;
  });
  return [
    "送れる相手のセッション (send には session_id・name・cwd をこのまま書く):",
    ...lines,
  ].join("\n");
}
