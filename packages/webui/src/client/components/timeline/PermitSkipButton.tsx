/** @jsxImportSource preact */
// 許可依頼 (DR-0040 §4) の操作 1 つ (コマンド、settings の変更) の「やらない」。
// 押すと daemon がその操作をやらないと記録する (permit_skip)。依頼した
// セッションには何も送らない。依頼の操作が全部済む (実行した・適用した・
// やらないにした) と、daemon が依頼を未読から外す。非楽観で、daemon が送る
// ev:"permit_state" の skipped に載ると押せなくなる (data-skipped)。取り消しは
// 持たない。やらないにした後でも「! で実行」「許可する」は押せ、押した結果が
// 勝つ (呼ぶ側が実行済み・適用済みの操作にはこのボタンを出さない)。
//
// ボタンの文字は「! で実行」と同じく CSS の `content` で出し、DOM のテキストに
// しない: コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と
// Timeline の検索に混ざる。読み上げる名前は aria-label が持つ。
import { useRef, useState } from "preact/hooks";
import type { PermitAction } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { isPermitActionSkipped } from "../../permit-request-view.ts";
import { useStoreState } from "../../useStore.ts";

/** 送っている、断られた (理由)。 */
type SkipState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/** session `sid` の依頼 `toolUseId` の操作 `action` の「やらない」。 */
export function PermitSkipButton({
  sid,
  toolUseId,
  action,
}: {
  sid: string;
  toolUseId: string;
  action: PermitAction;
}) {
  const { store, ws } = useApp();
  const [state, setState] = useState<SkipState>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const skipped = useStoreState(store, (s) =>
    isPermitActionSkipped(s.permitSkipped, toolUseId, action),
  );
  return (
    <>
      <button
        type="button"
        class="permit-skip"
        data-skipped={skipped ? "" : undefined}
        aria-label="やらない"
        title={
          skipped
            ? "やらないにした (この依頼の操作が全部済むと既読になる)"
            : "これはやらないと記録する (セッションには何も送らない。依頼の操作が全部済むと既読になる)"
        }
        disabled={skipped || state.kind === "sending"}
        aria-busy={state.kind === "sending"}
        onClick={() => {
          if (sending.current) return;
          sending.current = true;
          setState({ kind: "sending" });
          void ws
            .permitSkip(sid, toolUseId, action)
            .then(
              (res): SkipState =>
                res.ok
                  ? { kind: "idle" }
                  : { kind: "failed", message: `記録できませんでした: ${res.error.msg}` },
              (): SkipState => ({
                kind: "failed",
                message: "接続エラーのため記録できませんでした",
              }),
            )
            .then((next) => {
              sending.current = false;
              setState(next);
            });
        }}
      />
      {state.kind === "failed" ? (
        <span class="permit-grant-error" role="alert">
          {state.message}
        </span>
      ) : null}
    </>
  );
}
