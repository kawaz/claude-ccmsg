/** @jsxImportSource preact */
// 許可依頼 (DR-0040) のバブル。auto mode の classifier に止められたエージェント
// が、止められた行動・読むファイル・許可してほしいことを並べて人に見せ、
// 「許可する」で許可の文 (permitGrantText) をクリップボードに写す。依頼の中身は
// transcript の permit の行 (PermitRequestView)、既読と適用は daemon の
// ev:"permit_state"。添付の中身は
// 人が開いた時に daemon から読む。人は許可の文をそのセッションの入力欄に貼って
// 送る (入力欄が空なら同じ文が入った状態で開く)。写せたら依頼を既読にし、Sessions 一覧の 🔐 を消す。許可せずに
// 既読にするだけの「既読」を「許可する」の左に置く。許可したかどうかは
// 持たない (エージェントが許可の文を受けて再実行する)。1 行のコマンドには
// 「! で実行」を添え、人がそのセッションで `! <command>` と打ったのと同じに
// 実行させる (出力はセッションの会話に入る)。セッションがプロジェクトの
// permissions.allow の変更を求めていれば、その区画 (PermitSettingsSection) を
// 「許可する」の前に置く。project_permissions だけの依頼には「許可してほしい
// こと」と「許可する」を出さない (写す操作が無い)。
import type { TargetedEvent } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import type { PermitAttachment, PermitCall, PermitCommand } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import { useStoreState } from "../../useStore.ts";
import { MarkdownView } from "../../markdown-view.tsx";
import {
  attachmentNote,
  commandHeading,
  fenceLangOfPath,
  isOneLineCommand,
  permitGrantText,
  type PermitRequestView,
} from "../../permit-request-view.ts";
import {
  classifySessionInputReply,
  formatSentAt,
  type SessionInputOutcome,
  sessionInputNotice,
  sessionInputSendFailure,
} from "../session-input.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { OpenComposerContext } from "../SessionInputComposer.tsx";
import { useClipboardCopy } from "../CopyButton.tsx";
import {
  type TranslationAvailability,
  type TranslationTab,
  useBubbleTranslationTab,
  useTranslatedText,
} from "./translation.ts";
import { TranslatedScope } from "./translated-scope.tsx";
import { BubbleFooter } from "./BubbleFooter.tsx";
import { PermitSettingsSection } from "./PermitSettingsSection.tsx";

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
 * 開いた時に `onOpen` で今の中身を読ませ、その結果 `load` を差し込む。 */
function Attachment({
  path,
  load,
  onOpen,
}: {
  path: string;
  load: AttachmentLoad;
  onOpen: () => void;
}) {
  return (
    <details
      class="permit-attachment"
      onToggle={(e: TargetedEvent<HTMLDetailsElement>) => {
        if (e.currentTarget.open) onOpen();
      }}
    >
      <summary>
        <code>{path}</code>
      </summary>
      <AttachmentBody load={load} />
    </details>
  );
}

/** 添付ごとの読み取りの状態。開いた時に daemon から読み、読めた後は閉じて
 * 開き直しても読み直さない。daemon が答えなかった時は、次に開いた時に読み
 * 直す。 */
function useAttachmentLoads(request: PermitRequestView): {
  loadOf: (path: string) => AttachmentLoad;
  open: (path: string) => void;
} {
  const { ws } = useApp();
  const [loads, setLoads] = useState<ReadonlyMap<string, AttachmentLoad>>(new Map());
  const loadOf = (path: string): AttachmentLoad => loads.get(path) ?? { kind: "idle" };
  const settle = (path: string, load: AttachmentLoad): void =>
    setLoads((held) => new Map(held).set(path, load));
  const open = (path: string): void => {
    const now = loadOf(path);
    if (now.kind === "loading" || now.kind === "loaded") return;
    settle(path, { kind: "loading" });
    void ws
      .permitAttachmentRead(request.sid, request.toolUseId, path)
      .then((res) =>
        settle(
          path,
          res.ok
            ? { kind: "loaded", attachment: res.attachment }
            : { kind: "failed", message: `読めませんでした: ${res.error.msg}` },
        ),
      )
      .catch(() => settle(path, { kind: "failed", message: "接続エラーのため読めませんでした" }));
  };
  return { loadOf, open };
}

