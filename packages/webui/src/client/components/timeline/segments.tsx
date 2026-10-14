// turn の中の 1 segment (text / thinking / tool ...) の描画。
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { type Segment } from "../../transcript-model.ts";
import { LinkedMarkdownView } from "../../filepath-linker.tsx";
import { isTranslationSkippedText, hasCachedHostText } from "../../translate.ts";
import { type SearchWord } from "../../in-view-search.ts";
import { Tabs } from "../Tabs.tsx";
import { type TLSearchCtx } from "./useInViewSearch.ts";
import { SessionFilePathCtxContext, useCategoryOpen } from "./context.ts";
import { FoldGuide, FoldSummary } from "./folds.tsx";
import { FileToolFold, BashUseFold, BashResultFold } from "./tools.tsx";
import { AgentSendFold, AgentSpawnFold } from "./agents.tsx";
import {
  type TranslationAvailability,
  type TranslationTab,
  translationTabItems,
  useTranslatedText,
  enqueueViewportTranslation,
} from "./translation.ts";

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
  const translationStartedRef = useRef(false);
  const { bodyText, translatingLabel } = useTranslatedText(
    text,
    translationAvailability,
    tab,
    onDisplayChange,
  );

  const hostAvailable = translationAvailability.host;
  const browserAvailable = translationAvailability.browser;
  useEffect(() => {
    if (!foldGroupOpen || !detailsOpen || translationStartedRef.current) return;

    // The host route is the default comparison result when both are present: it
    // is the dictionary-like path this feature adds, while browser remains an
    // independently selectable comparison surface.
    const selectDefaultTranslation = () => {
      // 全段落が日本語等で翻訳 skip されるテキストは original のまま (kawaz
      // r38 mid=54) — 訳タブを選んでも内容が原文と同一で、確認クリックの
      // 無駄を生むだけ。
      if (isTranslationSkippedText(text)) return;
      if (hostAvailable) setTab("ja-host");
      else if (browserAvailable) setTab("ja-browser");
    };

    const startTranslation = () => {
      if (translationStartedRef.current) return;
      translationStartedRef.current = true;
      selectDefaultTranslation();
    };

    // Cache hits do not add daemon work, so retain the immediate display behavior
    // even when this thinking is outside the prefetch range.
    if (hostAvailable && hasCachedHostText(text)) {
      startTranslation();
      return;
    }

    const element = detailsRef.current;
    if (element === null || typeof IntersectionObserver === "undefined") {
      startTranslation();
      return;
    }

    const root = element.closest(".timeline-view");
    let cancelPending: (() => void) | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          cancelPending = enqueueViewportTranslation(element, startTranslation);
          observer.disconnect();
        }
      },
      {
        root,
        // Keep the active window bounded to the viewport plus roughly two
        // scroll-area heights before and after it.
        rootMargin: "200% 0px",
      },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelPending?.();
    };
  }, [foldGroupOpen, detailsOpen, text, hostAvailable, browserAvailable]);

  // Reconnect can replace a macOS daemon with a non-capable daemon. The WS
  // handshake clears host availability before probing the new process, so an
  // already-selected host tab must return to original rather than show stale text.
  useEffect(() => {
    if (tab === "ja-host" && !translationAvailability.host) setTab("original");
  }, [tab, translationAvailability.host]);

  const hasTranslationTab = translationAvailability.host || translationAvailability.browser;

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
        <div class="tl-thinking-body">
          {hasTranslationTab ? (
            <div class="tl-thinking-toolbar">
              {/* Only the offered translators get a tab — each one is a
               * separate capability of the host/browser (see
               * translationAvailability), so an unavailable one has no view to
               * show. 選択はタブ state を動かすだけで、その経路の翻訳は
               * useTranslatedText が必要になった時に起動する。 */}
              <Tabs
                class="tl-thinking-tabs"
                tabClass="tl-thinking-tab"
                label="本文の言語"
                selected={tab}
                onSelect={setTab}
                items={translationTabItems(translationAvailability)}
              />
            </div>
          ) : null}
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
          {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
        </div>
      </div>
    </details>
  );
}

/** assistant 応答本文の表示モード。バブルの hover ツールバーが 1 つ持ち、
 * その中の text segment 全部に同じモードが効く。 */
