/** @jsxImportSource preact */
// 許可依頼 (DR-0040 §12) の「.claude/settings.local.json の修正許可」区画。
// 依頼の permit の行の cwd の設定ファイルの今の中身を、人が開いた時に daemon
// から読んで見せ、セッションが求めた permissions.allow の変更を項目ごとに diff
// の行 (+ 足す / - 消す) で並べる。symlink を通る path とその実体の path の
// rule のように組になる rule は 1 つの項目で、行を並べて 1 組のボタンを持つ。
// 各項目の「許可する」で daemon がその項目の rule を全部書き込み、適用時刻を
// 持つ (非楽観: daemon が送る ev:"permit_state" の marks に run が載ると
// 「適用済み」になる)。「やらない」は項目をやらないと記録する。
import type { TargetedEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { PermitAttachment, PermitProjectPermissionItem } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import {
  fenceLangOfPath,
  permitItemMarkOf,
  projectPermissionLines,
  projectSettingsPathOf,
  settingsFileNote,
  type PermitRequestView,
} from "../../permit-request-view.ts";
import { useStoreState } from "../../useStore.ts";
import { formatSentAt } from "../session-input.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { PermitDismissButton } from "./PermitDismissButton.tsx";

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

/** 1 件の適用: 送っている、断られた (理由)。 */
type ApplyState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/** 項目 1 つ。rule ごとの diff の行 (+ / -) と、その項目の rule だけを全部
 * 書き込む「許可する」、「やらない」。適用済みならボタンを無効にして適用した
 * 時刻を出す。 */
function PermissionChange({
  request,
  permission,
  index,
}: {
  request: PermitRequestView;
  permission: PermitProjectPermissionItem;
  index: number;
}) {
  const { store, ws } = useApp();
  const [state, setState] = useState<ApplyState>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const mark = useStoreState(store, (s) =>
    permitItemMarkOf(s.permitMarks, request.toolUseId, "project_permissions", index),
  );
  const applied = mark?.mark === "run" ? mark.at : undefined;
  return (
    <li
      class="permit-settings-change"
      data-permit-kind="project_permissions"
      data-permit-index={index}
    >
      <pre class="tl-diff-body permit-settings-diff">
        {projectPermissionLines(permission).map((line) => (
          <div key={`${line.marker}${line.rule}`} class={`tl-diff-line tl-diff-${line.kind}`}>
            <span class="tl-diff-marker">{line.marker}</span>
            <span>{line.rule}</span>
          </div>
        ))}
      </pre>
      <div class="permit-settings-apply-row">
        <button
          type="button"
          class="permit-settings-apply"
          title="この項目の rule を .claude/settings.local.json の permissions.allow に書き込む"
          disabled={applied !== undefined || state.kind === "sending"}
          aria-busy={state.kind === "sending"}
          onClick={() => {
            if (sending.current) return;
            sending.current = true;
            setState({ kind: "sending" });
            void ws
              .permitPermissionApply(request.sid, request.toolUseId, index)
              .then(
                (res): ApplyState =>
                  res.ok
                    ? { kind: "idle" }
                    : { kind: "failed", message: `書き込めませんでした: ${res.error.msg}` },
                (): ApplyState => ({
                  kind: "failed",
                  message: "接続エラーのため書き込めませんでした",
                }),
              )
              .then((next) => {
                sending.current = false;
                setState(next);
              });
          }}
        >
          {applied !== undefined
            ? `適用済み ${formatSentAt(applied)}`
            : state.kind === "sending"
              ? "書き込み中…"
              : "✅ 許可する"}
        </button>
        <PermitDismissButton
          sid={request.sid}
          toolUseId={request.toolUseId}
          kind="project_permissions"
          index={index}
        />
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
