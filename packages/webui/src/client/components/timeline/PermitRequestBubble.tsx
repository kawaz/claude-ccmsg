/** @jsxImportSource preact */
// 許可依頼 (DR-0040) のバブル。auto mode の classifier に止められたエージェント
// が、止められた行動・読むファイル・許可してほしいことを並べて人に見せ、
// 「許可する」で許可の文 (permitGrantText) をクリップボードに写す。依頼の中身は
// transcript の permit の行 (PermitRequestView)、既読と適用は daemon の
// ev:"permit_state"。添付の中身は
// 人が開いた時に daemon から読む。人は許可の文をそのセッションの入力欄に貼って
// 送る (入力欄が空なら同じ文が入った状態で開く)。写せたら依頼を既読にし、Sessions 一覧の 🔐 を消す。許可せずに
// 既読にするだけの「既読」を「許可する」の左に置く。許可したかどうかは
// 持たない (エージェントが許可の文を受けて再実行する)。各コマンドには
// 「! で実行」を添え、人がそのセッションで `! <command>` と打ったのと同じに
// 実行させる (出力はセッションの会話に入る)。コマンドが終わるまで「実行中…」、
// 終わったら「実行済み」のまま押せない。セッションがプロジェクトの
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
  permitBangKey,
  permitGrantText,
  type PermitRequestView,
} from "../../permit-request-view.ts";
import {
  classifySessionInputReply,
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

/** 依頼を既読にする (permit_read)。`granted` (「許可する」で写した) なら
 * 許可済みにもする。非楽観で、daemon が新しい ev:"permit_state" を全タブに
 * 送る。既に既読 (許可済みを求める時は許可済み) の依頼には何もしない。 */
function usePermitMarkRead(
  request: PermitRequestView,
  state: { read: boolean; granted: boolean },
): {
  markRead: (granted: boolean) => void;
  readError: string | null;
} {
  const { ws } = useApp();
  const [readError, setReadError] = useState<string | null>(null);
  const markRead = (granted: boolean): void => {
    if (granted ? state.granted : state.read) return;
    void ws
      .permitRead([request.toolUseId], granted)
      .then((res) => setReadError(res.ok ? null : res.error.msg))
      .catch(() => setReadError("接続エラーのため確認済みにできませんでした"));
  };
  return { markRead, readError };
}

/** 「許可する」。押すと許可の文 (添付のパスを全部並べる。開いたかは追わ
 * ない: 確認したかは人が判断する) を写し、写せたら「コピーしました」を短く
 * 出して、依頼を許可済み (既読でもある) にする (写せなかった時は人がまだ何も
 * できていないので変えない)。許可済みの依頼では塗りを外した枠だけの
 * 「許可済み」になり、押せばもう一度写せる。3 つのラベルを同じ升目に重ねて
 * 幅を一番広いものに固定するので、表示が切り替わってもボタンの幅は変わら
 * ない。写せたかは `onCopied` で行 (PermitActions) に返し、行が理由を出す。 */
function GrantButton({
  request,
  granted,
  markRead,
  onCopied,
}: {
  request: PermitRequestView;
  granted: boolean;
  markRead: (granted: boolean) => void;
  onCopied: (ok: boolean) => void;
}) {
  const openComposer = useContext(OpenComposerContext);
  const { copied, copy } = useClipboardCopy();
  return (
    <button
      type="button"
      class={["permit-grant", granted ? "granted" : null, copied ? "copied" : null]
        .filter((name) => name !== null)
        .join(" ")}
      title="許可の文をコピーして、このセッションの入力欄を開く (入力欄が空ならその文を入れる。書きかけがあれば貼って送る)"
      onClick={() => {
        const grant = permitGrantText(request.permit);
        void copy(grant).then((ok) => {
          onCopied(ok);
          if (!ok) return;
          markRead(true);
          // The text is on the clipboard: open this session's input box to
          // paste it into, with the text already in it when the box is
          // empty. Not when the copy failed — there is nothing to paste.
          openComposer?.(grant);
        });
      }}
    >
      <span class="permit-grant-label" aria-hidden={granted || copied}>
        ✅ 許可する
      </span>
      <span class="permit-grant-granted" aria-hidden={!granted || copied}>
        許可済み
      </span>
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
 * Sessions 一覧の 🔐 の数から外す。既読の依頼 (許可済みも) では押せない
 * 「既読済み」になる。未操作 / 既読 (無視) / 許可済みの見分けは、この
 * 「既読済み」と「許可する」の塗り / 「許可済み」の枠でつく。写せなかった・
 * 既読にできなかった理由はボタンの左に出す。`project_permissions` だけの
 * 依頼 (asksToRun が偽) には「許可する」が無く、「既読」だけを出す。 */
function PermitActions({
  request,
  read,
  granted,
  asksToRun,
}: {
  request: PermitRequestView;
  read: boolean;
  granted: boolean;
  asksToRun: boolean;
}) {
  const { markRead, readError } = usePermitMarkRead(request, { read, granted });
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
        onClick={() => markRead(false)}
      >
        {read ? "既読済み" : "既読"}
      </button>
      {asksToRun ? (
        <GrantButton
          request={request}
          granted={granted}
          markRead={markRead}
          onCopied={(ok) => setCopyFailed(!ok)}
        />
      ) : null}
    </div>
  );
}

/** 「! で実行」の文字 (CSS の content と同じもの) を、読み上げる名前にする。 */
const BANG_LABEL = { idle: "! で実行", running: "実行中…", ended: "実行済み" } as const;

/** 「! で実行」。コマンドを、依頼したセッションで人が `! <command>` と
 * 打って Enter したのと同じに実行させる (user_prompt の bash mode、DR-0040 §11)。
 * 複数行のコマンドも書き換えずに送り、全文が 1 つのシェルで 1 つのコマンドと
 * して走る。
 * 「許可する」とは独立で、既読にもしない。押してからコマンドが終わるまで
 * (そのセッションの `<bash-input>` の行が ev:"bash_command_ended" で届くまで)
 * 「実行中…」で押せず、終わったら「実行済み」になる。行は終了コードを持た
 * ないので、成功か失敗かは出さない (出力は Timeline に出る)。「実行済み」を
 * 押すと「! で実行」に戻り、もう一度実行できる。戻すのはこのボタンの表示だけ
 * (その場の state) で、store の実行済みは消さないので、バブルが描き直されると
 * 「実行済み」に戻る。受け付けられなかった・確かめられなかった時は
 * 「! で実行」に戻し、入力欄と同じ注記を出す。実行中・実行済みは store
 * (permitBangRuns) に依頼の tool_use の id とコマンドの位置で持ち、バブルが
 * 描き直されても消えない。
 *
 * ボタンの文字は CSS の `content` で出し、DOM のテキストにしない (CodeCopyFrame
 * と同じ): コマンドの並びの中にあり、文字を置くと選んでコピーした文字列と
 * Timeline の検索に混ざる。読み上げる名前は aria-label が持つ。 */
function BangButton({
  toolUseId,
  index,
  sid,
  command,
}: {
  toolUseId: string;
  index: number;
  sid: string;
  command: string;
}) {
  const { ws, store } = useApp();
  const key = permitBangKey(toolUseId, index);
  const run = useStoreState(store, (s) => s.permitBangRuns.get(key));
  const [refused, setRefused] = useState<SessionInputOutcome | null>(null);
  // 「実行済み」を押して「! で実行」に戻した (表示だけ)。次に押した時に解く。
  const [cleared, setCleared] = useState(false);
  const notice = refused !== null ? sessionInputNotice(refused) : null;
  const state = run === undefined || (run.kind === "ended" && cleared) ? "idle" : run.kind;
  return (
    <div class="permit-bang-row">
      <button
        type="button"
        class="permit-bang"
        data-run={state}
        aria-label={BANG_LABEL[state]}
        title={
          state === "ended"
            ? "押すと「! で実行」に戻し、もう一度実行できるようにする"
            : "このコマンドを、このセッションで ! <コマンド> と打って Enter したのと同じに実行する (出力はセッションの会話に入る)"
        }
        disabled={state === "running"}
        aria-busy={state === "running"}
        onClick={() => {
          if (state === "ended") {
            setCleared(true);
            return;
          }
          // The store, not this render's `run`: a second click can come
          // before the render of the first.
          if (store.getState().permitBangRuns.get(key)?.kind === "running") return;
          setCleared(false);
          setRefused(null);
          store.dispatch({ type: "permit-bang/started", key, sid, command });
          void ws
            .userPrompt(sid, command, undefined, "bash")
            .then(classifySessionInputReply, sessionInputSendFailure)
            .then((outcome) => {
              if (outcome.kind === "accepted") return;
              store.dispatch({ type: "permit-bang/withdrawn", key });
              setRefused(outcome);
            });
        }}
      />
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
  // 許可済みは「許可する」で許可の文を写した依頼 (ev:"permit_state" の granted)。
  const granted = useStoreState(store, (s) => s.permitGranted.includes(view.toolUseId));
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
    defaultByText: true,
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
                  <BangButton
                    toolUseId={view.toolUseId}
                    index={i}
                    sid={view.sid}
                    command={command.command}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {request.project_permissions.length > 0 ? <PermitSettingsSection request={view} /> : null}
        <PermitActions request={view} read={read} granted={granted} asksToRun={asksToRun} />
      </div>
      <BubbleFooter
        translation={{ availability: translationAvailability, tab, onSelect: selectTab }}
        ts={view.ts}
        now={now}
      />
    </div>
  );
}
