// turn の中の 1 segment (text / thinking / tool ...) の描画。
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { type Segment } from "../../transcript-model.ts";
import { LinkedMarkdownView, LinkedPlainText } from "../../filepath-linker.tsx";
import { type SearchWord } from "../../in-view-search.ts";
import { CopyablePreText } from "../CodeCopyFrame.tsx";
import { type TLSearchCtx } from "./useInViewSearch.ts";
import { SessionFilePathCtxContext, useCategoryOpen } from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";
import { FileReadFold, FileChangeFold, BashUseFold, BashResultFold } from "./tools.tsx";
import { AgentSendFold, AgentSpawnFold } from "./agents.tsx";
import {
  type TranslationAvailability,
  type TranslationTab,
  isTranslationTabOffered,
  useTranslatedText,
  useDefaultTranslationTab,
} from "./translation.ts";
import { TranslatedScope } from "./translated-scope.tsx";
import { BubbleFooter } from "./BubbleFooter.tsx";

/** 本文の無い thinking (thinking-hidden)。thinking が起きた事実は TL の
 * 流れとして意味を持つので通常 thinking と同じ fold で並べ、中身は理由を
 * 示す 1 行に置き換える。閉じたままでも中身が無いと分かるよう summary に
 * 印を付ける。翻訳・検索の対象にはならない (綴りが存在しない)。 */
function HiddenThinkingSegment({
  reason,
  ts,
}: {
  reason: "omitted" | "redacted";
  ts: string | null;
}) {
  const [detailsOpen, setDetailsOpen] = useCategoryOpen("thinking");
  const note =
    reason === "omitted"
      ? "思考内容は非公開 — model が本文を返さない設定で動作"
      : "安全性により墨消しされた思考 — 本文は復元できない";
  return (
    <details
      class="tl-fold tl-thinking"
      open={detailsOpen}
      onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
    >
      <FoldSummary
        ts={ts}
        label="thinking"
        open={detailsOpen}
        decoration={{ kind: "thinking" }}
        trailing={reason === "omitted" ? "(非公開)" : "(墨消し)"}
      />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-thinking-body">
          <div class="tl-thinking-hidden-note">({note})</div>
        </div>
      </div>
    </details>
  );
}

