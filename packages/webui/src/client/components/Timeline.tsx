// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionStatusSnapshot } from "@ccmsg/protocol";
import type { TimelineState } from "../store.ts";
import { ADMIN_ID } from "../store.ts";
import type { AgentRef } from "../locator.ts";
import { agentTimelineHref, fileHref, timelineHref } from "../locator.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";
import { errorMessage, formatClockTime, formatMsgTime } from "../utils.ts";
import { useNow } from "../useNow.ts";
import { miniSummaryLines } from "../session-status-view.ts";
import {
  agentCommunicationCount,
  ccmsgDedupKey,
  classifyBoundaryLine,
  foldGroupLabel,
  foldGroupNeedsOuterFold,
  groupTimelineLines,
  isSearchableSegment,
  splitFoldSubgroups,
  userNavTargets,
  lineByteOffsets,
  parseSystemMessageFields,
  parseTranscriptLine,
  resolveToolResults,
  type CcmsgMessage,
  type ParsedLine,
  type Segment,
  type SystemMessageRich,
  type TimelineEntry,
  type TurnLine,
  type UserMessageKind,
} from "../transcript-model.ts";
import { MarkdownView } from "../markdown-view.tsx";
import {
  highlightRenderedText,
  removeRenderedTextHighlights,
  setRenderedTextCurrent,
} from "../rendered-text-search.ts";
import {
  getPendingHostTranslationCount,
  isTranslationSkippedText,
  hasCachedHostThinkingText,
  hasTranslatorApi,
  subscribePendingHostTranslation,
  translateThinkingTextInBrowser,
  translateThinkingTextOnHost,
  type HostTranslateRequest,
} from "../translate.ts";
import {
  loopNextIndex,
  loopPrevIndex,
  parseSearchQuery,
  type SearchWord,
} from "../in-view-search.ts";
import { foldSummaryView, type FoldSummaryDecoration } from "../timeline-summary.ts";
import { agentDirectionMarker, peerMessagePresentation } from "../agent-communication-view.ts";
import { reindexStableSelection } from "../user-nav.ts";
import {
  defaultTimelineAutoOpen,
  foldGroupShouldAutoOpen,
  toggleTimelineAutoOpen,
  type TimelineAutoOpenSettings,
} from "../timeline-auto-open.ts";
import { SearchBar } from "./SearchBar.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { InlineDiffViewer, InlineFileViewer } from "./InlineFileViewer.tsx";

/**
 * In-view search context threaded down to every SegmentView (DR-0022 §3 —
 * "TL は text/thinking/tool セグメント"). Each Segment is one search "unit",
 * keyed `${offset}-${segIndex}` (offset = its TurnLine's byte offset, stable
 * across a "load older" prepend just like the 👤 nav's userTurnKeys —
 * segIndex disambiguates multiple segments sharing one line). Bundled into a
 * single object rather than five separate props so the FoldGroup/
 * ItemsSubFold/LineView/*Bubble prop-drilling chain only grows by one prop
 * per component.
 */
interface TLSearchCtx {
  words: SearchWord[];
  /** DOM ref registration for rendered-text matching and ↑/↓ navigation. */
  registerRef: (key: string, el: HTMLElement | null) => void;
}

/** Renders `text` as plain (non-markdown) content, splitting it into
 * highlighted pieces when `ctx` has an active query and this unit is a match
 * — used for tool_use/tool_result/unknown-segment `<pre>` bodies and user
 * (non-markdown) text segments. Assistant text/thinking go through
 * MarkdownView's own `highlightWords` prop instead (mdast text nodes need
 * the same splitting, but from inside the AST walk — see markdown-view.tsx). */
function HighlightedPlainText({
  text,
  ctx,
  unitKey,
}: {
  text: string;
  ctx: TLSearchCtx | undefined;
  unitKey: string;
}) {
  void ctx;
  void unitKey;
  return <>{text}</>;
}

// Live tail 自動スクロール追従 (U2 kawaz spec: 「ユーザが最下部付近を見ている
// 時だけ自動スクロール追従、上にスクロール中は追従しない」) の「最下部付近」
// のしきい値 (px)。ちょうど末端に張り付いていなくても数行分の余裕は追従対象
// にする、というよくあるチャット UI の慣習値。
const NEAR_BOTTOM_PX = 80;

// 表示形式の統一 (kawaz spec 2026-07-12): fold 対象アイテム (thinking/
// tool_use/tool_result/meta 行/システム由来 user メッセージ) は全て同一の
// 「▶ HH:MM:SS ラベル」1 行 summary + <details> 展開に統一する — 以前は meta
// 行だけこの形、tool_use/tool_result は「時刻の行」+「▶ ラベルの行」の 2 行、
// システム由来 user メッセージは fold すらされず時刻+チップ+本文全開、と
// 3 通りに割れていた (kawaz: 「時刻表示の位置や出る出ないが不規則」)。ts が
// null の行 (Segment 自体は ts を持たないので親 TurnLine の ts を渡す) は
// 時刻 span を省略して詰める。
/** 展開 fold の左端縦線ガイド (kawaz r17 mid=45,49): クリックすると最も近い
 * 祖先の <details> (= 自分が中身を描いている fold) を閉じ、summary 位置へ
 * スクロールバックする。DOM 走査 (closest) 方式なのは、この線を fold group /
 * items サブ fold / thinking / tool_use / tool_result / meta の全展開部で
 * 使い回すため — 各コンポーネントの open state を prop で配るより、閉じる
 * 対象を「線が属する details」と構造で決める方が一貫する (details の open
 * 属性除去は onToggle 経由で各コンポーネントの state にも同期される)。 */
function FoldGuide() {
  return (
    <button
      type="button"
      class="tl-fold-guide"
      title="この折り畳みを閉じる"
      aria-label="この折り畳みを閉じる"
      onClick={(e) => {
        const details = (e.currentTarget as HTMLElement).closest("details");
        if (!details) return;
        details.open = false;
        details.scrollIntoView({ block: "nearest" });
      }}
    />
  );
}

