/** @jsxImportSource preact */
// セッション行の keepalive の停止 (llm_keepalive_pause)。gateway が延命を
// 予定している間は停止ボタン、止めた後は「停止中」の印を、cache リングと
// 同じ材料 (そのセッションの直近の LLM リクエスト) から出す。止めても
// セッションにはメッセージを流さない — daemon が gateway に POST する。
// 再開の操作は無く、そのセッションの次の実リクエストで gateway が再開し、
// その event で印が消える。
import type { LlmRequestInfo } from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import { useApp } from "../context.ts";
import { keepaliveState } from "../llm-cache-view.ts";
import { useStoreState } from "../useStore.ts";
import { errorMessage } from "../utils.ts";

const PAUSED_TITLE =
  "keepalive 停止中 — cache は今の期限で切れる。このセッションの次のリクエストで再開する";

export function KeepaliveControl({
  sid,
  request,
}: {
  sid: string;
  /** そのセッションの直近の LLM リクエスト (リングと同じもの)。 */
  request: LlmRequestInfo | null;
}) {
  const { store, ws } = useApp();
  const available = useStoreState(store, (s) => s.llmKeepalivePauseAvailable);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const state = request === null ? null : keepaliveState(request, Date.now());
  if (state === "paused") {
    return (
      <span class="session-keepalive session-keepalive-paused" title={PAUSED_TITLE}>
        ⏸
      </span>
    );
  }
  if (state === null || !available) return null;
  const title =
    failure === null
      ? "keepalive を止める — cache は今の期限で切れる"
      : `keepalive を止められなかった: ${failure} (押すともう一度試す)`;
  return (
    <button
      type="button"
      class={failure === null ? "session-keepalive" : "session-keepalive session-keepalive-failed"}
      title={title}
      aria-label={title}
      disabled={pending}
      onClick={(e) => {
        // 行全体が選択のクリック先なので、停止の押下を行に渡さない。
        e.stopPropagation();
        setPending(true);
        void ws
          .llmKeepalivePause(sid)
          .then((res) => setFailure(res.ok ? null : res.error.msg))
          .catch((err) => setFailure(errorMessage(err)))
          .finally(() => setPending(false));
      }}
    >
      ⏸
    </button>
  );
}
