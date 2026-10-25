/** @jsxImportSource preact */
// 許可依頼 (DR-0040) のバブル。auto mode の classifier に止められたエージェント
// が、止められた行動・読むファイル・許可してほしいことを並べて人に見せ、
// 「許可する」で許可の文 (permitGrantText) をクリップボードに写す。人はそれを
// そのセッションの入力欄に貼って送る。写せたら依頼を既読にし、Sessions 一覧の
// 🔐 を消す。許可したかどうかは持たない (エージェントが許可の文を受けて再実行
// する)。
import { useState } from "preact/hooks";
import type { PermitAttachment, PermitRequestRecord } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { MarkdownView } from "../../markdown-view.tsx";
import { attachmentNote, fenceLangOfPath, permitGrantText } from "../../permit-request-view.ts";
import { formatMsgTime } from "../../utils.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { useClipboardCopy } from "../CopyButton.tsx";

/** 中身を見せられるファイルは折り畳み (既定で閉じる: 読むかは人が選ぶ)、
 * 見せられないファイルは理由を添えた 1 行。 */
function Attachment({ attachment }: { attachment: PermitAttachment }) {
  const note = attachmentNote(attachment);
  if (!attachment.read) {
    return (
      <div class="permit-attachment permit-attachment-unreadable">
        <code>{attachment.path}</code>
        <span class="permit-attachment-note">{note}</span>
      </div>
    );
  }
  return (
    <details class="permit-attachment">
      <summary>
        <code>{attachment.path}</code>
        {note !== null ? <span class="permit-attachment-note">{note}</span> : null}
      </summary>
      <CodeBlock
        code={attachment.content}
        lang={fenceLangOfPath(attachment.path)}
        placeholder="(空のファイル)"
      />
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
          {request.attachments.map((attachment) => (
            <Attachment key={attachment.path} attachment={attachment} />
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
              <CodeBlock code={command} lang="sh" />
              <span>の実行</span>
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
