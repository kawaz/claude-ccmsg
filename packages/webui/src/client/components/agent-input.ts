// 走行中の subagent への人の入力 (DR-0039 §6) の、一覧の行の表示と送信結果の
// 文言に落とす pure な層。SubagentInput はこの結果だけを見る。JSX を通さず
// bun test から直接叩けるよう .ts に切り出している (session-input.ts と同じ流儀)。
import type {
  UserMessageReason,
  UserMessageResponse,
  ErrorResponse,
  SessionSubagent,
} from "@ccmsg/protocol";

/** 入力欄の近くに常に出す注記: 足されるのは文脈であって権限ではない。 */
export const AGENT_INPUT_NOTE =
  "subagent の会話に「ユーザから (ccmsg 経由)」として文脈を足すだけで、権限の付与や許可の代わりには使えない。";

/** 一覧の 1 行。種別と説明、今の turn がいつ始まったか (module が見ていない時は出さない)。 */
export function subagentLabel(agent: SessionSubagent, now: number): string {
  const what = [agent.type, agent.description].filter((part) => part !== undefined && part !== "");
  const head = what.length > 0 ? what.join(" · ") : agent.id;
  if (agent.since === undefined) return `${head} — turn の途中`;
  const minutes = Math.max(0, Math.floor((now - Date.parse(agent.since)) / 60_000));
  return `${head} — turn の途中 (開始から ${String(minutes)} 分)`;
}

const NOT_DELIVERED: Record<UserMessageReason, string> = {
  not_running: "この subagent はもう走っていない (turn が終わった)。届いていない。",
  refused: "subagent の会話への追加が拒まれた。届いていない。",
  no_module: "このセッションは入力の受け口 (ccmsg plugin の module) を持っていない。届いていない。",
  session_changed: "セッションが /clear か /resume で別の id に移った。届いていない。",
  ended: "セッションは終了している。届いていない。",
};

/** ws.ts が「依頼を書いた後、返事を受け取れなかった」時に返すエラーコード。 */
const REPLY_LOST_CODES = new Set(["connection_closed", "request_timeout"]);

/** 送信の結果: 文を消してよいのは `appended` だけ。 */
export type AgentInputOutcome =
  | { kind: "appended" }
  | { kind: "not_delivered"; reason: UserMessageReason; text: string }
  | { kind: "unconfirmed"; text: string }
  | { kind: "failed"; text: string };

export function classifyAgentInputReply(
  reply: UserMessageResponse | ErrorResponse,
): AgentInputOutcome {
  if (!reply.ok) {
    if (REPLY_LOST_CODES.has(reply.error.code)) {
      return { kind: "unconfirmed", text: "届いたか分からない (返事を受け取れなかった)。" };
    }
    return { kind: "failed", text: `daemon が受け付けなかった: ${reply.error.msg}` };
  }
  switch (reply.outcome) {
    case "appended":
      return { kind: "appended" };
    case "not_delivered":
      return { kind: "not_delivered", reason: reply.reason, text: NOT_DELIVERED[reply.reason] };
    case "unconfirmed":
      return {
        kind: "unconfirmed",
        text: "届いたか分からない (module の返事が時間内に来なかった)。",
      };
  }
}