interface AssistantBodyView {
  /** 既定は常に "original" — thinking と違い自動で訳へ切り替えない
   * (kawaz r135m50: 応答本文は常に見えているので、訳は操作起点で足りる)。 */
  tab: TranslationTab;
  /** true = markdown を解釈せず原文のまま出す (コピペ用)。 */
  source: boolean;
}

/** Assistant markdown text with session-scoped filepath linkification wired
 * (kawaz r46m62). Small wrapper so the useContext hook has a stable
 * top-level call site (JSX inside `SegmentView`'s IIFE is not a component
 * boundary — extracting this keeps the rules-of-hooks contract obvious).
 *
 * `view` が無い呼び出し (吹き出し外の assistant text) は原文の markdown 表示。 */
function AssistantMarkdownText({
  source,
  view,
  translationAvailability,
  onDisplayChange,
}: {
  source: string;
  view: AssistantBodyView | undefined;
  translationAvailability: TranslationAvailability;
  onDisplayChange?: (() => void) | undefined;
}) {
  const filePathCtx = useContext(SessionFilePathCtxContext);
  const { bodyText, translatingLabel } = useTranslatedText(
    source,
    translationAvailability,
    view?.tab ?? "original",
    onDisplayChange,
  );
  return (
    <>
      {view?.source === true ? (
        // source タブは「今表示している綴り」の生テキスト — 訳タブを選んだ
        // ままなら訳文の markdown ソースが出る (どちらを写したいかは選択済み)。
        <pre class="tl-bubble-source">{bodyText}</pre>
      ) : (
        <LinkedMarkdownView
          source={bodyText}
          // 翻訳がかかっても probe 対象は原文に揃える (ThinkingSegment と同じ
          // 理由: 訳文の inline code は原文と同一)。
          probeSource={source}
          ctx={filePathCtx}
        />
      )}
      {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
    </>
  );
}

export function SegmentView({
  segment,
  translationAvailability,
  ts,
  foldGroupOpen,
  searchKey,
  searchCtx,
  assistantView,
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
  /** assistant 吹き出しの hover ツールバーが決める本文の見せ方。吹き出しの
   * 外 (fold 内の assistant text) には無く、その場合は原文 markdown 表示。 */
  assistantView?: AssistantBodyView | undefined;
}) {
  const isMatch = searchCtx !== undefined && searchCtx.words.length > 0;
  // Highlighting is applied after render from this unit's DOM textContent.

  const content = (() => {
    switch (segment.kind) {
      case "text":
        // Markdown rendering (DR-0010) is assistant-only: a user turn's text
        // is what the human actually typed, so it's shown verbatim rather than
        // interpreted as markdown syntax.
        return (
          <div class={"tl-text tl-text-" + segment.role}>
            {segment.role === "assistant" ? (
              <AssistantMarkdownText
                source={segment.text}
                view={assistantView}
                translationAvailability={translationAvailability}
                onDisplayChange={searchCtx?.notifyDisplayChange}
              />
            ) : (
              segment.text
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
              <pre class="tl-fold-body">{JSON.stringify(segment.input, null, 2)}</pre>
            </div>
          </details>
        );
      case "file-read":
      case "file-write":
      case "file-edit":
        return <FileToolFold segment={segment} ts={ts} />;
      case "file-tool-result":
        return null;
      case "bash-use":
        return <BashUseFold segment={segment} ts={ts} />;
      case "bash-result":
        return segment.background ? <BashResultFold segment={segment} ts={ts} /> : null;
      case "agent-send":
        return <AgentSendFold segment={segment} ts={ts} />;
      case "agent-spawn":
        return <AgentSpawnFold segment={segment} ts={ts} />;
      case "tool-result":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={"tool_result" + (segment.isError ? " (error)" : "")} />
            <div class="tl-guided">
              <FoldGuide />
              <pre class="tl-fold-body">{segment.text}</pre>
            </div>
          </details>
        );
      case "unknown-segment":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={segment.type} />
            <div class="tl-guided">
              <FoldGuide />
              <pre class="tl-fold-body">{JSON.stringify(segment.raw, null, 2)}</pre>
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
