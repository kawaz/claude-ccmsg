/** @jsxImportSource preact */
// 許可依頼 (DR-0040 §4、§8) の項目 1 つの行の頭のトグル。✔️ (選ぶ) と ✖️
// (やらない) の 2 つで、状態は 3 つ: 何もなし (✔️✖️)、選んだ (✅✖️)、やらない
// (✔️❌)。✅ と ❌ は同時に立たない (片方を押すともう片方は外れる)。
//
// - ✔️ は intents と commands だけに置く (`pickable`): 依頼全体の「許可する」が
//   写す許可の文に入れる項目を選ぶ。タブの中の一時の状態 (store の
//   permitPicked) で、daemon には送らない (リロードで消える)
// - ✖️ はどの種類にも置く: daemon に permit_dismiss で送り (on / off)、全タブに
//   ev:"permit_state" の marks の dismiss で戻ってくる。非楽観で、送っている間は
//   押せない。依頼したセッションには何も送らない
// - 項目が run (実行した・適用した・写した) なら、✖️ は押せない (run が勝つ)
//
// 絵文字は StackedLabels で同じ升目に重ね、切り替わっても幅が動かない。読み上げ
// る名前と押されているかは aria-label と aria-pressed が持つ。
import { useRef, useState } from "preact/hooks";
import type { PermitItemKind } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { permitItemKey, permitItemMarkOf } from "../../permit-request-view.ts";
import { useStoreState } from "../../useStore.ts";
import { StackedLabels } from "../StackedLabels.tsx";

/** 送っている、断られた (理由)。 */
type DismissState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/** session `sid` の依頼 `toolUseId` の、種類 `kind` の位置 `index` の項目の
 * トグル。`pickable` なら ✔️ も置く。 */
export function PermitItemToggles({
  sid,
  toolUseId,
  kind,
  index,
  pickable,
}: {
  sid: string;
  toolUseId: string;
  kind: PermitItemKind;
  index: number;
  pickable: boolean;
}) {
  const { store, ws } = useApp();
  const key = permitItemKey(toolUseId, kind, index);
  const mark = useStoreState(
    store,
    (s) => permitItemMarkOf(s.permitMarks, toolUseId, kind, index)?.mark,
  );
  const dismissed = mark === "dismiss";
  // A pick of this tab gives way to a dismissal made in another tab: ✅ and
  // ❌ never stand together.
  const picked = useStoreState(store, (s) => s.permitPicked.has(key)) && !dismissed;
  const [state, setState] = useState<DismissState>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const pick = (on: boolean): void =>
    store.dispatch({ type: "permit-item/picked", key, picked: on });
  const dismiss = (on: boolean): void => {
    if (sending.current) return;
    sending.current = true;
    setState({ kind: "sending" });
    void ws
      .permitDismiss(sid, toolUseId, kind, index, on)
      .then(
        (res): DismissState =>
          res.ok
            ? { kind: "idle" }
            : { kind: "failed", message: `記録できませんでした: ${res.error.msg}` },
        (): DismissState => ({ kind: "failed", message: "接続エラーのため記録できませんでした" }),
      )
      .then((next) => {
        sending.current = false;
        setState(next);
      });
  };
  return (
    <span class="permit-toggles">
      {pickable ? (
        <button
          type="button"
          class="permit-toggle permit-toggle-pick"
          aria-label="選ぶ"
          aria-pressed={picked}
          title={
            picked
              ? "選ぶのをやめる"
              : "依頼全体の「許可する」が写す許可の文に入れる (このタブの中だけ)"
          }
          disabled={state.kind === "sending"}
          onClick={() => {
            if (picked) {
              pick(false);
              return;
            }
            pick(true);
            if (dismissed) dismiss(false);
          }}
        >
          <StackedLabels labels={["✔️", "✅"]} shown={picked ? 1 : 0} />
        </button>
      ) : null}
      <button
        type="button"
        class="permit-toggle permit-toggle-dismiss"
        aria-label="やらない"
        aria-pressed={dismissed}
        aria-busy={state.kind === "sending"}
        title={
          dismissed
            ? "やらないのをやめる"
            : "これはやらないと記録する (セッションには何も送らない。依頼の項目が全部済むと既読になる)"
        }
        disabled={mark === "run" || state.kind === "sending"}
        onClick={() => {
          if (dismissed) {
            dismiss(false);
            return;
          }
          if (picked) pick(false);
          dismiss(true);
        }}
      >
        <StackedLabels labels={["✖️", "❌"]} shown={dismissed ? 1 : 0} />
      </button>
      {state.kind === "failed" ? (
        <span class="permit-grant-error" role="alert">
          {state.message}
        </span>
      ) : null}
    </span>
  );
}