/** 依頼を既読にする (permit_read)。既読は非楽観で、daemon が新しい
 * ev:"permit_state" を全タブに送る。既読の依頼には何もしない。 */
function usePermitMarkRead(
  request: PermitRequestView,
  read: boolean,
): {
  markRead: () => void;
  readError: string | null;
} {
  const { ws } = useApp();
  const [readError, setReadError] = useState<string | null>(null);
  const markRead = (): void => {
    if (read) return;
    void ws
      .permitRead([request.toolUseId])
      .then((res) => setReadError(res.ok ? null : res.error.msg))
      .catch(() => setReadError("接続エラーのため確認済みにできませんでした"));
  };
  return { markRead, readError };
}

/** 「許可する」。押すと許可の文 (添付のパスを全部並べる。開いたかは追わ
 * ない: 確認したかは人が判断する) を写し、写せたら「コピーしました」を短く
 * 出して、未読なら既読にする (写せなかった時は人がまだ何もできていないので
 * 未読のまま)。2 つのラベルを同じ升目に重ねて幅を広い方に固定するので、
 * 表示が切り替わってもボタンの幅は変わらない。写せたかは `onCopied` で
 * 行 (PermitActions) に返し、行が理由を出す。 */
function GrantButton({
  request,
  markRead,
  onCopied,
}: {
  request: PermitRequestView;
  markRead: () => void;
  onCopied: (ok: boolean) => void;
}) {
  const openComposer = useContext(OpenComposerContext);
  const { copied, copy } = useClipboardCopy();
  return (
    <button
      type="button"
      class={copied ? "permit-grant copied" : "permit-grant"}
      title="許可の文をコピーして、このセッションの入力欄を開く (入力欄が空ならその文を入れる。書きかけがあれば貼って送る)"
      onClick={() => {
        const grant = permitGrantText(request.permit);
        void copy(grant).then((ok) => {
          onCopied(ok);
          if (!ok) return;
          markRead();
          // The text is on the clipboard: open this session's input box to
          // paste it into, with the text already in it when the box is
          // empty. Not when the copy failed — there is nothing to paste.
          openComposer?.(grant);
        });
      }}
    >
      <span class="permit-grant-label">✅ 許可する</span>
      <span class="permit-grant-copied" aria-hidden={!copied}>
        コピーしました
      </span>
    </button>
  );
}

/** 本文の最後の行 (DR-0040 §7)。右端に依頼全体の「許可する」、その左に
 * 「既読」を置く。個別のボタン (「! で実行」、settings の「許可する」) は
 * 左に並ぶので、一番下の個別のボタンを押そうとして全体の「許可する」を
 * 押さない位置にする。「既読」は許可の文を写さずに依頼を既読にし、
 * Sessions 一覧の 🔐 の数から外す (既読の依頼では押せない)。写せなかった・
 * 既読にできなかった理由はボタンの左に出す。`project_permissions` だけの
 * 依頼 (asksToRun が偽) には「許可する」が無く、「既読」だけを出す。 */
