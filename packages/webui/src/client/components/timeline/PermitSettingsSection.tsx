/** @jsxImportSource preact */
// 許可依頼 (DR-0040 §12) の「.claude/settings.local.json の修正許可」区画。
// 依頼の permit の行の cwd の設定ファイルの今の中身を、人が開いた時に daemon
// から読んで見せ、セッションが求めた permissions.allow の変更を項目ごとに
// 1 行 (li) にして並べる。行には、daemon が書く rule の組 (エージェントが書いた
// rule を当たる形に直し、symlink を通る path なら実体の path の rule も添えた
// もの。ev:"permit_state" の rules) を diff の行 (+ 足す / - 消す) で並べ、下に
// ボタンと印 (✔️✖️) を置く: add の項目は「適用」「削除」、remove の項目は
// 「削除」「やらない」(PermissionChange)。非楽観で、daemon が送る marks で状態を
// 描く。
import type { TargetedEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PermitAttachment, PermitProjectPermission } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import {
  fenceLangOfPath,
  permitItemMarkOf,
  permitRuleSetOf,
  projectPermissionLines,
  projectSettingsPathOf,
  settingsFileNote,
  type PermitRequestView,
} from "../../permit-request-view.ts";
import { useStoreState } from "../../useStore.ts";
import { StackedLabels } from "../StackedLabels.tsx";
import { CodeBlock } from "../CodeBlock.tsx";

/** 開いた設定ファイルの読み取り: 読んでいる、読めた、daemon が答えなかった。 */
type SettingsLoad =
  | { kind: "loading" }
  | { kind: "loaded"; attachment: PermitAttachment }
  | { kind: "failed"; message: string };

/** この依頼の項目の適用の印の並び。どれかが適用されるとファイルが変わるので、
 * 開いている中身を読み直す合図にする。 */
function useAppliedSignature(request: PermitRequestView): string {
  const { store } = useApp();
  return useStoreState(store, (s) =>
    request.permit.project_permissions
      .map((_, index) => {
        const mark = permitItemMarkOf(
          s.permitMarks,
          request.toolUseId,
          "project_permissions",
          index,
        );
        return mark?.mark === "run" ? mark.at : "";
      })
      .join("\n"),
  );
}

/** 開いた設定ファイルの中身。無いファイルは「(無し)」、読めないものは理由。 */
function SettingsFileBody({ load }: { load: SettingsLoad }) {
  if (load.kind === "loading") return <p class="permit-attachment-status">読み込み中…</p>;
  if (load.kind === "failed") {
    return <p class="permit-attachment-status permit-grant-error">{load.message}</p>;
  }
  const { attachment } = load;
  const note = settingsFileNote(attachment);
  return (
    <>
      {note !== null ? <p class="permit-attachment-status">{note}</p> : null}
      {attachment.read ? (
        <CodeBlock
          code={attachment.content}
          lang={fenceLangOfPath(attachment.path)}
          placeholder="(空のファイル)"
        />
      ) : null}
    </>
  );
}

/** 設定ファイルの折り畳み (既定で閉じる)。開いている間は今の中身を daemon
 * から読み、適用でファイルが変わったら読み直す (人もセッションも書き換える
 * ファイルなので、開くたびに読む)。 */
