/** @jsxImportSource preact */
// 許可依頼 (DR-0040) のバブル。auto mode の classifier に止められたエージェント
// が、止められた行動・読むファイル・許可してほしいことを並べて人に見せ、
// 「許可する」で許可の文 (permitGrantText) をクリップボードに写す。添付の中身は
// 人が開いた時に daemon から読む。人は許可の文をそのセッションの入力欄に貼って
// 送る。写せたら依頼を既読にし、Sessions 一覧の 🔐 を消す。許可したかどうかは
// 持たない (エージェントが許可の文を受けて再実行する)。
import type { TargetedEvent } from "preact";
import { useState } from "preact/hooks";
import type { PermitAttachment, PermitRequestRecord } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { MarkdownView } from "../../markdown-view.tsx";
import {
  attachmentNote,
  commandHeading,
  fenceLangOfPath,
  permitGrantText,
} from "../../permit-request-view.ts";
import { formatMsgTime } from "../../utils.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { useClipboardCopy } from "../CopyButton.tsx";

/** 開いた添付の中身の読み取り: まだ読んでいない、読んでいる、読めた (中身
 * か読めない理由)、daemon が答えなかった。 */
type AttachmentLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; attachment: PermitAttachment }
  | { kind: "failed"; message: string };

/** 開いた添付の中身。読めたものは拡張子の言語のコードブロック、読めない
 * ものは理由。 */
function AttachmentBody({ load }: { load: AttachmentLoad }) {
  if (load.kind === "idle" || load.kind === "loading") {
    return <p class="permit-attachment-status">読み込み中…</p>;
  }
  if (load.kind === "failed") {
    return <p class="permit-attachment-status permit-grant-error">{load.message}</p>;
  }
  const { attachment } = load;
  const note = attachmentNote(attachment);
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

/** 添付 1 つ。折り畳み (既定で閉じる: 読むかは人が選ぶ) にパスだけを出し、
 * 開いた時に daemon から今の中身を読んで差し込む。読めた後は閉じて開き直し
 * ても読み直さない。daemon が答えなかった時は、次に開いた時に読み直す。 */
function Attachment({ id, path }: { id: string; path: string }) {
  const { ws } = useApp();
  const [load, setLoad] = useState<AttachmentLoad>({ kind: "idle" });
  const onToggle = (e: TargetedEvent<HTMLDetailsElement>): void => {
    if (!e.currentTarget.open || load.kind === "loading" || load.kind === "loaded") return;
    setLoad({ kind: "loading" });
    void ws
      .permitAttachmentRead(id, path)
      .then((res) =>
        setLoad(
          res.ok
            ? { kind: "loaded", attachment: res.attachment }
            : { kind: "failed", message: `読めませんでした: ${res.error.msg}` },
        ),
      )
      .catch(() => setLoad({ kind: "failed", message: "接続エラーのため読めませんでした" }));
  };
  return (
    <details class="permit-attachment" onToggle={onToggle}>
      <summary>
        <code>{path}</code>
      </summary>
      <AttachmentBody load={load} />
    </details>
  );
}

/** 「許可する」。押すと許可の文を写し、写せたら「コピーしました」を短く
 * 出して、未読なら既読にする (写せなかった時は人がまだ何もできていないので
 * 未読のまま)。2 つのラベルを同じ升目に重ねて幅を広い方に固定するので、表示
 * が切り替わってもボタンの幅は変わらない。既読は非楽観で、daemon が変えた
 * 記録を ev:"permit_request" で全タブに送る。 */
function GrantButton({ request }: { request: PermitRequestRecord }) {
  const { ws } = useApp();
  const { copied, copy } = useClipboardCopy();
  const [failed, setFailed] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const markRead = (): void => {
    if (request.read) return;
    void ws
      .permitRequestRead([request.id])
      .then((res) => setReadError(res.ok ? null : res.error.msg))
      .catch(() => setReadError("接続エラーのため確認済みにできませんでした"));
  };
  return (
    <>
      <button
        type="button"
        class={copied ? "permit-grant copied" : "permit-grant"}
        title="許可の文をコピーする (このセッションの入力欄に貼って送る)"
        onClick={() => {
          void copy(permitGrantText(request)).then((ok) => {
            setFailed(!ok);
            if (ok) markRead();
          });
        }}
      >
        <span class="permit-grant-label">✅ 許可する</span>
        <span class="permit-grant-copied" aria-hidden={!copied}>
          コピーしました
        </span>
      </button>
      {failed ? (
        <span class="permit-grant-error" role="alert">
          コピーできませんでした (ブラウザがクリップボードへの書き込みを許していない)
        </span>
      ) : null}
      {readError !== null ? (
        <span class="permit-grant-error" role="alert">
          {readError}
        </span>
      ) : null}
    </>
  );
}

export function PermitRequestBubble({
  request,
  now,
}: {
  request: PermitRequestRecord;
  now: number;
}) {
  return (
    <div class="permit">
      <div class="permit-meta">
        <span class="permit-icon" aria-hidden="true">
          🔐
        </span>
        <span class="permit-title">許可依頼</span>
      </div>
      <section class="permit-section">
        <h4 class="permit-heading">止められた行動</h4>
        <MarkdownView source={request.blocked} />
      </section>
      {request.attachments.length > 0 ? (
        <section class="permit-section">
          <h4 class="permit-heading">添付</h4>
          {request.attachments.map((path) => (
            <Attachment key={path} id={request.id} path={path} />
          ))}
        </section>
      ) : null}
      <section class="permit-section">
        <h4 class="permit-heading">許可してほしいこと</h4>
        <ul class="permit-asks">
          {request.intents.map((intent, i) => (
            <li key={`i${String(i)}`}>
              <MarkdownView source={intent} />
            </li>
          ))}
          {request.commands.map((command, i) => (
            <li key={`c${String(i)}`} class="permit-command">
              <span>{commandHeading(command)}</span>
              <CodeBlock code={command.command} lang="sh" />
            </li>
          ))}
        </ul>
      </section>
      <div class="permit-footer">
        <span class="say-time">{formatMsgTime(request.ts, now)}</span>
        <GrantButton request={request} />
      </div>
    </div>
  );
}