function ThinkingSegment({
  text,
  ts,
  translationAvailability,
  // fold グループ (FoldGroup の <details>) が開いているか — 表示形式統一
  // タスクの kawaz spec: 「fold を開いた時、中の thinking は details open +
  // 利用可能な ja タブ選択がデフォルト」。fold 外からは false で渡る。
  foldGroupOpen,
  mdSearch,
  onDisplayChange,
}: {
  text: string;
  ts: string | null;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
  mdSearch: { words: SearchWord[]; onMatchClick: () => void } | undefined;
  /** Called after the body switches to a different spelling (tab change, or a
   * translation replacing the text already on screen). Undefined when no query
   * is live, since nothing is reading the rendered text then. */
  onDisplayChange?: (() => void) | undefined;
}) {
  const filePathCtx = useContext(SessionFilePathCtxContext);
  const [tab, setTab] = useState<TranslationTab>("original");
  const [detailsOpen, setDetailsOpen] = useCategoryOpen("thinking");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const { bodyText, translatingLabel } = useTranslatedText(
    text,
    translationAvailability,
    tab,
    onDisplayChange,
  );

  const selectTab = useDefaultTranslationTab({
    text,
    enabled: foldGroupOpen && detailsOpen,
    plamoUrl: translationAvailability.plamoUrl,
    elementRef: detailsRef,
    setTab,
  });

  // Reconnect can replace a macOS daemon with a non-capable daemon, or one
  // without the plamo URL. The WS handshake clears both capabilities before
  // probing again, so an already-selected tab whose route went away must
  // return to original rather than show stale text.
  const tabOffered = isTranslationTabOffered(tab, translationAvailability);
  useEffect(() => {
    if (!tabOffered) setTab("original");
  }, [tabOffered]);

  return (
    <details
      ref={detailsRef}
      class="tl-fold tl-thinking"
      open={detailsOpen}
      onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
    >
      <FoldSummary ts={ts} label="thinking" open={detailsOpen} decoration={{ kind: "thinking" }} />
      <div class="tl-guided">
        <FoldGuide />
        {/* 本文の枠と足元の行を縦に積む (吹き出しの .tl-bubble と同じ形)。
         * 足元の行は枠の外、他の吹き出しと同じ段に置く。時刻は fold の
         * summary 行が持つので足元には出さない。 */}
        <div class="tl-thinking-frame">
          <div class="tl-thinking-body">
            <TranslatedScope tab={tab}>
              <LinkedMarkdownView
                source={bodyText}
                // ホスト/ブラウザ翻訳がかかっても probe 対象は常に原文 `text` に
                // 揃える (翻訳結果の inline code は原文と同一で、原文で網羅すれば
                // どのタブでも同じリンクが張れる、余計な probe も発生しない)。
                probeSource={text}
                ctx={filePathCtx}
                highlightWords={mdSearch?.words}
                onMatchClick={mdSearch?.onMatchClick}
              />
            </TranslatedScope>
            {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
          </div>
          <BubbleFooter
            translation={{ availability: translationAvailability, tab, onSelect: selectTab }}
          />
        </div>
      </div>
    </details>
  );
}

/** 吹き出しの本文の表示モード。吹き出しの足元のタブが 1 つ持ち、その中の
 * text segment 全部に同じモードが効く (応答・ユーザ発話の両方)。 */
interface BubbleBodyView {
  /** 応答は thinking と同じ判定 (DR-0049 §8、useDefaultTranslationTab)、
   * ユーザ発話は original を既定にバブルが決める。 */
  tab: TranslationTab;
  /** true = markdown を解釈せず原文のまま出す (コピペ用)。 */
  source: boolean;
}

/** 吹き出しの本文の markdown (応答・ユーザ発話・未送信の下書き・人のコメントで
 * 同じ描画、DR-0010 §6)。
 * session の filepath linker を繋ぐ (kawaz r46m62)。useContext の呼び場所を
 * 固定するための薄い wrapper (`SegmentView` の IIFE の中の JSX は component の
 * 境界にならない)。
 *
 * `view` が無い呼び出し (吹き出し外の assistant text) は原文の markdown 表示。
 * `commentText` は範囲選択でコメントを付けられる本文か (DR-0062 §2: 応答は
 * 付けられ、ユーザ発話は付けない)。source の間は付けない。 */
function BubbleMarkdownText({
  source,
  view,
  commentText,
  translationAvailability,
  onDisplayChange,
}: {
  source: string;
  view: BubbleBodyView | undefined;
  commentText: boolean;
  translationAvailability: TranslationAvailability;
  onDisplayChange?: (() => void) | undefined;
}) {
  const tab = view?.tab ?? "original";
  const { bodyText, translatingLabel } = useTranslatedText(
    source,
    translationAvailability,
    tab,
    onDisplayChange,
  );
  return (
    <>
      <BubbleBodyText
        bodyText={bodyText}
        originalText={source}
        tab={tab}
        source={view?.source === true}
        commentText={commentText}
      />
      {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
    </>
  );
}

/** 吹き出しの本文の今の綴り (`bodyText`) を md か source で描く。source の間は
 * 範囲選択のコメントの対象にしない (DR-0062 §2)。 */
function BubbleBodyText({
  bodyText,
  originalText,
  tab,
  source,
  commentText,
}: {
  bodyText: string;
  /** 訳す前の原文 (訳していなければ `bodyText` と同じ)。 */
  originalText: string;
  tab: TranslationTab;
  source: boolean;
  commentText: boolean;
}) {
  const filePathCtx = useContext(SessionFilePathCtxContext);
  return (
    <TranslatedScope tab={tab} commentText={commentText && !source}>
      {source ? (
        // source タブは「今表示している綴り」の生テキスト — 訳タブを選んだ
        // ままなら訳文の markdown ソースが出る (どちらを写したいかは選択済み)。
        <CopyablePreText class="tl-bubble-source" text={bodyText} />
      ) : (
        <LinkedMarkdownView
          source={bodyText}
          // 翻訳がかかっても probe 対象は原文に揃える (ThinkingSegment と同じ
          // 理由: 訳文の inline code は原文と同一)。
          probeSource={originalText}
          ctx={filePathCtx}
        />
      )}
    </TranslatedScope>
  );
}

/** 人が書いた文の吹き出し (未送信の下書き、人のコメント) の本文。送った後の
 * ユーザ発言の吹き出しと同じ描画 (DR-0010 §6) で、md は markdown、source は
 * 打たれた文字そのもの。訳のタブは持たない。`commentText` は範囲選択で
 * コメントを付けられる本文か (DR-0062 §2)。 */
export function UserWrittenText({
  text,
  source,
  commentText,
}: {
  text: string;
  source: boolean;
  commentText: boolean;
}) {
  return (
    <div class="tl-text tl-text-user">
      <BubbleBodyText
        bodyText={text}
        originalText={text}
        tab="original"
        source={source}
        commentText={commentText}
      />
    </div>
  );
}

/** 吹き出しの外のユーザ発話の文字 (システム由来の行の raw の表示など)。打たれた
 * 文字をそのまま出し、裸の URL と実在する絶対パスと `[label](target)` だけを
 * リンクにする。 */
function UserPlainText({ text }: { text: string }) {
  const filePathCtx = useContext(SessionFilePathCtxContext);
  return <LinkedPlainText text={text} ctx={filePathCtx} />;
}

export function SegmentView({
  segment,
  translationAvailability,
  ts,
  foldGroupOpen,
  searchKey,
  searchCtx,
  assistantView,
  userView,
}: {
  segment: Segment;
  translationAvailability: TranslationAvailability;
  // 親 TurnLine の ts (Segment 自体は持たない) — 表示形式統一タスクの
  // 「fold 対象アイテムは全て時刻を持つ」を満たすため各 fold summary に渡す。
  ts: string | null;
  foldGroupOpen: boolean;
  // In-view search (DR-0022 §3): this segment's own unit key + the shared
  // search context. `searchCtx` is undefined whenever Timeline has no active
  // query, in which case every branch below renders exactly as before this
  // DR (MarkdownView without highlightWords, plain <pre> text).
  searchKey: string;
  searchCtx: TLSearchCtx | undefined;
  /** assistant 吹き出しの足元のタブが決める本文の見せ方。吹き出しの外
   * (fold 内の assistant text) には無く、その場合は原文 markdown 表示。 */
  assistantView?: BubbleBodyView | undefined;
  /** user 吹き出しの足元のタブが決める本文の言語タブと見せ方。吹き出しの外
   * (システム由来の行の raw の表示) には無く、その場合は打たれた文字のまま
   * リンクだけを付けて出す。 */
  userView?: BubbleBodyView | undefined;
}) {
  const isMatch = searchCtx !== undefined && searchCtx.words.length > 0;
  // Highlighting is applied after render from this unit's DOM textContent.

  const content = (() => {
    switch (segment.kind) {
      case "text":
        // Markdown rendering (DR-0010): a response and a user's prompt in
        // their bubbles are drawn the same way (§6). A user's text outside a
        // bubble (a system-origin line's raw view) stays as typed, only its
        // URLs and paths linked.
        return (
          <div class={"tl-text tl-text-" + segment.role}>
            {segment.role === "assistant" ? (
              <BubbleMarkdownText
                source={segment.text}
                view={assistantView}
                commentText
                translationAvailability={translationAvailability}
                onDisplayChange={searchCtx?.notifyDisplayChange}
              />
            ) : userView !== undefined ? (
              <BubbleMarkdownText
                source={segment.text}
                view={userView}
                commentText={false}
                translationAvailability={translationAvailability}
                onDisplayChange={searchCtx?.notifyDisplayChange}
              />
            ) : (
              <UserPlainText text={segment.text} />
            )}
          </div>
        );
      case "thinking":
        return (
          <ThinkingSegment
            text={segment.text}
            ts={ts}
            translationAvailability={translationAvailability}
            foldGroupOpen={foldGroupOpen}
            mdSearch={undefined}
            onDisplayChange={searchCtx?.notifyDisplayChange}
          />
        );
      case "slash-command-prefix":
        // 引数付き slash command (`/clear <本文>`) の由来ラベル。本文は隣の
        // text segment が普通のユーザ発話として描くので、ここはどのコマンド
        // 経由で送られたかを小さく添えるだけ。
        return <div class="tl-slash-command-prefix">{segment.command}</div>;
      case "thinking-hidden":
        return <HiddenThinkingSegment reason={segment.reason} ts={ts} />;
      case "tool-use":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={"tool_use: " + segment.name} />
            <div class="tl-guided">
              <FoldGuide />
              <CopyablePreText class="tl-fold-body" text={JSON.stringify(segment.input, null, 2)} />
            </div>
          </details>
        );
      case "file-read":
        return <FileReadFold segment={segment} ts={ts} />;
      case "file-write":
      case "file-edit":
        return <FileChangeFold segment={segment} ts={ts} />;
      case "file-tool-result":
        return null;
      case "bash-use":
        return <BashUseFold segment={segment} ts={ts} />;
      case "bash-result":
        return segment.background ? <BashResultFold segment={segment} ts={ts} /> : null;
      case "agent-send":
        return (
          <AgentSendFold
            segment={segment}
            ts={ts}
            translationAvailability={translationAvailability}
          />
        );
      case "agent-spawn":
        return (
          <AgentSpawnFold
            segment={segment}
            ts={ts}
            translationAvailability={translationAvailability}
          />
        );
      case "tool-result":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={"tool_result" + (segment.isError ? " (error)" : "")} />
            <div class="tl-guided">
              <FoldGuide />
              <CopyablePreText class="tl-fold-body" text={segment.text} />
            </div>
          </details>
        );
      // Drawn in the reply's bubble (DR-0062 §12), not as a row of its own.
      case "comment-reply-result":
        return null;
      case "unknown-segment":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={segment.type} />
            <div class="tl-guided">
              <FoldGuide />
              <CopyablePreText class="tl-fold-body" text={JSON.stringify(segment.raw, null, 2)} />
            </div>
          </details>
        );
    }
  })();

  // Every enabled search candidate gets a DOM root so matching can use its
  // rendered textContent. `display: contents` keeps the wrapper out of layout.
  if (!isMatch || !searchCtx) return content;
  return (
    <div
      class="tl-search-unit"
      data-search-key={searchKey}
      ref={(el) => searchCtx.registerRef(searchKey, el)}
    >
      {content}
    </div>
  );
}
