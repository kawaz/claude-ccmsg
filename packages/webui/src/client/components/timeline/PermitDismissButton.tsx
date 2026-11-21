/** @jsxImportSource preact */
// 許可依頼 (DR-0040 §4) の項目 1 つ (コマンド、settings の変更、intent) の
// 「やらない」。押すと daemon がその項目をやらないと記録する (permit_dismiss)。
// 依頼したセッションには何も送らない。依頼の項目が全部済む (実行した・適用
// した・やらないにした) と、daemon が依頼を未読から外す。項目は種類と位置で
// 指し、状態は daemon が送る ev:"permit_state" の marks をその種類と位置で
// 引く。非楽観で、dismiss が載ると押せなくなる (data-dismissed)。取り消しは
// 持たない。やらないにした後でも「! で実行」「許可する」は押せ、run が載ると
// run が勝つ: このボタンは出さない。
//
// ボタンの文字は「! で実行」と同じく CSS の `content` で出し、DOM のテキストに
// しない: コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と
// Timeline の検索に混ざる。読み上げる名前は aria-label が持つ。
import { useRef, useState } from "preact/hooks";
import type { PermitItemKind } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { permitItemMarkOf } from "../../permit-request-view.ts";
import { useStoreState } from "../../useStore.ts";

/** 送っている、断られた (理由)。 */
type DismissState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/** session `sid` の依頼 `toolUseId` の、種類 `kind` の位置 `index` の項目の
 * 「やらない」。 */
export function PermitDismissButton({
  sid,
  toolUseId,
  kind,
  index,
}: {
  sid: string;
  toolUseId: string;
  kind: PermitItemKind;
  index: number;
}) {
  const { store, ws } = useApp();
  const [state, setState] = useState<DismissState>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const mark = useStoreState(
    store,
    (s) => permitItemMarkOf(s.permitMarks, toolUseId, kind, index)?.mark,
  );
  if (mark === "run") return null;
  const dismissed = mark === "dismiss";
  return (
    <>
      <button
        type="button"
        class="permit-dismiss"
        data-dismissed={dismissed ? "" : undefined}
        aria-label="やらない"
        title={
          dismissed
            ? "やらないにした (この依頼の項目が全部済むと既読になる)"
            : "これはやらないと記録する (セッションには何も送らない。依頼の項目が全部済むと既読になる)"
        }
        disabled={dismissed || state.kind === "sending"}
        aria-busy={state.kind === "sending"}
        onClick={() => {
          if (sending.current) return;
          sending.current = true;
          setState({ kind: "sending" });
          void ws
            .permitDismiss(sid, toolUseId, kind, index)
            .then(
              (res): DismissState =>
                res.ok
                  ? { kind: "idle" }
                  : { kind: "failed", message: `記録できませんでした: ${res.error.msg}` },
              (): DismissState => ({
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