function SettingsFile({ request }: { request: PermitRequestView }) {
  const { ws } = useApp();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<SettingsLoad>({ kind: "loading" });
  const signature = useAppliedSignature(request);
  const { sid, toolUseId } = request;
  // The file is outside the webui: while the fold is open, what it shows is
  // kept in step with the daemon's reading of it, for this request and this
  // set of applies. A reply that comes after the fold closed or the file
  // changed again is dropped.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoad({ kind: "loading" });
    ws.permitSettingsRead(sid, toolUseId)
      .then((res) => {
        if (!current) return;
        setLoad(
          res.ok
            ? { kind: "loaded", attachment: res.attachment }
            : { kind: "failed", message: `読めませんでした: ${res.error.msg}` },
        );
      })
      .catch(() => {
        if (current) setLoad({ kind: "failed", message: "接続エラーのため読めませんでした" });
      });
    return () => {
      current = false;
    };
  }, [open, sid, toolUseId, signature, ws]);
  return (
    <details
      class="permit-attachment permit-settings-file"
      onToggle={(e: TargetedEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <code>{projectSettingsPathOf(request.cwd)}</code>
      </summary>
      {open ? <SettingsFileBody load={load} /> : null}
    </details>
  );
}

/** 行のボタンの 1 回: 送っている、断られた (理由)。 */
type ApplyState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/** 行の操作が送るもの: rule の組を書く (add)、消す (remove)、やらないに
 * する (dismiss)、印 (✅ / ❌) を外して何も無い状態に戻す (unmark)。 */
type RowAction = "add" | "remove" | "dismiss" | "unmark";

/** 項目 1 つ。daemon が書く rule の組の diff の行 (+ / -) と、その下の
 * ボタンと印 (DR-0040 §12):
 *
 * - add の項目: 「適用」(組を全部書く) と「削除」(組と一致する rule を全部消す)。
 *   どちらも済むと項目は run (✅)
 * - remove の項目: 「削除」(その rule を消す、run) と「やらない」(dismiss に
 *   するだけ、❌)
 * - 行の頭の印 ✔️✖️ は項目の状態 (daemon の marks) を映す: ✅ は run、❌ は
 *   dismiss。印が付いている間は 3 つのボタンを全部押せなくする (誤操作を
 *   避ける)。✅ / ❌ を押すと印が外れて何も無い状態に戻り、ボタンが押せる。
 *   外してもファイルは変えない。何も無い時の ✖️ は押すと ❌ にする
 *   (ファイルは触らない)。✅ の時の ✖️ は押せない (run が勝つ)
 *
 * dismiss の行は diff を薄くする。 */
function PermissionChange({
  request,
  permission,
  index,
}: {
  request: PermitRequestView;
  permission: PermitProjectPermission;
  index: number;
}) {
  const { store, ws } = useApp();
  const [state, setState] = useState<ApplyState>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const mark = useStoreState(store, (s) =>
    permitItemMarkOf(s.permitMarks, request.toolUseId, "project_permissions", index),
  );
  const rules = useStoreState(store, (s) =>
    permitRuleSetOf(s.permitRuleSets, request.toolUseId, index),
  );
  const adds = "add" in permission;
  const send = (action: RowAction): void => {
    if (sending.current) return;
    sending.current = true;
    setState({ kind: "sending" });
    const marks = action === "dismiss" || action === "unmark";
    const reply = marks
      ? ws.permitDismiss(
          request.sid,
          request.toolUseId,
          "project_permissions",
          index,
          action === "dismiss",
        )
      : ws.permitPermissionApply(request.sid, request.toolUseId, index, action);
    const failure = marks ? "記録できませんでした" : "書き込めませんでした";
    void reply
      .then(
        (res): ApplyState =>
          res.ok ? { kind: "idle" } : { kind: "failed", message: `${failure}: ${res.error.msg}` },
        (): ApplyState => ({ kind: "failed", message: `接続エラーのため${failure}` }),
      )
      .then((next) => {
        sending.current = false;
        setState(next);
      });
  };
  const busy = state.kind === "sending";
  const marked = mark !== undefined;
  const ran = mark?.mark === "run";
  const dismissed = mark?.mark === "dismiss";
  return (
    <li
      class="permit-settings-change"
      data-permit-kind="project_permissions"
      data-permit-index={index}
      data-mark={mark?.mark}
    >
      <pre class="tl-diff-body permit-settings-diff">
        {projectPermissionLines(permission, rules).map((line) => (
          <div key={`${line.marker}${line.rule}`} class={`tl-diff-line tl-diff-${line.kind}`}>
            <span class="tl-diff-marker">{line.marker}</span>
            <span>{line.rule}</span>
          </div>
        ))}
      </pre>
      <div class="permit-settings-apply-row">
        {adds ? (
          <button
            type="button"
            class="permit-settings-apply"
            title="この項目の rule の組を .claude/settings.local.json の permissions.allow に書き込む (印が付いている間は押せない)"
            disabled={marked || busy}
            aria-busy={busy}
            onClick={() => send("add")}
          >
            適用
          </button>
        ) : null}
        <button
          type="button"
          class="permit-settings-delete"
          title={
            adds
              ? "この項目の rule の組と一致する rule を permissions.allow から全部消す (印が付いている間は押せない)"
              : "この rule を permissions.allow から消す (印が付いている間は押せない)"
          }
          disabled={marked || busy}
          onClick={() => send("remove")}
        >
          削除
        </button>
        {adds ? null : (
          <button
            type="button"
            class="permit-settings-dismiss"
            title="この rule は消さない (ファイルは触らない。印が付いている間は押せない)"
            disabled={marked || busy}
            onClick={() => send("dismiss")}
          >
            やらない
          </button>
        )}
        <span class="permit-toggles">
          <button
            type="button"
            class="permit-toggle permit-toggle-pick"
            aria-label="済み"
            aria-pressed={ran}
            title={
              ran
                ? "印を外す (ファイルは変えない)"
                : "「適用」「削除」を押すと、済みの印がここに付く"
            }
            disabled={!ran || busy}
            onClick={() => send("unmark")}
          >
            <StackedLabels labels={["✔️", "✅"]} shown={ran ? 1 : 0} />
          </button>
          <button
            type="button"
            class="permit-toggle permit-toggle-dismiss"
            aria-label="やらない"
            aria-pressed={dismissed}
            aria-busy={busy}
            title={
              dismissed ? "やらないのをやめる" : "これはやらないと記録する (ファイルは触らない)"
            }
            disabled={ran || busy}
            onClick={() => send(dismissed ? "unmark" : "dismiss")}
          >
            <StackedLabels labels={["✖️", "❌"]} shown={dismissed ? 1 : 0} />
          </button>
        </span>
        {state.kind === "failed" ? (
          <span class="permit-grant-error" role="alert">
            {state.message}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** 区画全体。設定ファイルの折り畳みと、変更ごとの行。 */
export function PermitSettingsSection({ request }: { request: PermitRequestView }) {
  return (
    <section class="permit-section permit-settings">
      <h4 class="permit-heading">
        <code>.claude/settings.local.json</code> の修正許可
      </h4>
      <SettingsFile request={request} />
      <ul class="permit-settings-changes">
        {request.permit.project_permissions.map((permission, index) => (
          <PermissionChange
            key={String(index)}
            request={request}
            permission={permission}
            index={index}
          />
        ))}
      </ul>
    </section>
  );
}