function PermitActions({
  request,
  read,
  asksToRun,
}: {
  request: PermitRequestView;
  read: boolean;
  asksToRun: boolean;
}) {
  const { markRead, readError } = usePermitMarkRead(request, read);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div class="permit-grant-row">
      {copyFailed || readError !== null ? (
        <div class="permit-grant-notes">
          {copyFailed ? (
            <span class="permit-grant-error" role="alert">
              コピーできませんでした (ブラウザがクリップボードへの書き込みを許していない)
            </span>
          ) : null}
          {readError !== null ? (
            <span class="permit-grant-error" role="alert">
              {readError}
            </span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        class="permit-read"
        title="許可はせずに既読にする (Sessions 一覧の 🔐 の数から外す)"
        disabled={read}
        onClick={markRead}
      >
        既読
      </button>
      {asksToRun ? (
        <GrantButton request={request} markRead={markRead} onCopied={(ok) => setCopyFailed(!ok)} />
      ) : null}
    </div>
  );
}

/** 「! で実行」の 1 回の送信: 送っている、終わった (その結果と押した時刻)。 */
type BangRun =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; outcome: SessionInputOutcome; at: string };

/** 「! で実行」。1 行のコマンドを、依頼したセッションで人が `! <command>` と
 * 打って Enter したのと同じに実行させる (user_prompt の bash mode、DR-0040 §7)。
 * 「許可する」とは独立で、既読にもしない。出力はそのセッションの会話に入り、
 * Timeline にはコマンドが終わった後に出るので、送れた時は押した時刻を添え、
 * 二度押しの判断材料にする。届かなかった・確かめられなかった時は入力欄と
 * 同じ注記を出す。送っている間は押せない。
 *
 * ボタンの文字は CSS の `content` で出し、DOM のテキストにしない (CodeCopyFrame
 * と同じ): コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と
 * Timeline の検索に混ざる。読み上げる名前は aria-label が持つ。 */
function BangButton({ sid, command }: { sid: string; command: string }) {
  const { ws } = useApp();
  const [run, setRun] = useState<BangRun>({ kind: "idle" });
  // 同期で見る: 連打は再 render の前に 2 回目を呼びうる。
  const sending = useRef(false);
  const notice = run.kind === "done" ? sessionInputNotice(run.outcome) : null;
  return (
    <div class="permit-bang-row">
      <button
        type="button"
        class="permit-bang"
        aria-label="! で実行"
        title="このコマンドを、このセッションで ! <コマンド> と打って Enter したのと同じに実行する (出力はセッションの会話に入る)"
        disabled={run.kind === "sending"}
        aria-busy={run.kind === "sending"}
        onClick={() => {
          if (sending.current) return;
          sending.current = true;
          setRun({ kind: "sending" });
          const at = new Date().toISOString();
          void ws
            .userPrompt(sid, command, undefined, "bash")
            .then(classifySessionInputReply, sessionInputSendFailure)
            .then((outcome) => {
              sending.current = false;
              setRun({ kind: "done", outcome, at });
            });
        }}
      />
      {run.kind === "done" && run.outcome.kind === "accepted" ? (
        <span class="permit-bang-sent" role="status">
          {formatSentAt(run.at)} に送りました。出力はコマンドが終わると Timeline に出ます
        </span>
      ) : null}
      {notice !== null ? (
        <div class={`session-input-notice session-input-notice-${notice.tone}`} role="alert">
          <p class="session-input-notice-title">{notice.title}</p>
          <p class="session-input-notice-detail">{notice.detail}</p>
        </div>
      ) : null}
    </div>
  );
}

/** 人が書いた文 1 つ (止められた行動 / intent) を、選ばれた翻訳タブの綴りで
 * markdown として出す。 */
function TranslatedMarkdown({
  source,
  tab,
  availability,
}: {
  source: string;
  tab: TranslationTab;
  availability: TranslationAvailability;
}) {
  const { bodyText, translatingLabel } = useTranslatedText(source, availability, tab);
  return (
    <>
      <TranslatedScope tab={tab}>
        <MarkdownView source={bodyText} />
      </TranslatedScope>
      {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
    </>
  );
}

/** コマンドの見出し。説明 (description) は人が書いた文なので訳し、コマンド
 * 本文は書かれたまま出す。 */
function TranslatedCommandHeading({
  command,
  description,
  tab,
  availability,
}: {
  command: PermitCommand;
  description: string;
  tab: TranslationTab;
  availability: TranslationAvailability;
}) {
  const { bodyText, translatingLabel } = useTranslatedText(description, availability, tab);
  return (
    <>
      <TranslatedScope tab={tab}>
        <span>{commandHeading({ ...command, description: bodyText })}</span>
      </TranslatedScope>
      {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
    </>
  );
}

/** 訳す対象 (止められた行動、intent、コマンドの説明) を段落としてつないだ
 * もの。既定のタブの判定に渡す。コマンド本文と添付のパスは訳さない。 */
function permitTranslatableText(request: PermitCall): string {
  return [
    request.blocked,
    ...request.intents,
    ...request.commands.flatMap((command) =>
      command.description !== undefined ? [command.description] : [],
    ),
  ].join("\n\n");
}

/** 外枠は TL の他の吹き出しと同じ部品 (.tl-bubble / .tl-bubble-body /
 * .tl-bubble-from / BubbleFooter) で組み、中身の節と
 * 「許可する」だけをこのバブルのものにする。未読と既読で
 * 見た目は変えず、帯のアイコン (🔐 / 🔓) だけを替える。「既読」と「許可する」
 * は本文の最後の行の右端に置く (足元の行は他の吹き出しと同じく翻訳タブと時刻)。翻訳タブは人が読む文
 * (止められた行動、intent、コマンドの説明) に効き、コマンド本文・添付の
 * パス・「許可する」が写す許可の文は原文のまま。 */
export function PermitRequestBubble({
  request: view,
  now,
  translationAvailability,
}: {
  request: PermitRequestView;
  now: number;
  translationAvailability: TranslationAvailability;
}) {
  const { store } = useApp();
  // 未読は daemon が持つ集合 (ev:"permit_state") に居るもの。
  const read = useStoreState(
    store,
    (s) => !s.permitUnread.some((unread) => unread.tool_use_id === view.toolUseId),
  );
  const request = view.permit;
  const attachments = useAttachmentLoads(view);
  // 許可の文に並べる操作 (intents / commands) がある依頼だけに「許可して
  // ほしいこと」と「許可する」を出す。project_permissions だけの依頼は、
  // 区画の各「許可する」が人の手を付けた印 (既読) になる。
  const asksToRun = request.intents.length + request.commands.length > 0;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { tab, selectTab } = useBubbleTranslationTab({
    text: permitTranslatableText(request),
    availability: translationAvailability,
    elementRef: bubbleRef,
  });
  return (
    <div class="tl-bubble tl-bubble-left tl-bubble-permit" ref={bubbleRef}>
      <div class="tl-bubble-body">
        <div class="tl-bubble-from">
          {/* 未読は閉じた錠、人が「許可する」を押した (既読) 後は開いた錠。 */}
          <span class="permit-icon" aria-hidden="true">
            {read ? "🔓" : "🔐"}
          </span>
          許可依頼
        </div>
        <section class="permit-section">
          <h4 class="permit-heading">止められた行動</h4>
          <TranslatedMarkdown
            source={request.blocked}
            tab={tab}
            availability={translationAvailability}
          />
        </section>
        {request.attachments.length > 0 ? (
          <section class="permit-section">
            <h4 class="permit-heading">添付</h4>
            {request.attachments.map((path) => (
              <Attachment
                key={path}
                path={path}
                load={attachments.loadOf(path)}
                onOpen={() => attachments.open(path)}
              />
            ))}
          </section>
        ) : null}
        {asksToRun ? (
          <section class="permit-section">
            <h4 class="permit-heading">許可してほしいこと</h4>
            <ul class="permit-asks">
              {request.intents.map((intent, i) => (
                <li key={`i${String(i)}`}>
                  <TranslatedMarkdown
                    source={intent}
                    tab={tab}
                    availability={translationAvailability}
                  />
                </li>
              ))}
              {request.commands.map((command, i) => (
                <li key={`c${String(i)}`} class="permit-command">
                  {command.description !== undefined ? (
                    <TranslatedCommandHeading
                      command={command}
                      description={command.description}
                      tab={tab}
                      availability={translationAvailability}
                    />
                  ) : (
                    <span>{commandHeading(command)}</span>
                  )}
                  <CodeBlock code={command.command} lang="sh" />
                  {isOneLineCommand(command.command) ? (
                    <BangButton sid={view.sid} command={command.command} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {request.project_permissions.length > 0 ? <PermitSettingsSection request={view} /> : null}
        <PermitActions request={view} read={read} asksToRun={asksToRun} />
      </div>
      <BubbleFooter
        translation={{ availability: translationAvailability, tab, onSelect: selectTab }}
        ts={view.ts}
        now={now}
      />
    </div>
  );
}