function FoldSummary({
  ts,
  label,
  open = false,
  decoration,
}: {
  ts: string | null;
  label: string;
  open?: boolean;
  decoration?: FoldSummaryDecoration;
}) {
  const view = foldSummaryView(label, open, decoration);
  return (
    <summary
      class={
        view.decoration ? `tl-decorated-summary tl-${view.decoration.kind}-summary` : undefined
      }
    >
      {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
      {view.decoration?.kind === "thinking" ? (
        <span class="tl-fold-label tl-summary-decoration">thinking</span>
      ) : view.decoration?.kind === "agent" ? (
        // agent-communication 3 タイプ (SendMessage / peer-message / Agent
        // spawn) は同型の閉サマリを持つ (kawaz r46m15): 「prefix + 方向 badge
        // + identicon + 名前」。TL リンクや model chip は閉サマリには出さない。
        <span class="tl-fold-label tl-summary-decoration">
          <span>{view.decoration.prefix}</span>
          {view.decoration.direction ? (
            <span class={`tl-direction-badge tl-direction-${view.decoration.direction}`}>
              {view.decoration.direction === "outbound" ? "→" : "←"}
            </span>
          ) : null}
          <AgentIdentity name={view.decoration.name} />
        </span>
      ) : view.decoration?.kind === "bash" || view.decoration?.kind === "task-notification" ? (
        <span class="tl-fold-label tl-summary-decoration">{view.label}</span>
      ) : (
        <span class="tl-fold-label">{view.label}</span>
      )}
    </summary>
  );
}

// エージェント識別子 (avatar + 名前)。href 解決時は名前クリックで TL 遷移
// (kawaz r46m15: 「名前クリックで良いんじゃないの?隣のセッションツリーは
// そうなんだし」)。fold の details toggle と両立させるため click は
// stopPropagation する。model があれば名前のすぐ右に淡色で並べる (Agent
// spawn 用。SendMessage / peer-message は model 情報を持たないので undefined
// で無表示)。
function AgentIdentity({ name, model }: { name: string; model?: string }) {
  const tlHref = useContext(AgentTimelineHrefsContext).get(name);
  return (
    <span class="tl-agent-identity">
      <Avatar seed={`agent:${name}`} size={18} />
      {tlHref ? (
        <a class="tl-agent-name-link" href={tlHref} onClick={(event) => event.stopPropagation()}>
          <strong>{name}</strong>
        </a>
      ) : (
        <strong>{name}</strong>
      )}
      {model ? <span class="tl-agent-model-inline">{model}</span> : null}
    </span>
  );
}

const AgentTimelineHrefsContext = createContext<ReadonlyMap<string, string>>(new Map());
const FileToolSidContext = createContext("");

interface TimelineAutoOpenContextValue {
  settings: TimelineAutoOpenSettings;
  revision: number;
}

const TimelineAutoOpenContext = createContext<TimelineAutoOpenContextValue>({
  settings: defaultTimelineAutoOpen(false),
  revision: 0,
});

function useCategoryOpen(category: "thinking" | "agent"): [boolean, (open: boolean) => void] {
  const { settings, revision } = useContext(TimelineAutoOpenContext);
  const [open, setOpen] = useState(settings[category]);
  useEffect(() => setOpen(settings[category]), [revision]);
  return [open, setOpen];
}

function fileToolLineRange(segment: Extract<Segment, { kind: "file-read" }>): {
  start: number;
  end: number;
} | null {
  if (segment.offset === null) return null;
  const start = Math.max(1, segment.offset);
  return { start, end: segment.limit === null ? start : start + Math.max(0, segment.limit - 1) };
}

function FileToolFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "file-read" | "file-write" | "file-edit" }>;
  ts: string | null;
}) {
  const sid = useContext(FileToolSidContext);
  const range = segment.kind === "file-read" ? fileToolLineRange(segment) : null;
  const suffix = range ? `:${range.start}-${range.end}` : "";
  const label = `${segment.kind === "file-read" ? "Read" : segment.kind === "file-write" ? "Write" : "Edit"} ${segment.path}${suffix}`;
  const [open, setOpen] = useState(false);
  return (
    <details
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary ts={ts} label={label} open={open} />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card">
          <a class="tl-file-tool-path" href={fileHref(sid, segment.path, range ?? undefined)}>
            {segment.path}
            {suffix}
          </a>
          {segment.kind === "file-edit" ? (
            <InlineDiffViewer oldText={segment.oldString} newText={segment.newString} />
          ) : (
            <InlineFileViewer
              path={segment.path}
              content={segment.kind === "file-write" ? segment.content : (segment.content ?? "")}
            />
          )}
          {segment.kind === "file-read" && segment.content === null ? (
            <p class="tl-file-tool-unavailable">読み取り結果は現在の読み込み範囲外です</p>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function bashAnchor(kind: "command" | "result", toolUseId: string): string {
  return `tl-bash-${kind}-${encodeURIComponent(toolUseId)}`;
}

function BashJumpLink({ target, children }: { target: string; children: string }) {
  return (
    <a
      class="tl-bash-link"
      href={`#${target}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(target)?.scrollIntoView({ block: "center" });
      }}
    >
      {children}
    </a>
  );
}

function BashUseFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "bash-use" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useState(false);
  const commandLabel = segment.description || segment.command.split("\n", 1)[0] || "command";
  const resultAnchor = bashAnchor("result", segment.toolUseId);
  return (
    <details
      id={bashAnchor("command", segment.toolUseId)}
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary
        ts={ts}
        label={`Bash ${commandLabel}`}
        open={open}
        decoration={{ kind: "bash" }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card tl-bash-card">
          <div class="tl-bash-description">command</div>
          <div class="tl-bash-command">
            <CodeBlock code={segment.command || "(空のコマンド)"} lang="bash" />
          </div>
          {segment.background ? (
            <div class="tl-bash-result-status">
              {segment.hasResult ? (
                <BashJumpLink target={resultAnchor}>結果へ</BashJumpLink>
              ) : (
                "実行中 / 結果なし"
              )}
            </div>
          ) : segment.result ? (
            <div class={"tl-bash-output" + (segment.result.isError ? " is-error" : "")}>
              <div class="tl-bash-output-label">{segment.result.isError ? "error" : "output"}</div>
              <pre>{segment.result.text || "(出力なし)"}</pre>
            </div>
          ) : (
            <div class="tl-bash-result-status">実行中 / 結果なし</div>
          )}
        </div>
      </div>
    </details>
  );
}

function BashResultFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "bash-result" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      id={bashAnchor("result", segment.toolUseId)}
      class="tl-fold tl-file-tool-fold"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary ts={ts} label={`Bash result${segment.isError ? " (error)" : ""}`} open={open} />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-file-tool-card tl-bash-card">
          {segment.hasCommand ? (
            <div class="tl-bash-result-status">
              <BashJumpLink target={bashAnchor("command", segment.toolUseId)}>
                コマンドへ
              </BashJumpLink>
            </div>
          ) : null}
          <div class={"tl-bash-output" + (segment.isError ? " is-error" : "")}>
            <pre>{segment.text || "(出力なし)"}</pre>
          </div>
        </div>
      </div>
    </details>
  );
}

function AgentCard({
  name,
  direction,
  badge,
  title,
  body,
  model,
}: {
  name: string;
  direction: "inbound" | "outbound";
  // "送信" / "受信" (SendMessage / peer-message) の位置。Agent spawn は同じ
  // 位置に "new" を置くことで「送受信ではなく新規起動」を表す (kawaz r46m15:
  // 「送信 とか 受信 でしょ、ならそこに置くべきは Agent なら new でしょ」)。
  badge: string;
  title?: string | null;
  body: string;
  // Agent spawn 用: モデル名は名前のすぐ右に淡色で並べる (kawaz r46m15:
  // 「モデル名は名前のすぐ右に置くとかで良いんじゃない?他の 2 エージェント
  // メッセージタイプのやつも」)。SendMessage / peer-message はモデル情報を
  // 持たないので undefined。
  model?: string;
}) {
  const marker = agentDirectionMarker(direction);
  return (
    <div class={`tl-agent-card tl-agent-${direction}`}>
      <div class="tl-agent-card-head">
        <span>{marker}</span>
        <AgentIdentity name={name} model={model} />
        <span class="tl-agent-badge">{badge}</span>
      </div>
      {title ? <div class="tl-agent-title">{title}</div> : null}
      {body ? <div class="tl-agent-body">{body}</div> : null}
    </div>
  );
}

function AgentSendFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "agent-send" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useCategoryOpen("agent");
  const label = `SendMessage → ${segment.to}`;
  return (
    <details
      class="tl-fold tl-agent-fold"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary
        ts={ts}
        label={label}
        open={open}
        decoration={{
          kind: "agent",
          prefix: "SendMessage",
          name: segment.to,
          direction: "outbound",
        }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <AgentCard
          name={segment.to}
          direction="outbound"
          badge={segment.messageType === "message" ? "送信" : segment.messageType}
          title={segment.summary}
          body={segment.message}
        />
      </div>
    </details>
  );
}

/* Agent tool 起動 (spawn) は SendMessage / peer-message と同型 fold として
 * 描画する (kawaz r46m15): 閉サマリは「Agent → name」(SendMessage 同形式)、
 * カード内は → マーカー + 名前クリックで TL 遷移 + 名前右にモデル。
 * 「送信 / 受信」バッジ位置には spawn を示す "new" を置く。
 * agentType / background は既存の badge 文字列に含まれる情報だが、new に
 * 譲るため title 直前のメタ行に降ろす (description が本文の主タイトル)。 */
function AgentSpawnFold({
  segment,
  ts,
}: {
  segment: Extract<Segment, { kind: "agent-spawn" }>;
  ts: string | null;
}) {
  const [open, setOpen] = useCategoryOpen("agent");
  const typeMeta = `${segment.agentType || "agent"}${segment.background ? " · background" : ""}`;
  const combinedTitle = segment.description ? `${typeMeta} — ${segment.description}` : typeMeta;
  return (
    <details
      class="tl-fold tl-agent-fold"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary
        ts={ts}
        label={`Agent → ${segment.name}`}
        open={open}
        decoration={{
          kind: "agent",
          prefix: "Agent",
          name: segment.name,
          direction: "outbound",
        }}
      />
      <div class="tl-guided">
        <FoldGuide />
        <AgentCard
          name={segment.name}
          direction="outbound"
          badge="new"
          model={segment.model || undefined}
          title={combinedTitle}
          body={segment.prompt}
        />
      </div>
    </details>
  );
}

// thinking 翻訳比較タブ (DR-0023): original は常に基準面、host/browser
// は各経路が利用可能な時だけ追加する。両翻訳経路とも `\n\n` 単位で段落分割し、
// 日本語を含む段落を保持して英語段落だけを翻訳する。
interface TranslationAvailability {
  host: boolean;
  browser: boolean;
  // translateThinkingTextOnHost が英語段落ごとに 1 op を送るための
  // ws.translate ラッパ。複数 thinking・複数段落をまとめず、各 op を独立して
  // 並列実行する (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  hostRequest: HostTranslateRequest;
}

type ThinkingTab = "original" | "ja-host" | "ja-browser";

const pendingViewportTranslations = new Map<Element, () => void>();
let viewportTranslationFrame: number | null = null;

function distanceFromViewport(element: Element): number {
  const root = element.closest(".timeline-view");
  const rootRect = root?.getBoundingClientRect() ?? {
    top: 0,
    bottom: globalThis.innerHeight,
  };
  const rect = element.getBoundingClientRect();
  if (rect.bottom < rootRect.top) return rootRect.top - rect.bottom;
  if (rect.top > rootRect.bottom) return rect.top - rootRect.bottom;
  return 0;
}

function enqueueViewportTranslation(element: Element, start: () => void): () => void {
  pendingViewportTranslations.set(element, start);
  if (viewportTranslationFrame === null) {
    viewportTranslationFrame = requestAnimationFrame(() => {
      viewportTranslationFrame = null;
      const pending = [...pendingViewportTranslations.entries()];
      pendingViewportTranslations.clear();
      pending
        .sort(([a], [b]) => distanceFromViewport(a) - distanceFromViewport(b))
        .forEach(([, run]) => run());
    });
  }
  return () => pendingViewportTranslations.delete(element);
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
}: {
  text: string;
  ts: string | null;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
  mdSearch: { words: SearchWord[]; onMatchClick: () => void } | undefined;
}) {
  const [tab, setTab] = useState<ThinkingTab>("original");
  const [hostText, setHostText] = useState<string | null>(null);
  const [browserText, setBrowserText] = useState<string | null>(null);
  const [hostTranslating, setHostTranslating] = useState(false);
  const [browserTranslating, setBrowserTranslating] = useState(false);
  const [detailsOpen, setDetailsOpen] = useCategoryOpen("thinking");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const translationStartedRef = useRef(false);

  const changeTab = useCallback((next: ThinkingTab) => {
    setTab(next);
  }, []);

  function selectHost() {
    if (!translationAvailability.host) return;
    changeTab("ja-host");
    if (hostText !== null || hostTranslating) return;
    setHostTranslating(true);
    void translateThinkingTextOnHost(text, translationAvailability.hostRequest)
      .then((result) => setHostText(result))
      .catch(() => setHostText(text))
      .finally(() => setHostTranslating(false));
  }

  function selectBrowser() {
    if (!translationAvailability.browser) return;
    changeTab("ja-browser");
    if (browserText !== null || browserTranslating) return;
    setBrowserTranslating(true);
    void translateThinkingTextInBrowser(text).then((result) => {
      setBrowserText(result);
      setBrowserTranslating(false);
    });
  }

  // The host route is the default comparison result when both are present: it
  // is the dictionary-like path this feature adds, while browser remains an
  // independently selectable comparison surface.
  function selectDefaultTranslation() {
    // 全段落が日本語等で翻訳 skip されるテキストは original のまま (kawaz
    // r38 mid=54) — 訳タブを選んでも内容が原文と同一で、確認クリックの
    // 無駄を生むだけ。
    if (isTranslationSkippedText(text)) return;
    if (translationAvailability.host) selectHost();
    else if (translationAvailability.browser) selectBrowser();
  }

  useEffect(() => {
    if (!foldGroupOpen || !detailsOpen || translationStartedRef.current) return;

    const startTranslation = () => {
      if (translationStartedRef.current) return;
      translationStartedRef.current = true;
      selectDefaultTranslation();
    };

    // Cache hits do not add daemon work, so retain the immediate display behavior
    // even when this thinking is outside the prefetch range.
    if (translationAvailability.host && hasCachedHostThinkingText(text)) {
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
  }, [
    foldGroupOpen,
    detailsOpen,
    text,
    translationAvailability.host,
    translationAvailability.browser,
  ]);

  // Reconnect can replace a macOS daemon with a non-capable daemon. The WS
  // handshake clears host availability before probing the new process, so an
  // already-selected host tab must return to original rather than show stale text.
  useEffect(() => {
    if (tab === "ja-host" && !translationAvailability.host) setTab("original");
  }, [tab, translationAvailability.host]);

  const bodyText =
    tab === "ja-host" && hostText !== null
      ? hostText
      : tab === "ja-browser" && browserText !== null
        ? browserText
        : text;

  const hasTranslationTab = translationAvailability.host || translationAvailability.browser;
  const translating =
    (tab === "ja-host" && hostTranslating && hostText === null) ||
    (tab === "ja-browser" && browserTranslating && browserText === null);

  // 翻訳中の進捗表示 (kawaz r38 m94,95): 「翻訳中… 3s (待ち 5)」の形で、
  // リクエストを投げてからの経過秒と host 経路の未完了段落数を出す。固まっ
  // ているのか妥当な待ちなのかの判断材料。
  const [translationStartedAt, setTranslationStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingHostQueue, setPendingHostQueue] = useState(() => getPendingHostTranslationCount());
  useEffect(() => {
    if (!translating) {
      setTranslationStartedAt(null);
      return;
    }
    setTranslationStartedAt(Date.now());
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [translating]);
  // pending counter は host 段落 request の増減で発火する。translating 中だけ
  // 購読する (それ以外は表示に使わない) — dormant segment の常時購読で無駄な
  // re-render を積まないため。
  useEffect(() => {
    if (!translating) return;
    setPendingHostQueue(getPendingHostTranslationCount());
    return subscribePendingHostTranslation(() =>
      setPendingHostQueue(getPendingHostTranslationCount()),
    );
  }, [translating]);
  const translatingLabel = (() => {
    if (!translating) return null;
    const parts = ["翻訳中…"];
    if (translationStartedAt !== null) {
      parts.push(`${Math.max(0, Math.floor((nowMs - translationStartedAt) / 1000))}s`);
    }
    // 待ちキューは host 経路のみ意味を持つ (browser は local API、直列でない)。
    if (tab === "ja-host" && pendingHostQueue > 0) parts.push(`(待ち ${pendingHostQueue})`);
    return parts.join(" ");
  })();

  return (
    <details
      ref={detailsRef}
      class="tl-fold tl-thinking"
      open={detailsOpen}
      onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary ts={ts} label="thinking" open={detailsOpen} decoration={{ kind: "thinking" }} />
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-thinking-body">
          {hasTranslationTab ? (
            <div class="tl-thinking-toolbar">
              <div class="tl-thinking-tabs">
                <button
                  type="button"
                  class={"tl-thinking-tab" + (tab === "original" ? " active" : "")}
                  onClick={() => changeTab("original")}
                >
                  original
                </button>
                {translationAvailability.host ? (
                  <button
                    type="button"
                    class={"tl-thinking-tab" + (tab === "ja-host" ? " active" : "")}
                    onClick={selectHost}
                  >
                    ja(host)
                  </button>
                ) : null}
                {translationAvailability.browser ? (
                  <button
                    type="button"
                    class={"tl-thinking-tab" + (tab === "ja-browser" ? " active" : "")}
                    onClick={selectBrowser}
                  >
                    ja(browser)
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <MarkdownView
            source={bodyText}
            highlightWords={mdSearch?.words}
            onMatchClick={mdSearch?.onMatchClick}
          />
          {translatingLabel ? <p class="tl-thinking-translating">{translatingLabel}</p> : null}
        </div>
      </div>
    </details>
  );
}

function SegmentView({
  segment,
  translationAvailability,
  ts,
  foldGroupOpen,
  searchKey,
  searchCtx,
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
              <MarkdownView source={segment.text} />
            ) : (
              <HighlightedPlainText text={segment.text} ctx={searchCtx} unitKey={searchKey} />
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
          />
        );
      case "tool-use":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={"tool_use: " + segment.name} />
            <div class="tl-guided">
              <FoldGuide />
              <pre class="tl-fold-body">
                <HighlightedPlainText
                  text={JSON.stringify(segment.input, null, 2)}
                  ctx={searchCtx}
                  unitKey={searchKey}
                />
              </pre>
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
              <pre class="tl-fold-body">
                <HighlightedPlainText text={segment.text} ctx={searchCtx} unitKey={searchKey} />
              </pre>
            </div>
          </details>
        );
      case "unknown-segment":
        return (
          <details class="tl-fold">
            <FoldSummary ts={ts} label={segment.type} />
            <div class="tl-guided">
              <FoldGuide />
              <pre class="tl-fold-body">
                <HighlightedPlainText
                  text={JSON.stringify(segment.raw, null, 2)}
                  ctx={searchCtx}
                  unitKey={searchKey}
                />
              </pre>
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

// システム由来 user メッセージの rich 表示 (U2 kawaz spec): transcript-model.ts's
// parseSystemMessageFields が返す SystemMessageRich の 3 レイアウトを描画する
// だけの純表示コンポーネント — パース自体は行わない (ロジックは transcript-
// model.ts 側でユニットテスト可能に保つ、他の *-model.ts / Timeline.tsx の
// 分業と同じ)。"event" フィールドだけ等幅フォントを当てる (kawaz spec:
// 「event 本文は monospace で」) — task-notification 以外の kind がたまたま
// 同名フィールドを持つことは想定していないが、フィールド名一致だけで判定する
// のでどの kind から来ても等幅になる (副作用として無害)。
type PeerMessageRich = Extract<SystemMessageRich, { display: "peer" }>;

// idle 通知は operational noise (kawaz r46m6: 「でしゃばらせるな」)。
// 通常 peer メッセージのような decorated fold / AgentCard には流さず、
// 閉じた <details> の compact 行に demote する — 第 1 層 (Timeline 直下 /
// 展開済み fold 内) では時刻 + 淡色の "idle {from}" のみを見せて、body
// (実際の通知テキスト) は summary を開いたときだけ表示する。
function IdlePeerRow({ peer, ts }: { peer: PeerMessageRich; ts: string | null }) {
  const presentation = peerMessagePresentation(peer);
  if (presentation.kind !== "idle") return null;
  return (
    <details class="tl-line tl-fold tl-agent-idle">
      <summary>
        {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
        <span class="tl-agent-idle-label">
          <span class="tl-agent-idle-kind">idle</span>
          <span class="tl-agent-idle-from">{peer.from}</span>
        </span>
      </summary>
      <div class="tl-agent-idle-body">{presentation.text}</div>
    </details>
  );
}

function SystemMessageRichView({ rich }: { rich: SystemMessageRich }) {
  switch (rich.display) {
    case "fields":
      return (
        <div class="tl-sysmsg-fields">
          {rich.heading === null && rich.fields.length === 0 ? (
            <span class="tl-empty-turn">(フィールドなし)</span>
          ) : (
            <dl class="tl-sysmsg-dl">
              {rich.heading ? (
                <div class="tl-sysmsg-field">
                  <dt>summary</dt>
                  <dd>{rich.heading}</dd>
                </div>
              ) : null}
              {rich.fields.map((f, i) => (
                <div class="tl-sysmsg-field" key={i}>
                  <dt>{f.name}</dt>
                  <dd class={f.name === "event" ? "tl-sysmsg-mono" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      );
    case "chip":
      return (
        <div class="tl-sysmsg-chip-row">
          <span class="tl-sysmsg-chip">{rich.label}</span>
          {rich.detail ? <span class="tl-sysmsg-chip-detail">{rich.detail}</span> : null}
        </div>
      );
    case "peer": {
      const presentation = peerMessagePresentation(rich);
      if (presentation.kind === "idle") return <IdlePeerRow peer={rich} ts={null} />;
      return (
        <AgentCard
          name={rich.from}
          direction="inbound"
          badge={presentation.badge}
          title={rich.summary}
          body={rich.body}
        />
      );
    }
    case "text":
      return <pre class="tl-fold-body">{rich.text}</pre>;
  }
}

// rich|raw タブ (U2 kawaz spec: 「ccmsg 吹き出しの msg/raw タブと同じ UI
// 流儀」、デフォルト rich) — LineView の sysKind 分岐 (システム由来 user
// メッセージの details 本文) から呼ばれる。raw タブは変更前と全く同じ描画
// (segments.map + SegmentView) を保つことで、rich 側のパースが空振りしても
// 元の情報は raw タブから必ず参照できる ("壊れた入力は raw fallback" 要件)。
function systemMessageRawText(line: TurnLine): string {
  return line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
}

function SystemMessageBody({
  kind,
  line,
  translationAvailability,
  foldGroupOpen,
}: {
  kind: UserMessageKind;
  line: TurnLine;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
}) {
  const [tab, setTab] = useState<"rich" | "raw">("rich");
  // extractCcmsgMessages (transcript-model.ts) が使うのと同じ「text segment
  // だけを \n 結合」の抽出 — tool-result/unknown-segment 主体の line (例:
  // userMessageKind "tool-result") では空文字列になり、rich タブは text
  // フォールバックで空表示になるが、raw タブ側は元通り全 segment を描画する
  // ので情報は失われない。
  const rawText = useMemo(() => systemMessageRawText(line), [line.segments]);
  const rich = useMemo(() => parseSystemMessageFields(kind, rawText), [kind, rawText]);

  return (
    <div class="tl-sysmsg">
      <div class="tl-thinking-tabs">
        <button
          type="button"
          class={"tl-thinking-tab" + (tab === "rich" ? " active" : "")}
          onClick={() => setTab("rich")}
        >
          rich
        </button>
        <button
          type="button"
          class={"tl-thinking-tab" + (tab === "raw" ? " active" : "")}
          onClick={() => setTab("raw")}
        >
          raw
        </button>
      </div>
      {tab === "rich" ? (
        <SystemMessageRichView rich={rich} />
      ) : (
        <div class="tl-fold-body tl-segments">
          {line.segments.length === 0 ? (
            <span class="tl-empty-turn">(空)</span>
          ) : (
            line.segments.map((seg, i) => (
              // システム由来メッセージの raw タブ / ccmsg 生テキストは in-view
              // search のスコープ外 (DR-0022 §3 は「TL は text/thinking/tool
              // セグメント」— 境界の 3 種チャットバブルとその fold 群を指し、
              // 折り畳み済み system メッセージの raw fallback までは対象に
              // 含めていない解釈)。searchCtx を渡さず不参加にする。
              <SegmentView
                key={i}
                segment={seg}
                translationAvailability={translationAvailability}
                ts={null}
                foldGroupOpen={foldGroupOpen}
                searchKey={`sysraw-${i}`}
                searchCtx={undefined}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SystemMessageFold({
  kind,
  line,
  translationAvailability,
  foldGroupOpen,
}: {
  kind: UserMessageKind;
  line: TurnLine;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useCategoryOpen("agent");
  const rich = useMemo(
    () => parseSystemMessageFields(kind, systemMessageRawText(line)),
    [kind, line.segments],
  );
  const peer = rich.display === "peer" ? rich : null;
  const idlePeer = peer?.category === "idle" ? peer : null;
  if (idlePeer) return <IdlePeerRow peer={idlePeer} ts={line.ts} />;
  const open = peer ? agentOpen : manualOpen;
  const setOpen = peer ? setAgentOpen : setManualOpen;
  const taskSummary =
    kind === "task-notification" && rich.display === "fields" ? rich.heading : null;
  // kind 文字列は internal enum なので UI に出す時だけ人間可読形へ (現状
  // spawn-prompt のみ special-case、他 kind は enum ラベルのまま踏襲)。
  const kindLabel = kind === "spawn-prompt" ? "spawn prompt" : kind;
  const label = peer
    ? `${kindLabel} ← ${peer.from}`
    : taskSummary && !open
      ? `${kindLabel} ${taskSummary}`
      : kindLabel;
  const decoration: FoldSummaryDecoration | undefined = peer
    ? { kind: "agent", prefix: kindLabel, name: peer.from, direction: "inbound" }
    : taskSummary
      ? { kind: "task-notification" }
      : undefined;
  return (
    <details
      class={peer ? "tl-line tl-fold tl-agent-fold" : "tl-line tl-fold"}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <FoldSummary ts={line.ts} label={label} open={open} decoration={decoration} />
      {peer ? (
        <div class="tl-guided">
          <FoldGuide />
          <div class="tl-guided-content">
            <SystemMessageBody
              kind={kind}
              line={line}
              translationAvailability={translationAvailability}
              foldGroupOpen={foldGroupOpen}
            />
          </div>
        </div>
      ) : (
        <SystemMessageBody
          kind={kind}
          line={line}
          translationAvailability={translationAvailability}
          foldGroupOpen={foldGroupOpen}
        />
      )}
    </details>
  );
}

// fold group 内 (非境界) の 1 entry を描画する — thinking/tool_use-only の
// assistant turn、tool-result-only の user turn、meta 行、broken 行、
// そしてシステム由来 user メッセージ (ccmsg メッセージを含まないもの、含む
// 場合は境界として CcmsgBubble 側に回る) を扱う。境界行 (本物のユーザ発話/
// アシスタント最終応答/ccmsg メッセージ) は Timeline() 側の
// UserPromptBubble/AssistantBubble/CcmsgBubble が担当するため、
// registerUserTurnRef はここでは不要 (fold group 内に isUserTextTurn な行は
// 絶対に来ない — classifyBoundaryLine が boundary として弾くため)。
function LineView({
  line,
  offset,
  translationAvailability,
  foldGroupOpen,
  searchCtx,
}: {
  line: ParsedLine;
  // このエントリの byte offset — search unit key (`${offset}-${segIndex}`)
  // の組み立てに使う (DR-0022 §3)。
  offset: number;
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
  searchCtx: TLSearchCtx | undefined;
}) {
  if (line.kind === "broken") {
    return (
      <div class="tl-line tl-broken">
        <pre class="tl-broken-raw">{line.raw || "(空行)"}</pre>
      </div>
    );
  }
  if (line.kind === "meta") {
    return (
      <details class="tl-line tl-fold">
        <FoldSummary ts={line.ts} label={line.summary} />
        <pre class="tl-fold-body">{line.raw}</pre>
      </details>
    );
  }
  // システム由来の "type:user" メッセージ分類 (U2 kawaz spec,
  // transcript-model.ts's classifyUserMessage): role:"user" かつ
  // "user-prompt" (= 本物のユーザ発話) 以外の kind が付いているラインは
  // 表示形式統一タスクで details 化 (以前は常時全文表示だった —
  // kawaz: 「task-notification が fold されてない」)。summary は
  // 「▶ HH:MM:SS <kind>」形式 (kind をそのままラベルに)。本文は
  // SystemMessageBody の rich|raw タブに委譲 (U2 リッチ表示タスク)。
  const sysKind =
    line.role === "user" && line.userMessageKind && line.userMessageKind !== "user-prompt"
      ? line.userMessageKind
      : null;
  if (sysKind) {
    return (
      <SystemMessageFold
        kind={sysKind}
        line={line}
        translationAvailability={translationAvailability}
        foldGroupOpen={foldGroupOpen}
      />
    );
  }
  // 残り: thinking/tool_use-only の assistant turn、tool-result-only の
  // user turn — 中身の各 segment 自体が (SegmentView 経由で) fold 済みの
  // 1 行 summary を持つので、turn の外枠はプレーンな container のまま
  // (二重に時刻を出さない)。
  return (
    <div class="tl-line">
      <div class="tl-segments">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView
              key={i}
              segment={seg}
              translationAvailability={translationAvailability}
              ts={line.ts}
              foldGroupOpen={foldGroupOpen}
              searchKey={`${offset}-${i}`}
              searchCtx={searchCtx}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Tools folding (kawaz spec): the run of thinking/tool_use/tool_result/meta
// entries between a user prompt and the assistant's next user-facing final
// response, collapsed into one <details> — default-collapsed via the native
// <details> element itself (no manual open/close state to manage, matches
// every other tl-fold in this file), label text from
// transcript-model.ts's foldGroupLabel (grouping/counting stays a pure,
// unit-tested function; this component only renders it). Open state is
// lifted into React state (rather than left fully uncontrolled) so it can be
// threaded down to each entry's ThinkingSegment as `foldGroupOpen` — the
// signal that drives the "fold を開いた時 thinking は details open + ja
// デフォルト" behavior (kawaz spec).
function FoldGroup({
  entries,
  translationAvailability,
  searchCtx,
}: {
  entries: TimelineEntry[];
  translationAvailability: TranslationAvailability;
  searchCtx: TLSearchCtx | undefined;
}) {
  const autoOpen = useContext(TimelineAutoOpenContext);
  const groupAutoOpen = foldGroupShouldAutoOpen(entries, autoOpen.settings);
  const [open, setOpen] = useState(groupAutoOpen);
  useEffect(() => setOpen(groupAutoOpen), [autoOpen.revision]);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  // 展開時の中身は thinking / agent 通信で tool run を区切る。thinking と
  // agent 通信は外側 fold の直下、間の tool 群は「N items」のサブ fold に
  // 畳む。分割は pure function (transcript-model.ts) 側で単体テスト済み。
  const subgroups = useMemo(() => splitFoldSubgroups(entries), [entries]);
  const thinkingCount = useMemo(
    () =>
      entries.filter(
        ({ line }) =>
          line.kind === "turn" && line.segments.some((segment) => segment.kind === "thinking"),
      ).length,
    [entries],
  );
  const agentMessageCount = useMemo(
    () => entries.reduce((count, entry) => count + agentCommunicationCount(entry), 0),
    [entries],
  );
  const itemCount = useMemo(
    () =>
      subgroups.reduce(
        (count, subgroup) => count + (subgroup.kind === "items" ? subgroup.entries.length : 0),
        0,
      ),
    [subgroups],
  );
  if (!foldGroupNeedsOuterFold(entries)) {
    return (
      <div class="tl-guided-content">
        {subgroups.map((subgroup) =>
          subgroup.kind === "direct" ? (
            <LineView
              key={subgroup.entry.offset}
              line={subgroup.entry.line}
              offset={subgroup.entry.offset}
              translationAvailability={translationAvailability}
              foldGroupOpen={true}
              searchCtx={searchCtx}
            />
          ) : (
            <ItemsSubFold
              key={subgroup.entries[0]!.offset}
              entries={subgroup.entries}
              translationAvailability={translationAvailability}
              foldGroupOpen={false}
              searchCtx={searchCtx}
            />
          ),
        )}
      </div>
    );
  }
  return (
    <details
      ref={detailsRef}
      class="tl-line tl-fold-group"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      {/* summary の「N thinking」部だけ thinking と同じ装飾 (kawaz r17
       * mid=47): 展開せずとも thinking の在処 (紫破線トーン) が判る。文言は
       * foldGroupLabel (単体テスト済み) と同じ順序で、装飾のために span を
       * 分けて組み立てる。 */}
      {/* 「N agent messages」部も同様に agent カードと同じ破線トーンで囲う
       * (kawaz r38 mid=21)。 */}
      <summary>
        {thinkingCount > 0 || agentMessageCount > 0 ? (
          <>
            {thinkingCount > 0 ? (
              <span class="tl-summary-thinkings">{thinkingCount} thinking</span>
            ) : null}
            {agentMessageCount > 0 ? (
              <>
                {thinkingCount > 0 ? " + " : ""}
                <span class="tl-summary-agent-messages">{agentMessageCount} agent messages</span>
              </>
            ) : null}
            {itemCount > 0 ? ` + ${itemCount} items` : ""}
          </>
        ) : (
          foldGroupLabel(entries)
        )}
      </summary>
      <div class="tl-fold-group-body tl-guided">
        <FoldGuide />
        <div class="tl-guided-content">
          {subgroups.map((sg) =>
            sg.kind === "direct" ? (
              <LineView
                key={sg.entry.offset}
                line={sg.entry.line}
                offset={sg.entry.offset}
                translationAvailability={translationAvailability}
                foldGroupOpen={open}
                searchCtx={searchCtx}
              />
            ) : (
              <ItemsSubFold
                key={sg.entries[0]!.offset}
                entries={sg.entries}
                translationAvailability={translationAvailability}
                foldGroupOpen={open}
                searchCtx={searchCtx}
              />
            ),
          )}
        </div>
      </div>
    </details>
  );
}

/** FoldGroup 展開時の thinking 間 tool 群サブ fold (kawaz r17 mid=45)。
 * 既定は閉。こちらにも縦線クリック閉じを付ける (ネスト側の「| |」相当)。 */
function ItemsSubFold({
  entries,
  translationAvailability,
  foldGroupOpen,
  searchCtx,
}: {
  entries: TimelineEntry[];
  translationAvailability: TranslationAvailability;
  foldGroupOpen: boolean;
  searchCtx: TLSearchCtx | undefined;
}) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  // 「1 items」だけの subfold は開く手間が無駄 (kawaz r38 mid=44) — fold 層を
  // 作らず中身 (それ自体が tool カード等の fold を持つ) を直接引き上げる。
  if (entries.length === 1) {
    const { offset, line } = entries[0]!;
    return (
      <LineView
        line={line}
        offset={offset}
        translationAvailability={translationAvailability}
        foldGroupOpen={foldGroupOpen}
        searchCtx={searchCtx}
      />
    );
  }
  return (
    <details
      ref={detailsRef}
      class="tl-fold tl-items-subfold"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>{entries.length} items</summary>
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-guided-content">
          {entries.map(({ offset, line }) => (
            <LineView
              key={offset}
              line={line}
              offset={offset}
              translationAvailability={translationAvailability}
              foldGroupOpen={foldGroupOpen}
              searchCtx={searchCtx}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

// --- 境界行の吹き出し表示 (kawaz spec: 「timeline のユーザプロンプトと
// エージェントアウトプットは ROOM のチャットに寄せた表現にしたい」) ---
// 吹き出しになるのは 3 種のみ: 本物のユーザプロンプト (右寄せ, 緑系) /
// メインセッションのアシスタント最終応答 (左寄せ) / ccmsg メッセージを含む
// システムメッセージ (左寄せ, 第三者カラー)。見た目は ROOM チャット
// (TimelineItem.tsx の .msg 表示) の角丸・背景・メタ行構成に寄せるが、
// ROOM 側のコードそのものは参照のみで変更しない (app.css に .tl-bubble-*
// として別定義)。

function UserPromptBubble({
  line,
  offsetKey,
  navKey,
  registerUserTurnRef,
  translationAvailability,
  now,
  searchCtx,
  onUserTurnClick,
  selected,
}: {
  line: TurnLine;
  offsetKey: number;
  navKey: string;
  // "👤 N/M" nav indicator の DOM 測定対象として登録する — 実ユーザ発話
  // (isUserTextTurn) はこの吹き出し以外の経路には現れないので、fold-inner
  // 側 (LineView) はこの登録を一切行わない。
  registerUserTurnRef: (key: string, el: HTMLDivElement | null) => void;
  translationAvailability: TranslationAvailability;
  now: number;
  searchCtx: TLSearchCtx | undefined;
  // 👤 nav のクリック同期 (DR-0022 §2.2 の仕様を 👤 nav にも共通化): この吹き
  // 出しをクリックすると、スクロールなしで currentUserIdx をその位置に合わせる。
  onUserTurnClick: (navKey: string) => void;
  selected: boolean;
}) {
  return (
    <div
      class={`tl-bubble tl-bubble-right${selected ? " tl-bubble-user-nav-selected" : ""}`}
      ref={(el) => registerUserTurnRef(navKey, el)}
      onClick={() => onUserTurnClick(navKey)}
    >
      <div class="tl-bubble-body tl-bubble-body-user">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView
              key={i}
              segment={seg}
              translationAvailability={translationAvailability}
              ts={line.ts}
              foldGroupOpen={false}
              searchKey={`${offsetKey}-${i}`}
              searchCtx={searchCtx}
            />
          ))
        )}
      </div>
      {/* 右寄せ吹き出しは時刻も右に揃える (kawaz: 「ユーザメッセージは右に
       * あるのに時刻が左」)。 */}
      {line.ts ? <span class="tl-bubble-time">{formatMsgTime(line.ts, now)}</span> : null}
    </div>
  );
}

function AssistantBubble({
  line,
  offset,
  translationAvailability,
  now,
  searchCtx,
}: {
  line: TurnLine;
  offset: number;
  translationAvailability: TranslationAvailability;
  now: number;
  searchCtx: TLSearchCtx | undefined;
}) {
  return (
    <div class="tl-bubble tl-bubble-left tl-bubble-assistant">
      <div class="tl-bubble-body">
        {line.segments.map((seg, i) => (
          <SegmentView
            key={i}
            segment={seg}
            translationAvailability={translationAvailability}
            ts={line.ts}
            foldGroupOpen={false}
            searchKey={`${offset}-${i}`}
            searchCtx={searchCtx}
          />
        ))}
      </div>
      {line.ts ? <span class="tl-bubble-time">{formatMsgTime(line.ts, now)}</span> : null}
    </div>
  );
}

// DR-0027 §2 (Phase 1 lazy read cache): the daemon holds the canonical full
// message body in rooms/*.jsonl — transcript-model.ts's extraction only
// promises (room, mid, from, ts) + a best-effort recovered body (a truncated
// fragment's partial text, or the full text if it fit under the harness's
// notification size cap). CcmsgBubble looks the canonical body up with
// `ws.read(room, [mid])` on mount and swaps it in, so a "…(切り詰め)"
// fallback gets replaced by the real full text and a tool_result-detected
// send (Phase 2, from/msg initially empty) fills in from what the daemon
// actually stored.
//
// Cache lives at module scope, not store, per DR-0027's "実物の流儀で判断"
// bracket: this is a read-through of a daemon-owned canonical, not app
// state — reducers have nothing to touch. Values transition
// Promise<CcmsgReadBody | null> → CcmsgReadBody (success) or "failed" (room
// gone / daemon error / msg not found). A "failed" entry is retried on the
// next mount of a bubble for that key (the daemon might have come back) but
// still renders as a distinct failure state in between — a tool_result
// placeholder has no recovered body to fall back on, so the bubble must be
// able to say "couldn't fetch" instead of rendering blank. Keyed
// `${room}|m${mid}` (same shape as ccmsgDedupKey's canonical form) so the
// same key space is used for dedup and for look-up.
interface CcmsgReadBody {
  from: string;
  to?: string[];
  msg: string;
  ts: string;
}
type CcmsgBodyCacheEntry = CcmsgReadBody | Promise<CcmsgReadBody | null> | "failed";
const CCMSG_BODY_CACHE = new Map<string, CcmsgBodyCacheEntry>();

function ccmsgBodyCacheKey(room: string, mid: number): string {
  return `${room}|m${mid}`;
}

/** Kicks off a `ws.read(room, [mid])` on first mount for this (room, mid)
 * and returns the resolved body once available; `"failed"` once a read
 * settled without a body (room gone, daemon error, msg not stored) so
 * CcmsgBubble can render an explicit couldn't-fetch note for a tool_result
 * placeholder that has no recovered body of its own; undefined while
 * nothing has settled yet. A `"failed"` entry is retried on the next mount
 * (tab switch back, page section re-open — the daemon might have come
 * back) but not within the current one, so a dead room costs one read per
 * mount, not a render-loop of them. CcmsgBubble treats undefined as "use
 * the placeholder / recovered body from the extraction" so the bubble is
 * never blank — the swap is strictly an upgrade, never a downgrade. */
function useCcmsgBody(room: string, mid: number | undefined): CcmsgReadBody | "failed" | undefined {
  const { ws } = useApp();
  const [, force] = useState(0);
  useEffect(() => {
    if (mid === undefined) return;
    const key = ccmsgBodyCacheKey(room, mid);
    const cached = CCMSG_BODY_CACHE.get(key);
    // A resolved body never changes (daemon msgs are append-only), so it
    // needs no re-fetch. "failed" falls through to retry on this fresh mount.
    if (cached !== undefined && cached !== "failed" && !(cached instanceof Promise)) return;
    // If a Promise is already in flight for this key, subscribe to it —
    // multiple bubbles for the same (room, mid) (e.g. a tool_result send
    // + its subscribe teammate-message echo before dedup) share one read.
    let cancelled = false;
    const onSettle = () => {
      if (!cancelled) force((n) => n + 1);
    };
    if (cached instanceof Promise) {
      void cached.then(onSettle);
      return () => {
        cancelled = true;
      };
    }
    const p = ws
      .read(room, [mid])
      .then((resp) => {
        if (!resp.ok || resp.msgs.length === 0) {
          CCMSG_BODY_CACHE.set(key, "failed");
          return null;
        }
        const m = resp.msgs[0]!;
        const body: CcmsgReadBody = {
          from: m.from,
          ...(m.to ? { to: m.to } : {}),
          msg: m.msg,
          ts: m.ts,
        };
        CCMSG_BODY_CACHE.set(key, body);
        return body;
      })
      .catch(() => {
        CCMSG_BODY_CACHE.set(key, "failed");
        return null;
      });
    CCMSG_BODY_CACHE.set(key, p);
    void p.then(onSettle);
    return () => {
      cancelled = true;
    };
  }, [room, mid, ws]);
  if (mid === undefined) return undefined;
  const c = CCMSG_BODY_CACHE.get(ccmsgBodyCacheKey(room, mid));
  return c !== undefined && !(c instanceof Promise) ? c : undefined;
}

// ccmsg メッセージ吹き出し (kawaz spec): msg/raw 切替は thinking の
// original|ja タブと同じ UI 流儀 (下タブボタン列)。raw は抽出元行の生
// テキスト全文 (extractCcmsgMessages が読んだのと同じ text segment 結合、
// 複数 msg が同じ行から来た場合は全吹き出しで同じ raw を共有する — 各
// メッセージ個別の断片ではなく「この行に何が書いてあったか」を見るためのタブ
// なので、行単位で共通の全文がふさわしい)。
//
// from:u1 (ADMIN_ID) は本物のユーザ発話と同じ「右寄せ + user 吹き出し
// 色」で表示する (kawaz r15 mid=6、2026-07-14)。RoomView TimelineItem
// の .msg-user と同じ意味論を transcript 側に横展開する形。それ以外
// (agent 発 ccmsg msg) は従来通り .tl-bubble-left .tl-bubble-peer (青系)。
function CcmsgBubble({
  message,
  rawText,
  now,
  searchKey,
  searchCtx,
  navKey,
  registerUserTurnRef,
  onUserTurnClick,
  selected,
}: {
  message: CcmsgMessage;
  rawText: string;
  now: number;
  navKey?: string;
  registerUserTurnRef: (key: string, el: HTMLDivElement | null) => void;
  onUserTurnClick: (navKey: string) => void;
  selected: boolean;
  // In-view search (DR-0022 §3, extended by kawaz r26 mid=97's 💬 target
  // toggle): undefined whenever the ccmsg target toggle is off, mirroring
  // SegmentView's searchCtx={undefined} convention for out-of-scope units —
  // only message.msg (the "msg" tab) is searchable, the raw fallback tab
  // stays unhighlighted like every other raw fallback in this file.
  searchKey: string;
  searchCtx: TLSearchCtx | undefined;
}) {
  const [tab, setTab] = useState<"msg" | "raw">("msg");
  // DR-0027 §2 Phase 1 lazy read: daemon-canonical body if known, otherwise
  // the placeholder / recovered body from the extraction. Fields fall back
  // individually (not all-or-nothing) so a tool_result-detected send (from
  // empty, ts = transcript ts) still shows the correct from as soon as read
  // resolves without waiting for msg. A settled-but-failed read (room gone /
  // msg not stored) keeps every recovered field and only replaces a body we
  // have nothing for with an explicit couldn't-fetch note — a bubble must
  // never render blank (DR-0027 §2.1's フォールバック requirement).
  const lookup = useCcmsgBody(message.room, message.mid);
  const body = lookup === "failed" ? undefined : lookup;
  const from = body?.from || message.from;
  const to = body?.to ?? message.to;
  const msgBody =
    body?.msg ||
    message.msg ||
    (lookup === "failed" ? `(本文を取得できません — #${message.room} は消えた可能性)` : "");
  const ts = body?.ts || message.ts;
  const isUser = from === ADMIN_ID;
  const isMatch = searchCtx !== undefined && searchCtx.words.length > 0;
  const bubble = (
    <div
      class={`${
        isUser
          ? "tl-bubble tl-bubble-right tl-bubble-ccmsg-user"
          : "tl-bubble tl-bubble-left tl-bubble-peer"
      }${selected ? " tl-bubble-user-nav-selected" : ""}`}
      ref={(el) => {
        if (navKey !== undefined) registerUserTurnRef(navKey, el);
      }}
      onClick={navKey === undefined ? undefined : () => onUserTurnClick(navKey)}
    >
      <div class={isUser ? "tl-bubble-body tl-bubble-body-user" : "tl-bubble-body"}>
        <div class="tl-bubble-from">
          {isUser ? <UserAvatar size={16} /> : null}
          {from || "…"}
          {(() => {
            // u1 (ADMIN_ID) は always-exempt 配信済みなので mention 表示から
            // 除外 (TimelineItem 側と同ポリシー、kawaz 2026-07-20)。
            const shown = to?.filter((id) => id !== ADMIN_ID) ?? [];
            return shown.length ? ` → ${shown.join(", ")}` : "";
          })()}
          {" · #"}
          {message.room}
          {message.mid === undefined ? null : `m${message.mid}`}
        </div>
        <div class="tl-thinking-tabs">
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "msg" ? " active" : "")}
            onClick={() => setTab("msg")}
          >
            msg
          </button>
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "raw" ? " active" : "")}
            onClick={() => setTab("raw")}
          >
            raw
          </button>
        </div>
        {tab === "msg" ? (
          // tl-ccmsg-msg: chat 様式の本文なので単一改行を行分けとして見せる
          // (CSS の white-space: pre-wrap、kawaz r17 mid=13)。markdown AST は
          // 段落内の改行を text node "\n" のまま保持しており、素の <p> では
          // 空白に潰れる。文書様式が前提の assistant markdown には波及させない
          // (ソフト折り返しを空白扱いする通常の markdown 表示のまま)。
          <div class="tl-ccmsg-msg">
            <MarkdownView source={msgBody} />
          </div>
        ) : (
          <pre class="tl-fold-body">{rawText}</pre>
        )}
      </div>
      <span class="tl-bubble-time">{formatMsgTime(ts, now)}</span>
    </div>
  );
  if (!isMatch || !searchCtx) return bubble;
  return (
    <div
      class="tl-search-unit"
      data-search-key={searchKey}
      ref={(el) => searchCtx.registerRef(searchKey, el)}
    >
      {bubble}
    </div>
  );
}

export function Timeline({
  sid,
  timeline,
  search,
  sessionStatus,
  onOpenStatus,
  agent,
}: {
  sid: string;
  timeline: TimelineState;
  search: { queryText: string; caseSensitive: boolean; regex: boolean };
  /** DR-0025 Phase 2: when present, the pane targets the named subagent /
   * workflow-agent / teammate transcript under `sid` instead of `sid`'s own.
   * All transcriptRead calls forward the agent params; transcript_subscribe
   * is skipped (agent transcripts have no live push, DR-0025 §2.2). Store's
   * `applyLocatorChanged` clears the sid's TimelineState whenever the agent
   * ref changes, so the initial-load effect refetches without needing an
   * agent-keyed cache. */
  agent?: AgentRef | null;
  /** DR-0020 §2.1 TL 下ミニパネル用の folded status snapshot — subscribe の
   * ライフサイクル自体は SessionView が Status タブと共有して管理する
   * (このコンポーネントは受け取って要約を出すだけ)。undefined = まだ届いて
   * いない (subscribe 直後のごく短い間) — パネル自体を隠す (下の
   * miniSummaryLines 呼び出し前にガード)。 */
  sessionStatus: SessionStatusSnapshot | undefined;
  /** ミニパネルタップで Status タブへ (DR-0020 §2.1「タップで Status タブへ
   * 遷移」)。SessionView 側のローカルタブ state を差し替えるだけなので、
   * ここではコールバックとして受け取る。 */
  onOpenStatus: () => void;
}) {
  const { store, ws } = useApp();
  const appState = useStoreState(store);
  const connStatus = appState.connStatus;

  // browser は mount 時の feature detect、host は WS hello 後の daemon
  // capability probe。両方を同じ値オブジェクトに束ねて下位コンポーネントへ渡す。
  const browserTranslatorAvailable = useMemo(() => hasTranslatorApi(), []);
  // 1 op = 1 英語段落: 各 ThinkingSegment の host 翻訳が独立に
  // ws.translate([paragraph]) を送り、segment ごとに完了した順で反映される
  // (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  const hostTranslateRequest = useMemo<HostTranslateRequest>(
    () => (texts) => ws.translate(texts),
    [ws],
  );
  const translationAvailability = useMemo<TranslationAvailability>(
    () => ({
      host: appState.hostTranslatorAvailable,
      browser: browserTranslatorAvailable,
      hostRequest: hostTranslateRequest,
    }),
    [appState.hostTranslatorAvailable, browserTranslatorAvailable, hostTranslateRequest],
  );
  // msg 時刻の相対時間表示 ("3h10m") 用の雑更新 tick (kawaz r17 mid=30):
  // 3 分おきの再描画で十分。
  const now = useNow();

  // Live tail (DR-0009 addendum, transcript_subscribe): このセッションの
  // Timeline が表示されている間だけ subscribe し、タブ切替/セッション切替/
  // unmount (依存 [sid, connStatus] のいずれかが変わる、またはアンマウント)
  // で unsubscribe する。届いた行は ws.ts の ev:"transcript" ハンドラが
  // `timeline/tail` action に変換し、store.ts の applyTimelineTail が
  // contiguous なときだけ追記する — このコンポーネントは購読の開始/終了だけ
  // 管理し、フォールドロジックには関与しない。send() は socket が open で
  // ない間 reject するので (ws.ts) catch で握りつぶす — 再接続後の
  // onOpen 側で改めて subscribe できる余地を持たせるため、ここではエラー
  // 表示もリトライも行わない (次の connStatus 変化でこの effect が再実行
  // される)。
  // DR-0025 Phase 2: agent transcripts have no live tail (§2.2 "リアルタイム
  // 完全進捗はスコープ外" — the daemon only offers subscribe on the session
  // itself, not on its subagents). Skip the subscribe when an agent ref is
  // active so we don't tail the wrong file (which would race back stale
  // lines and confuse the byte-cache).
  const agentActive = !!(agent && (agent.agentId || agent.teammate));
  const [autoOpenSettings, setAutoOpenSettings] = useState(() =>
    defaultTimelineAutoOpen(agentActive),
  );
  const [autoOpenRevision, setAutoOpenRevision] = useState(0);
  const [autoOpenPanelOpen, setAutoOpenPanelOpen] = useState(false);
  // パネル外 click で自動収納 (kawaz r38 mid=66)。useFabPopup と同じ理由で
  // click イベント (tap 完了) のみ — mousedown/touchstart はスクロール目的の
  // タッチでも閉じてしまう。open 中だけ listener を張る。
  const autoOpenFloatRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoOpenPanelOpen) return;
    const onClick = (e: MouseEvent) => {
      const el = autoOpenFloatRef.current;
      if (!el || !(e.target instanceof Node)) return;
      if (!el.contains(e.target)) setAutoOpenPanelOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [autoOpenPanelOpen]);
  useEffect(() => {
    setAutoOpenSettings(defaultTimelineAutoOpen(agentActive));
    setAutoOpenRevision((revision) => revision + 1);
  }, [sid, agent?.agentId, agent?.runId, agent?.teammate]);
  const toggleAutoOpen = useCallback((key: keyof TimelineAutoOpenSettings) => {
    setAutoOpenSettings((current) => toggleTimelineAutoOpen(current, key));
    setAutoOpenRevision((revision) => revision + 1);
  }, []);
  const autoOpenContext = useMemo<TimelineAutoOpenContextValue>(
    () => ({ settings: autoOpenSettings, revision: autoOpenRevision }),
    [autoOpenSettings, autoOpenRevision],
  );
  useEffect(() => {
    if (agentActive) return;
    if (connStatus !== "connected") return;
    void ws.transcriptSubscribe(sid).catch(() => {});
    return () => {
      void ws.transcriptUnsubscribe(sid).catch(() => {});
    };
  }, [sid, connStatus, agentActive]);

  // Build the transcriptRead opts once so every call site below stays in sync.
  const agentOpts = useMemo(() => {
    if (!agent) return undefined;
    return {
      ...(agent.agentId ? { agent_id: agent.agentId } : {}),
      ...(agent.runId ? { run_id: agent.runId } : {}),
      ...(agent.teammate ? { teammate: agent.teammate } : {}),
    };
  }, [agent?.agentId, agent?.runId, agent?.teammate]);

  // Tail-load on first visit only — re-visiting a session whose Timeline is
  // already "loaded"/"error" must not refetch (mirrors FileViewer's
  // path-keyed effect guard). Gated on connStatus so a direct `#t<sid>` link
  // opened before the WS handshake completes doesn't race ws.send() (rejects
  // synchronously while not open, see ws.ts) — status stays "idle" (still
  // rendered as "読み込み中…" below) until connStatus flips to "connected",
  // which re-evaluates this effect via the dep list.
  useEffect(() => {
    if (timeline.status !== "idle") return;
    if (connStatus !== "connected") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, agentOpts)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }, [sid, timeline.status, connStatus]);

  // Resync on a non-contiguous tail push (DR-0009 addendum, adversarial
  // review fix): applyTimelineTail (store.ts) can only detect that a
  // `timeline/tail` push doesn't line up with the cached `end` — it can't
  // fetch, so it flags `timeline.needsResync` instead of just dropping the
  // push and leaving live tail silently stuck (DR-0005 §1: side effects stay
  // out of the reducer). This effect is the side effect: a background
  // "replace" read that catches the cache up. Deliberately does NOT dispatch
  // `timeline/loading` first (unlike every other transcriptRead call site in
  // this component) — flipping status to "loading" would blank the pane
  // (Timeline's "読み込み中…" branch below) for what should be an invisible
  // catch-up, not a user-visible reload. If the re-read's own result is
  // already stale by the time it lands (more appends happened meanwhile),
  // the next tail push simply re-flags needsResync and this effect fires
  // again — self-healing, no bound on retries needed since each attempt is
  // a normal full tail read.
  useEffect(() => {
    if (!timeline.needsResync) return;
    if (connStatus !== "connected") return;
    void ws
      .transcriptRead(sid, agentOpts)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }, [sid, timeline.needsResync, connStatus]);

  // Auto-refresh on Timeline visit (TLR-Q1=b裁定, issue
  // 2026-07-14-session-tl-refresh-on-revisit): SessionTreeState's timeline
  // cache is intentionally preserved across tab/session switches (store.ts's
  // newSessionTree — clicking Files/Rooms and returning must not discard
  // what's already loaded), but the transcript_subscribe above is torn down
  // alongside this component's unmount. Any live-tail updates that landed
  // while the Timeline was unmounted never reached the cache, so a revisit
  // sees an `end` byte frozen at unmount time — the symptom kawaz observed
  // (SessionView Timeline "空だったり", r12 mid=12 2026-07-14). This effect
  // re-reads the tail once per "arrival at a Timeline to look at" so the
  // stale cache is caught up before the user sees it.
  //
  // - Skipped when status is "idle" (initial-load effect above owns first
  //   visit) or "loading" (a fetch is already in flight; overlapping it
  //   would just collide on the same replace dispatch).
  // - Dep list is [sid, connStatus] deliberately, NOT timeline.status: this
  //   should fire once when Timeline mounts / the sid changes / a reconnect
  //   lands, not on the loading→loaded flip caused by our own fetch (which
  //   would loop). status is closed over from the render that scheduled
  //   this effect, sufficient to gate the "no revisit needed" cases.
  // - mode: "replace" because DR-0009's transcript_read has no "after"
  //   parameter — an incremental "just what's new" is not representable in
  //   the current protocol. The response's own start/end/lines become the
  //   new cache wholesale (same shape as refresh() below).
  useEffect(() => {
    if (connStatus !== "connected") return;
    if (timeline.status !== "loaded" && timeline.status !== "error") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, agentOpts)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
    // timeline.status is intentionally not in deps — see doc comment above.
  }, [sid, connStatus]);

  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, { ...agentOpts, before: timeline.start })
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: errorMessage(err) });
      });
  }

  // "更新" (refresh): re-reads the tail (before omitted) and replaces the
  // cache wholesale rather than fetching only what's new since `end` — DR-0009
  // offers no cheaper "read what's new" shape (transcript_read has no
  // "after" parameter), and re-reading the tail is simple and correct at the
  // cost of re-fetching content we may already have (implementation
  // simplicity prioritized per the delegated spec).
  function refresh() {
    if (timeline.status === "loading") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, agentOpts)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
        // 「更新」= tail の読み直しなので、完了後は末尾へ (kawaz r17 mid=26)。
        // replace で end が同値のままだと tail-append effect が発火しないため
        // ここで明示的に飛ばす。isNearBottomRef も末尾扱いに戻す (更新直後に
        // 届く live tail への追従を継続させる)。
        isNearBottomRef.current = true;
        scrollToBottomSettled();
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }

  // Re-parsing on every render is cheap (pure JSON.parse over cached
  // strings), but memoizing keeps it off the hot path of unrelated re-renders
  // (e.g. sidebar toggles) that don't change `timeline.lines`.
  const parsed = useMemo(
    () => resolveToolResults(timeline.lines.map(parseTranscriptLine)),
    [timeline.lines],
  );
  // Absolute byte offsets, one per cached line — stable Preact keys across a
  // "load older" prepend (see transcript-model.ts's lineByteOffsets doc).
  const offsets = useMemo(
    () => lineByteOffsets(timeline.start, timeline.lines),
    [timeline.start, timeline.lines],
  );
  // Tools folding (kawaz spec): boundary lines (user prompts / assistant
  // user-facing final responses) stay standalone entries, everything between
  // them collapses into one fold group — see transcript-model.ts's
  // groupTimelineLines doc comment.
  const groups = useMemo(() => groupTimelineLines(parsed, offsets), [parsed, offsets]);
  // groups.map (render 本体) が毎レンダー classifyBoundaryLine を呼び直すのを
  // 避けるため、groups が変わった時だけ計算しメモ化する (index を groups と
  // 揃え、entry 以外は使わないので null のまま)。
  const boundaries = useMemo(
    () =>
      groups.map((g) =>
        g.kind === "entry" && g.line.kind === "turn" ? classifyBoundaryLine(g.line) : null,
      ),
    [groups],
  );

  // --- "👤 N/M" user-turn nav (kawaz spec): toolbar buttons to jump to the
  // top/bottom of the loaded transcript and to the previous/next user-text
  // turn, plus a live "current position" counter. ---

  // Stable key of every mounted green bubble in document order. The pure
  // model applies the same ccmsg deduplication as rendering, so the denominator
  // and every index in this array have exactly one DOM target.
  const userTurnKeys = useMemo(() => userNavTargets(groups).map((target) => target.key), [groups]);
  const userTurnKeySet = useMemo(() => new Set(userTurnKeys), [userTurnKeys]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userNavScrollAnimationRef = useRef<number | null>(null);
  // nav key -> mounted DOM node for each green bubble. Entries for turns
  // dropped by a "更新" (replace) reload are pruned below rather than leaked.
  const userTurnRefs = useRef(new Map<string, HTMLDivElement>());
  const registerUserTurnRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) userTurnRefs.current.set(key, el);
    else userTurnRefs.current.delete(key);
  }, []);

  // --- In-view search (DR-0022) ---

  const searchQueryText = search.queryText;
  const searchCaseSensitive = search.caseSensitive;
  const searchRegex = search.regex;
  const parsedSearch = useMemo(
    () =>
      parseSearchQuery(searchQueryText, { caseSensitive: searchCaseSensitive, regex: searchRegex }),
    [searchQueryText, searchCaseSensitive, searchRegex],
  );
  const changeSearch = useCallback(
    (next: Partial<typeof search>) => {
      store.dispatch({ type: "timeline/search-changed", sid, search: { ...search, ...next } });
    },
    [store, sid, search],
  );

  // Search target toggles (kawaz r26 mid=97 spec: "検索対象のチェックボックス:
  // ユーザメッセージ / AI 応答 / ccmsg 経由のメッセージ", 👤/🤖/💬 in SearchBar).
  // Default all-on. Kept as TL-local state (not in TimelineState / not
  // persisted with the query) — the task's spec explicitly scopes Session
  // Search's query-continuation (DR-0021, v0.44.0) to queryText/caseSensitive/
  // regex only, not these toggles.
  const [targetUser, setTargetUser] = useState(true);
  const [targetAI, setTargetAI] = useState(true);
  const [targetCcmsg, setTargetCcmsg] = useState(true);

  // Flat, document-order list of every search "unit" currently loaded — a
  // human/assistant Segment gated through `isSearchableSegment` (DR-0022 §3,
  // narrowed by kawaz r26 mid=97: tool-use/tool-result/unknown-segment are
  // never units regardless of toggles), plus one unit per deduped ccmsg
  // message when the 💬 toggle is on. System-origin non-ccmsg user messages
  // (LineView's `sysKind` — tool-result echo, task-notification, ...) stay
  // excluded entirely: they render through SystemMessageBody's rich|raw tabs
  // where SegmentView gets `searchCtx={undefined}`, so counting their
  // segments here would inflate the "[N/M]" M with ghost matches that have no
  // highlight and no DOM ref to scroll to (↑/↓ would advance the number and
  // visibly do nothing) — the count side excludes exactly what the render
  // side excludes.
  const searchUnits = useMemo(() => {
    const units: { key: string }[] = [];
    const targets = { user: targetUser, ai: targetAI, ccmsg: targetCcmsg };
    const pushLine = (offset: number, line: ParsedLine) => {
      if (line.kind !== "turn") return;
      if (line.role === "user" && line.userMessageKind && line.userMessageKind !== "user-prompt")
        return;
      line.segments.forEach((seg, i) => {
        if (!isSearchableSegment(seg, targets)) return;
        units.push({ key: `${offset}-${i}` });
      });
    };
    for (const group of groups) {
      if (group.kind === "fold") {
        for (const entry of group.entries) pushLine(entry.offset, entry.line);
      } else {
        pushLine(group.offset, group.line);
      }
    }
    // ccmsg messages (💬 toggle): boundary "entry" groups classified "ccmsg"
    // by classifyBoundaryLine, walked with the same dedup key + order the
    // render side (groups.map's seenCcmsg Set below) uses — see
    // ccmsgDedupKey's doc comment for why sharing the key matters.
    if (targetCcmsg) {
      const seenCcmsg = new Set<string>();
      groups.forEach((group, i) => {
        if (group.kind !== "entry") return;
        const boundary = boundaries[i];
        if (!boundary || boundary.kind !== "ccmsg") return;
        boundary.messages.forEach((m, j) => {
          const dedupKey = ccmsgDedupKey(m);
          if (seenCcmsg.has(dedupKey)) return;
          seenCcmsg.add(dedupKey);
          units.push({ key: `${group.offset}-ccmsg-${j}` });
        });
      });
    }
    return units;
  }, [groups, boundaries, targetUser, targetAI, targetCcmsg]);

  // The "M" in "[N/M]" and the document-order nav ↑/↓ walks (DR-0022 §2.1/
  // §2.2) — units are counted regardless of whether their fold is currently
  // open (revealAndScroll below opens ancestors on nav instead), so "M"
  // reflects everything loaded, not just what's presently visible.
  const [matchingUnitKeys, setMatchingUnitKeys] = useState<string[]>([]);

  const [searchCurrentIndex, setSearchCurrentIndex] = useState(0);
  // A fresh search (query edit, toggle flip, or session switch) always
  // starts back at the first match.
  // Deps deliberately omit matchingUnitKeys: the reset key is "the query/
  // session changed", not the array's identity (which also changes on every
  // tail append / fold-independent reparse and would reset the index far
  // more often than intended).
  useEffect(() => {
    setSearchCurrentIndex(matchingUnitKeys.length > 0 ? 1 : 0);
  }, [searchQueryText, searchCaseSensitive, searchRegex, sid]);
  // A handed-off query can exist before the initial transcript page arrives.
  // In that order the query-reset effect above sees zero matches; initialize
  // the counter when loaded content first creates a non-empty match set without
  // resetting an already-selected index on later tail updates.
  useEffect(() => {
    setSearchCurrentIndex((current) => {
      if (matchingUnitKeys.length === 0) return 0;
      if (current <= 0) return 1;
      return Math.min(current, matchingUnitKeys.length);
    });
  }, [matchingUnitKeys.length]);

  const searchUnitRefs = useRef(new Map<string, HTMLElement>());
  const registerSearchUnitRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) searchUnitRefs.current.set(key, el);
    else searchUnitRefs.current.delete(key);
  }, []);

  useEffect(() => {
    const orderedKeys: string[] = [];
    for (const unit of searchUnits) {
      const el = searchUnitRefs.current.get(unit.key);
      if (!el) continue;
      if (parsedSearch.words.length === 0 || parsedSearch.hasError) {
        removeRenderedTextHighlights(el);
        continue;
      }
      const matched = highlightRenderedText(el, parsedSearch.words, () => {
        const position = orderedKeys.indexOf(unit.key);
        if (position >= 0) setSearchCurrentIndex(position + 1);
      });
      if (matched) orderedKeys.push(unit.key);
    }
    const currentKey = searchCurrentIndex > 0 ? orderedKeys[searchCurrentIndex - 1] : undefined;
    for (const unit of searchUnits) {
      const el = searchUnitRefs.current.get(unit.key);
      if (el) setRenderedTextCurrent(el, unit.key === currentKey);
    }
    setMatchingUnitKeys((current) =>
      current.length === orderedKeys.length && current.every((key, i) => key === orderedKeys[i])
        ? current
        : orderedKeys,
    );
    return () => {
      for (const el of searchUnitRefs.current.values()) removeRenderedTextHighlights(el);
    };
  }, [searchUnits, parsedSearch, matchingUnitKeys, searchCurrentIndex]);

  // Auto-expand every ancestor <details> (fold group / items sub-fold /
  // system-message fold) before scrolling — Phase 2's "fold との相互作用込み"
  // (DR-0022 §4): a match living inside a collapsed fold must actually
  // become visible when navigated to, not silently scroll to a hidden
  // element. Mirrors FoldGuide's ancestor-`<details>`-via-`closest()` trick
  // used elsewhere in this file, walking outward through nested folds.
  // Opens a closed <details> in a way that survives the imminent re-render.
  // FoldGroup/ItemsSubFold/ThinkingSegment all render a *controlled*
  // `<details open={state}>` synced via onToggle. The browser fires `toggle`
  // asynchronously (as a task), but the setSearchCurrentIndex re-render from
  // searchNext/Prev lands first and writes the still-false state's `open`
  // back to the DOM, silently re-closing the fold (observed 2026-07-17: nav
  // into a closed fold moved scroll but the fold stayed shut). Dispatching
  // the toggle synchronously runs the component's onToggle → setState now,
  // so that re-render sees open=true and keeps it. (FoldGuide's close path
  // doesn't need this: nothing re-renders between its DOM write and the
  // browser's own toggle task.)
  function forceOpenDetails(d: HTMLDetailsElement) {
    if (d.open) return;
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
  }

  function revealAndScroll(el: HTMLElement) {
    // The match text usually lives *inside* the unit's own fold — a tool_use/
    // tool_result/unknown-segment/thinking segment IS a <details class=
    // "tl-fold">, whose summary shows only the label (never the matched
    // text). The ancestor walk below starts *outside* the unit (closest()
    // from the display:contents wrapper resolves to the wrapper's enclosing
    // details, not the unit's own), so without this the nav would center a
    // collapsed summary with the highlight still hidden (observed
    // 2026-07-17). Text-segment units have no descendant details — querySelectorAll
    // finds nothing and this is a no-op for them.
    for (const d of el.querySelectorAll("details")) forceOpenDetails(d);
    let node: HTMLElement | null = el;
    while (node) {
      const ancestorDetails: HTMLDetailsElement | null = node.closest("details");
      if (!ancestorDetails) break;
      forceOpenDetails(ancestorDetails);
      node = ancestorDetails.parentElement;
    }
    // `el` is the `display: contents` .tl-search-unit wrapper — its own box
    // is 0x0 (that's the point of `contents`, it doesn't participate in
    // layout), and Chromium treats scrollIntoView on a boxless element as a
    // no-op (observed 2026-07-17: scrollTop unchanged). Scroll the first
    // rendered child instead; the ancestor-<details> walk above still works
    // from the wrapper since `contents` only removes the box, not the DOM
    // position.
    const target = (el.firstElementChild as HTMLElement | null) ?? el;
    // Multi-shot scroll (same settled pattern as scrollToBottomSettled
    // below): opening the ancestor folds just above triggers Preact
    // re-renders that keep shifting layout after this synchronous call —
    // a fold group's first open auto-expands every thinking inside it and
    // kicks off ja translation (ThinkingSegment's foldGroupOpen effect),
    // each of which grows content above/around the match and strands a
    // single immediate scrollIntoView at a stale position (observed
    // 2026-07-17: match ends up outside the viewport on first nav into a
    // closed fold). Re-scrolling at 60/300ms tracks those reflows;
    // scrollIntoView on an already-visible target is a no-op so the extra
    // shots don't cause visible jitter.
    for (const ms of [0, 60, 300]) {
      setTimeout(() => target.scrollIntoView({ block: "center" }), ms);
    }
  }

  function scrollToSearchMatch(oneBasedIdx: number) {
    const key = matchingUnitKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    const el = searchUnitRefs.current.get(key);
    if (el) revealAndScroll(el);
  }

  // ↑/↓ move + scroll; a highlight click only updates the index (DR-0022
  // §2.2). Loop wrap is the same pure helper
  // 👤 nav uses (goPrevUserTurn/goNextUserTurn above).
  function searchPrev() {
    const next = loopPrevIndex(searchCurrentIndex, matchingUnitKeys.length);
    setSearchCurrentIndex(next);
    if (next > 0) scrollToSearchMatch(next);
  }
  function searchNext() {
    const next = loopNextIndex(searchCurrentIndex, matchingUnitKeys.length);
    setSearchCurrentIndex(next);
    if (next > 0) scrollToSearchMatch(next);
  }

  const searchCtx: TLSearchCtx | undefined = useMemo(() => {
    if (parsedSearch.words.length === 0) return undefined;
    return { words: parsedSearch.words, registerRef: registerSearchUnitRef };
  }, [parsedSearch.words, registerSearchUnitRef]);

  // "👤 N/M" nav の N (kawaz r17 mid=54, 2026-07-15): 以前はスクロール位置から
  // 推定していたが「変な挙動しかしないゴミ」と判定され仕様変更 — リロード /
  // 初回読み込み時に最大値 (M) で初期化し、以降は ↑↓ ボタンで増減してユーザ
  // が明示的にジャンプした値だけを保持する (スクロール位置とは独立)。
  const [currentUserIdx, setCurrentUserIdx] = useState(0);
  const [userNavActivated, setUserNavActivated] = useState(false);
  const previousUserTurnKeysRef = useRef(userTurnKeys);
  useEffect(() => {
    const previousKeys = previousUserTurnKeysRef.current;
    previousUserTurnKeysRef.current = userTurnKeys;
    setCurrentUserIdx((current) => {
      const reindexed = reindexStableSelection(current, previousKeys, userTurnKeys);
      return reindexed ?? current;
    });
  }, [userTurnKeys]);
  useEffect(() => {
    setUserNavActivated(false);
  }, [sid, agent?.agentId, agent?.runId, agent?.teammate]);
  const selectedUserTurnKey = userNavActivated ? userTurnKeys[currentUserIdx - 1] : undefined;

  useEffect(
    () => () => {
      if (userNavScrollAnimationRef.current !== null) {
        cancelAnimationFrame(userNavScrollAnimationRef.current);
      }
    },
    [],
  );

  // Live tail 自動スクロール追従 (kawaz spec) のための「今ユーザは最下部付近
  // を見ているか」フラグ。scroll イベント (下の rAF スロットル済み onScroll)
  // でだけ更新する ref — レンダーごとの再計算は不要 (DOM 位置に依存する値を
  // state に上げると余計な再レンダーを誘発するため、ref に留める)。初期値
  // true: マウント直後 (まだ何もスクロールしていない状態) は「最下部相当」
  // とみなし、直後に届く tail に自然に追従させる。
  const isNearBottomRef = useRef(true);
  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance < NEAR_BOTTOM_PX;
  }, []);

  useEffect(() => {
    // Drop refs for turns that no longer exist post-reload (a "更新" replace
    // swaps in an entirely new key set) so the Map doesn't accumulate
    // detached nodes across repeated refreshes.
    const validKeys = new Set(userTurnKeys);
    for (const key of userTurnRefs.current.keys()) {
      if (!validKeys.has(key)) userTurnRefs.current.delete(key);
    }

    // scroll イベント購読は自動 tail 追従の isNearBottomRef 更新用のみ (kawaz
    // r17 mid=54 で currentUserIdx の scroll 判定は廃止された — 上の
    // currentUserIdx 節参照)。
    const container = scrollRef.current;
    if (!container) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        checkNearBottom();
        ticking = false;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    checkNearBottom();
    return () => container.removeEventListener("scroll", onScroll);
  }, [userTurnKeys, checkNearBottom]);

  // セッション切替時、前セッションの「どこまで読んだか (byte end)」を引き
  // 継がないようにリセットする — このリセットを先に走らせておくことで、下の
  // tail 検知 effect が「セッション切替による end の変化」を「tail 追記」と
  // 誤認して意図しない自動スクロールを起こさない (両 effect の実行順序は
  // 定義順、[sid] だけに依存するこの effect が先に走る)。
  //
  // 追加 (kawaz r15 mid=7、2026-07-14): mount / sid 切替直後にも最下部へ
  // スクロールする。既存 tail-append effect は `timeline.end` の伸びに反応
  // する形式なので、cache がすでに埋まった状態 (前訪問済 or 再訪 revalidate)
  // で end が変わらないケースで scroll が発火せず「一番上のまま」になる
  // ことがあった。setTimeout(0) で initial render 完了を待ってから scroll
  // を書く — mount 直後の scrollHeight は content flush 前で 0 相当のため。
  const prevEndRef = useRef(timeline.end);
  // mount / sid 切替直後の末尾ジャンプは 0ms 1 発でなく間隔を空けて数回書く
  // (kawaz r17 mid=26): fold group / 画像 / フォントで paint 後に scrollHeight
  // が伸びるケースを 1 発では取り零す。ユーザが先に手動スクロールして末尾から
  // 離れたら (isNearBottomRef が false になったら) 以降の書き込みは中断。
  const scrollToBottomSettled = useCallback(() => {
    // 末尾 1000ms はリロード直後の初期 fetch (2MB) 向け: 大量行の markdown
    // 描画 + Shiki highlight の非同期差し替えで数百 ms 後も高さが伸びる。
    //
    // 中断条件は scroll 位置でなく **ユーザ入力 (wheel / touch / キー)** で
    // 判定する (kawaz r17 mid=37 のリグレッション対策): 位置ベースの
    // isNearBottomRef ガードだと、初回ロード直後の「まだ top に居る」状態を
    // 「ユーザが上に離れた」と誤認して全タイマーが空振りし、末尾ジャンプが
    // 一切効かなくなる。programmatic scroll はこれらのイベントを発火しない
    // ので、ユーザの意図した離脱だけを正確に拾える。
    const el0 = scrollRef.current;
    let cancelled = false;
    const onUserInput = () => {
      cancelled = true;
      detach();
    };
    const detach = () => {
      el0?.removeEventListener("wheel", onUserInput);
      el0?.removeEventListener("touchstart", onUserInput);
      el0?.removeEventListener("keydown", onUserInput);
    };
    el0?.addEventListener("wheel", onUserInput, { passive: true });
    el0?.addEventListener("touchstart", onUserInput, { passive: true });
    el0?.addEventListener("keydown", onUserInput);
    const ids = [0, 60, 300, 1000].map((ms) =>
      setTimeout(() => {
        const el = scrollRef.current;
        if (el && !cancelled) el.scrollTop = el.scrollHeight;
      }, ms),
    );
    const lastId = setTimeout(detach, 1001);
    return () => {
      ids.forEach(clearTimeout);
      clearTimeout(lastId);
      detach();
    };
  }, []);
  useEffect(() => {
    prevEndRef.current = timeline.end;
    isNearBottomRef.current = true;
    return scrollToBottomSettled();
    // 依存は [sid] のみ意図的 — timeline.end を含めると「セッション切替
    // 検知」ではなく毎回の tail 追記でもリセットされてしまい、下の
    // tail-append effect の appended 判定が常に false になってしまう。
  }, [sid]);

  // Live tail で新しい行が追記されたとき (`timeline.end` が伸びる) だけ、か
  // つユーザが最下部付近を見ているときだけ自動スクロールする (kawaz spec)。
  // `end` は「load older」prepend では変わらない (applyTimelineLoaded) の
  // で、この条件は自然に prepend を除外し、tail 追記 (と初回 tail ロード)
  // だけに反応する。smooth アニメーションなし — 高頻度で届く tail 行ごとに
  // アニメーションが重なるとかえって読みにくいため、即座にジャンプする。
  useEffect(() => {
    const appended = timeline.end > prevEndRef.current;
    const initialLoad = prevEndRef.current === 0 && timeline.end > 0;
    prevEndRef.current = timeline.end;
    // currentUserIdx を最大値に初期化 (kawaz r17 mid=54): リロード直後
    // (refresh: end が減る/等しい) と初回読み込み (initialLoad) の両方で
    // "末尾ユーザメッセージ" を選択状態にする。tail 追記 (appended) 時は
    // ユーザが今どこを読んでいるかに関係なく数値を勝手に増やさない。
    if (initialLoad || !appended) setCurrentUserIdx(userTurnKeys.length);
    if (!appended) return;
    // 初回 tail ロード (リロード直後: mount 時の [sid] effect は空 timeline
    // に空振りし、ここが実質の初回スクロール) は位置ガードなしで必ず末尾へ
    // (kawaz r17 mid=34,37 — 「まだ top に居る」を「ユーザが離れた」と誤認
    // する位置ベース判定が末尾ジャンプを殺していた)。以降の live tail 追記は
    // 従来通り「末尾付近に居る時だけ」追従 (kawaz spec、上へ遡り中の読書を
    // 吹っ飛ばさない)。
    if (!initialLoad && !isNearBottomRef.current) return;
    // settled 方式 (0/60/300/1000ms の複数回書き): 初期 fetch (2MB) の
    // 大量行は markdown / highlight の非同期差し替えで effect 後も
    // scrollHeight が伸びるので、1 発の書き込みでは上に取り残される。
    return scrollToBottomSettled();
  }, [timeline.end]);

  // behavior 指定なし = "auto" = 即座にジャンプ (kawaz r17 mid=54: smooth
  // エフェクトはウザいので削除)。
  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0 });
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }

  function scrollToUserTurn(oneBasedIdx: number) {
    const key = userTurnKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    const target = userTurnRefs.current.get(key);
    const container = scrollRef.current;
    if (!target || !container) return;
    setUserNavActivated(true);
    // sticky な tl-toolbar の実高さ分だけ下げた位置へスクロールする
    // (kawaz r35 mid=51: 固定の scroll-margin-top 4rem ではモバイル幅で
    // toolbar が 2 行以上に wrap した時に不足し、対象がヘッダ裏に隠れた)。
    // toolbar は container 内 sticky なので offsetHeight が常に実高さ。
    const toolbar = container.querySelector<HTMLElement>(".tl-toolbar");
    const toolbarBottom =
      toolbar?.getBoundingClientRect().bottom ?? container.getBoundingClientRect().top;
    const top = target.getBoundingClientRect().top - toolbarBottom + container.scrollTop;

    if (userNavScrollAnimationRef.current !== null) {
      cancelAnimationFrame(userNavScrollAnimationRef.current);
      userNavScrollAnimationRef.current = null;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      container.scrollTo({ top });
      return;
    }

    const startTop = container.scrollTop;
    const distance = top - startTop;
    const durationMs = 180;
    let startTime: number | null = null;
    const animate = (now: number) => {
      startTime ??= now;
      const progress = Math.min((now - startTime) / durationMs, 1);
      const eased = 1 - (1 - progress) ** 3;
      container.scrollTo({ top: startTop + distance * eased });
      if (progress < 1) {
        userNavScrollAnimationRef.current = requestAnimationFrame(animate);
      } else {
        userNavScrollAnimationRef.current = null;
      }
    };
    userNavScrollAnimationRef.current = requestAnimationFrame(animate);
  }

  // kawaz r17 mid=54: state を減増してから対応要素へジャンプする単純な形
  // (以前は scroll 位置から currentUserIdx を推定していたので 1 段目の state
  // 更新が不要だった)。境界は 1 ≤ idx ≤ M — ループ遷移そのものは DR-0022 §2.2
  // で search nav と共通化された in-view-search.ts の loopPrevIndex/
  // loopNextIndex に委譲 (以前はここに手書きの if ガードがあった)。
  function goPrevUserTurn() {
    const next = loopPrevIndex(currentUserIdx, userTurnKeys.length);
    if (next === 0) return;
    setCurrentUserIdx(next);
    scrollToUserTurn(next);
  }

  function goNextUserTurn() {
    const next = loopNextIndex(currentUserIdx, userTurnKeys.length);
    if (next === 0) return;
    setCurrentUserIdx(next);
    scrollToUserTurn(next);
  }

  // 👤 nav のクリック同期 (DR-0022 §2.2 を 👤 nav にも統一適用): クリックされた
  // 吹き出しの offsetKey が userTurnKeys の何番目かを引いて、スクロールなしで
  // currentUserIdx を合わせる。navKey が現在の描画対象と一致しない場合は
  // 何もしない。
  const onUserTurnClick = useCallback(
    (navKey: string) => {
      const pos = userTurnKeys.indexOf(navKey);
      if (pos < 0) return;
      setUserNavActivated(true);
      setCurrentUserIdx(pos + 1);
    },
    [userTurnKeys],
  );

  // TL 下ミニパネル (DR-0020 §2.1、issue 2026-07-17 #1/#5 で拡張): 走行中
  // workflow + in_progress TODO の要約に加え、context 消費と活動中
  // teammates の要約行も含む (miniSummaryLines 参照)。ゼロ件 (snapshot 未着
  // 含む) ならパネル自体を出さない仕様 ("ゼロ件なら非表示")。
  const miniLines = sessionStatus ? miniSummaryLines(sessionStatus) : [];
  const agentTimelineHrefs = useMemo(() => {
    const hrefs = new Map<string, string>();
    if (!sessionStatus) return hrefs;

    const teammateNames = new Set<string>();
    for (const teammate of sessionStatus.teammates ?? []) {
      teammateNames.add(teammate.name);
      hrefs.set(teammate.name, agentTimelineHref(sid, { teammate: teammate.name }));
    }

    const ambiguousWorkflowNames = new Set<string>();
    for (const workflow of sessionStatus.workflows) {
      if (!workflow.run_id) continue;
      for (const workflowAgent of workflow.agents ?? []) {
        const name = workflowAgent.label;
        if (!name || teammateNames.has(name) || ambiguousWorkflowNames.has(name)) continue;
        if (hrefs.has(name)) {
          hrefs.delete(name);
          ambiguousWorkflowNames.add(name);
          continue;
        }
        hrefs.set(
          name,
          agentTimelineHref(sid, {
            runId: workflow.run_id,
            agentId: workflowAgent.agent_id,
          }),
        );
      }
    }
    return hrefs;
  }, [sessionStatus, sid]);

  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  const agentLabel = agent
    ? agent.teammate
      ? `teammate ${agent.teammate}`
      : agent.runId
        ? `${agent.runId}/${agent.agentId}`
        : `${agent.agentId}`
    : null;
  return (
    <FileToolSidContext.Provider value={sid}>
      <AgentTimelineHrefsContext.Provider value={agentTimelineHrefs}>
        <TimelineAutoOpenContext.Provider value={autoOpenContext}>
          <div class="timeline-view" ref={scrollRef}>
            {agentLabel ? (
              <div class="tl-agent-header">
                <span class="tl-agent-header-label">agent: {agentLabel}</span>
                <a class="tl-agent-header-back" href={timelineHref(sid)}>
                  親セッションへ戻る
                </a>
              </div>
            ) : null}
            <div class="tl-toolbar">
              <button
                type="button"
                disabled={timeline.atStart || timeline.status === "loading"}
                onClick={loadOlder}
              >
                {timeline.atStart ? "先頭まで" : "older"}
              </button>
              <SearchBar
                words={parsedSearch.words}
                queryText={searchQueryText}
                onQueryChange={(queryText) => changeSearch({ queryText })}
                caseSensitive={searchCaseSensitive}
                onToggleCaseSensitive={() => changeSearch({ caseSensitive: !searchCaseSensitive })}
                regexMode={searchRegex}
                onToggleRegex={() => changeSearch({ regex: !searchRegex })}
                matchCount={matchingUnitKeys.length}
                currentIndex={searchCurrentIndex}
                onPrev={searchPrev}
                onNext={searchNext}
                hasError={parsedSearch.hasError}
                targets={{
                  user: targetUser,
                  onToggleUser: () => setTargetUser((v) => !v),
                  ai: targetAI,
                  onToggleAI: () => setTargetAI((v) => !v),
                  ccmsg: targetCcmsg,
                  onToggleCcmsg: () => setTargetCcmsg((v) => !v),
                }}
              />
              <div class="tl-user-nav">
                <button
                  type="button"
                  class="tl-user-nav-count"
                  disabled={currentUserIdx <= 0 || userTurnKeys.length === 0}
                  onClick={() => scrollToUserTurn(currentUserIdx)}
                  title="現在のユーザ発言へ戻る"
                >
                  👤 {currentUserIdx}/{userTurnKeys.length}
                </button>
                {/* disabled のみ「ユーザ発言が 1 件も無い」を基準にする — 境界での
                 * disabled (旧 currentUserIdx<=1 / >=length) は DR-0022 §2.2 の
                 * ループ仕様と両立しない (ループするボタンを境界で押せなくしては
                 * 意味がない)。 */}
                <button
                  type="button"
                  disabled={userTurnKeys.length === 0}
                  onClick={goPrevUserTurn}
                  title="前のユーザ発言へ"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={userTurnKeys.length === 0}
                  onClick={goNextUserTurn}
                  title="次のユーザ発言へ"
                >
                  ↓
                </button>
              </div>
              <button type="button" onClick={scrollToTop} title="最上部へ">
                ⤒
              </button>
              <button type="button" onClick={scrollToBottom} title="最下部へ">
                ⤓
              </button>
            </div>
            {timeline.status === "error" ? (
              <div class="tl-error">
                <p>{timeline.error}</p>
                <button type="button" onClick={refresh}>
                  再試行 (tail から読み直す)
                </button>
              </div>
            ) : (
              <div class="tl-lines">
                {parsed.length === 0 ? (
                  <p class="tl-empty">(空の transcript)</p>
                ) : (
                  // 同一 ccmsg event (room + ts + from) が transcript の複数箇所から
                  // 抽出されるとき (queue-operation enqueue と task-notification 経由の
                  // Monitor tool_result 両方に載っているケース、kawaz r15 mid=21、
                  // 2026-07-14) の二重表示を避ける。この Set は本 iteration 内でだけ
                  // 変化させる: React/Preact の render は同期 1 pass なので closure
                  // 越しの mutation で問題ないが、次回 render では新規 Set が必要
                  // (前回の Set を持ち越さない) — なので groups.map の直前でリセット
                  // される形にしておく。
                  ((seenCcmsg: Set<string>) =>
                    groups.map((group, i) => {
                      if (group.kind === "fold") {
                        return (
                          <FoldGroup
                            key={group.entries[0]!.offset}
                            entries={group.entries}
                            translationAvailability={translationAvailability}
                            searchCtx={searchCtx}
                          />
                        );
                      }
                      const { line, offset } = group;
                      // line.kind !== "turn" (meta/broken) は classifyBoundaryLine が
                      // 絶対に boundary と判定しない (groupTimelineLines がそれらを
                      // fold group に送るので groups の "entry" 側には来ない) —
                      // ここでの line.kind==="turn" ガードは型ナローイングのためだが、
                      // 実データ上も自明に成り立つ。
                      if (line.kind !== "turn") return null;
                      // boundaries[i] は上の useMemo で groups と同じ index で
                      // 計算済み (render のたびの再分類を避けるため)。
                      const boundary = boundaries[i]!;
                      if (boundary === null) return null;
                      switch (boundary.kind) {
                        case "user-prompt":
                          return (
                            <UserPromptBubble
                              key={offset}
                              line={line}
                              offsetKey={offset}
                              navKey={`user:${offset}`}
                              registerUserTurnRef={registerUserTurnRef}
                              translationAvailability={translationAvailability}
                              now={now}
                              searchCtx={searchCtx}
                              onUserTurnClick={onUserTurnClick}
                              selected={selectedUserTurnKey === `user:${offset}`}
                            />
                          );
                        case "assistant-response":
                          return (
                            <AssistantBubble
                              key={offset}
                              line={line}
                              offset={offset}
                              translationAvailability={translationAvailability}
                              now={now}
                              searchCtx={searchCtx}
                            />
                          );
                        case "ccmsg": {
                          // raw タブ用の「この行に何が書いてあったか」: subscribe/
                          // teammate-message wrapper は text segment に、DR-0027 §2.2
                          // の tool_result 検出行 ({ok:true,room,mid} response) は
                          // tool-result segment にしか原文が無い — text だけ結合すると
                          // tool_result 由来バブルの raw タブが空になるので両方拾う。
                          const rawText = line.segments
                            .filter(
                              (s): s is Extract<Segment, { kind: "text" | "tool-result" }> =>
                                s.kind === "text" || s.kind === "tool-result",
                            )
                            .map((s) => s.text)
                            .join("\n");
                          return boundary.messages
                            .map((m, j) => {
                              const dedupKey = ccmsgDedupKey(m);
                              if (seenCcmsg.has(dedupKey)) return null;
                              seenCcmsg.add(dedupKey);
                              const navKey = `ccmsg:${offset}:${j}`;
                              return (
                                <CcmsgBubble
                                  key={`${offset}-${j}`}
                                  message={m}
                                  rawText={rawText}
                                  now={now}
                                  searchKey={`${offset}-ccmsg-${j}`}
                                  searchCtx={searchCtx}
                                  navKey={userTurnKeySet.has(navKey) ? navKey : undefined}
                                  registerUserTurnRef={registerUserTurnRef}
                                  onUserTurnClick={onUserTurnClick}
                                  selected={selectedUserTurnKey === navKey}
                                />
                              );
                            })
                            .filter((n) => n !== null);
                        }
                      }
                    }))(new Set<string>())
                )}
              </div>
            )}
            <div
              ref={autoOpenFloatRef}
              class={`tl-auto-open-float${autoOpenPanelOpen ? " tl-auto-open-float-open" : ""}`}
            >
              <button
                type="button"
                class="tl-auto-open-handle"
                aria-label={autoOpenPanelOpen ? "auto open 設定を閉じる" : "auto open 設定を開く"}
                aria-expanded={autoOpenPanelOpen}
                onClick={() => setAutoOpenPanelOpen((open) => !open)}
              >
                {autoOpenPanelOpen ? "›" : "‹"}
              </button>
              <fieldset class="tl-auto-open" aria-label="自動オープンする Timeline カテゴリ">
                <legend>auto open</legend>
                {(["U", "R", "T", "A"] as const).map((category) => {
                  const fixed = category === "U" || category === "R";
                  return (
                    <label key={category} title={fixed ? "常に表示" : `${category} を自動オープン`}>
                      <input
                        type="checkbox"
                        checked={
                          fixed
                            ? true
                            : category === "T"
                              ? autoOpenSettings.thinking
                              : autoOpenSettings.agent
                        }
                        disabled={fixed}
                        onChange={() => {
                          if (!fixed) toggleAutoOpen(category === "T" ? "thinking" : "agent");
                        }}
                      />
                      {category}
                    </label>
                  );
                })}
                <span class="tl-auto-open-separator" aria-hidden="true" />
                <label title="T/A を含む外側の fold を自動オープン">
                  <input
                    type="checkbox"
                    checked={autoOpenSettings.items}
                    onChange={() => toggleAutoOpen("items")}
                  />
                  N items
                </label>
              </fieldset>
            </div>
            <div class="tl-bottom-controls">
              {miniLines.length > 0 ? (
                <button type="button" class="tl-status-mini" onClick={onOpenStatus}>
                  {miniLines.map((line) => (
                    <span
                      key={`${line.kind}-${line.text}`}
                      class={`tl-status-mini-line tl-status-mini-${line.kind}`}
                    >
                      {line.text}
                    </span>
                  ))}
                </button>
              ) : null}
            </div>
          </div>
        </TimelineAutoOpenContext.Provider>
      </AgentTimelineHrefsContext.Provider>
    </FileToolSidContext.Provider>
  );
}
