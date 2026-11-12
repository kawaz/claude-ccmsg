// 選択中の項目に対する操作 (dump) と fork 地点の区切り線。
import { useState } from "preact/hooks";
import { type ForkOrigin } from "@ccmsg/protocol";
import { sessionHref } from "../../locator.ts";
import { useApp } from "../../context.ts";
import { isScopedDump, sessionDumpRequest } from "../../session-dump-action.ts";

/** The seam in a forked session: everything above it was copied from the
 * ancestor when the fork was taken, everything below is this session's own.
 * A labelled hairline in the sidebar's `.tree-section-label` register — the
 * point is to be findable while scrolling past, not to announce itself. */
export function ForkDivider({ origin }: { origin: ForkOrigin }) {
  return (
    <div class="tl-fork-divider">
      <span class="tl-fork-divider-label">
        {"ここから fork ("}
        <a href={sessionHref(origin.sid)} title={origin.sid}>
          {`元: ${origin.sid.slice(0, 8)}`}
        </a>
        {")"}
      </span>
    </div>
  );
}

/** dump をファイルに書き出すアクションの状態。path は daemon ホスト上の絶対
 * パスで、次にすることは「別のセッションに渡す」なので表示したまま残す。 */
type DumpActionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; path: string; entries: number }
  | { kind: "error"; msg: string };

/** dump をファイルに書き出すアクション。無選択ならセッション全体、項目を
 * 選択中ならその record 以降 (選択自身を含む) を切り出す。放棄された分岐上の
 * record も正当な起点 (session-dump-action.ts 参照)。 */
export function DumpFileAction({ sid, position }: { sid: string; position: string }) {
  const { ws } = useApp();
  const [state, setState] = useState<DumpActionState>({ kind: "idle" });
  // 既定はどちらも OFF = 全部入り。dump の第一用途が「記憶の引き継ぎ」で、
  // 削るかどうかは渡す相手次第なので、削る側を明示操作にする。
  const [noThinking, setNoThinking] = useState(false);
  const [noAgent, setNoAgent] = useState(false);
  const scoped = isScopedDump(position);
  return (
    <div class="tl-float-dump">
      <div class="tl-float-dump-opts">
        <label>
          <input
            type="checkbox"
            checked={noThinking}
            onChange={(e) => setNoThinking(e.currentTarget.checked)}
          />
          thinking を除く
        </label>
        <label>
          <input
            type="checkbox"
            checked={noAgent}
            onChange={(e) => setNoAgent(e.currentTarget.checked)}
          />
          agent 機構を除く
        </label>
      </div>
      <button
        type="button"
        class="tl-float-action"
        disabled={state.kind === "running"}
        onClick={() => {
          setState({ kind: "running" });
          void ws
            .sessionDumpFile(sessionDumpRequest({ sid, position, noThinking, noAgent }))
            .then((res) => {
              if (!res.ok) {
                setState({ kind: "error", msg: res.error.msg });
                return;
              }
              setState({ kind: "done", path: res.path, entries: res.entries });
            })
            .catch((e: unknown) => setState({ kind: "error", msg: String(e) }));
        }}
      >
        {state.kind === "running"
          ? "dump 出力中…"
          : scoped
            ? "この項目以降を dump"
            : "セッション全体を dump"}
      </button>
      {state.kind === "done" ? (
        <button
          type="button"
          class="tl-float-dump-path"
          title="クリックでコピー"
          onClick={() => {
            void navigator.clipboard?.writeText(state.path).catch(() => {
              // clipboard unavailable (insecure context, permission denied) —
              // the path stays selectable on screen.
            });
          }}
        >
          {state.path}
        </button>
      ) : null}
      <p class="tl-float-note">
        {state.kind === "done"
          ? `${state.entries} 件をテキストで書き出しました。パスをクリックでコピーできます。`
          : state.kind === "error"
            ? `dump に失敗しました: ${state.msg}`
            : scoped
              ? "選択中の項目を含め、それ以降を daemon ホストの dumps/ にテキストで書き出します。選択を解除するとセッション全体になります。"
              : "セッション全体 (todos / agents / rooms + 会話) を daemon ホストの dumps/ にテキストで書き出します。項目を選択すると、そこ以降だけを切り出せます。"}
      </p>
    </div>
  );
}
