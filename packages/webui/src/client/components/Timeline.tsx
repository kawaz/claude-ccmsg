// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { createContext, type ComponentChildren } from "preact";
import { memo, useSyncExternalStore } from "preact/compat";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { DeliveredEvent, ForkOrigin, PeerInfo, SessionStatusSnapshot } from "@ccmsg/protocol";
import type { RoomState, TimelineState } from "../store.ts";
import { ADMIN_ID } from "../store.ts";
import type { AgentRef } from "../locator.ts";
import { agentTimelineHref, fileHref, parseUrl, sessionHref, timelineHref } from "../locator.ts";
import { pushNavigation, rememberTimelinePosition, replaceNavigation } from "../navigation.ts";
import { prefillSidebarState } from "../session-creator.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { activeTraceCollector } from "../trace.ts";
import { setBounded } from "../bounded-map.ts";
import { emptyLineMapCache, mapLinesIncrementally } from "../incremental-line-map.ts";
import { crossLineIncrementally, emptyCrossLineCache } from "../incremental-cross-line.ts";
import { Avatar, UserAvatar, hueForSeed } from "../avatar.tsx";
import { errorMessage, formatClockTime, formatMsgTime, memberLabel } from "../utils.ts";
import { bubbleHue, filePathCtxForSender, MemberAvatar, TimelineItem } from "./TimelineItem.tsx";
import { useNow } from "../useNow.ts";
import { useDismissOnOutsidePointer } from "../useDismissOnOutsidePointer.ts";
import { miniSummaryLines } from "../session-status-view.ts";
import {
  positionLandingKey,
  shouldLandOnPosition,
  shouldReturnToHead,
  togglePosition,
} from "./timeline-position.ts";
import {
  shouldCloseSidePanel,
  sidePanelReserveWidth,
  TL_SIDE_PANEL_MIN_CONTENT_PX,
} from "./timeline-side-panel.ts";
import {
  agentCommunicationCount,
  CACHE_KEEPALIVE_FOLD_LABEL,
  ccmsgMessageCount,
  ccmsgRenderTargets,
  ccmsgUnitKey,
  classifyBoundaryLine,
  extractCcmsgMessages,
  foldGroupLabel,
  foldGroupNeedsOuterFold,
  isApiErrorLine,
  isCacheKeepaliveReplyLine,
  isSearchableSegment,
  isUserSpeechKind,
  segmentSearchText,
  itemRawSourceOffsets,
  isDirectFoldEntry,
  userNavTargets,
  parseSystemMessageFields,
  parseTranscriptLine,
  rawTranscriptRowsFrom,
  utf8ByteLength,
  truncateRawLine,
  type AttachmentFile,
  type BashCommandOutput,
  type CcmsgMessage,
  type FileToolResult,
  type ParsedLine,
  type Segment,
  type RawTranscriptRow,
  type SystemMessageRich,
  type PeerRelay,
  type TimelineEntry,
  type TurnLine,
  type UserMessageKind,
} from "../transcript-model.ts";
import { LinkedMarkdownView, useFilePathCacheTick } from "../filepath-linker.tsx";
import { enqueueFilePathProbe, getFilePathStatus } from "../filepath-existence-cache.ts";
import {
  hrefFromStatEntry,
  viewerPathForAbsolute,
  type FilePathResolveCtx,
} from "../filepath-ref.ts";
import {
  highlightRenderedText,
  removeRenderedTextHighlights,
  setRenderedTextCurrent,
  visibleRenderedText,
} from "../rendered-text-search.ts";
import {
  getPendingHostTranslationCount,
  isTranslationSkippedText,
  hasCachedHostText,
  hasTranslatorApi,
  getTranslationRevision,
  subscribePendingHostTranslation,
  subscribeTranslationRegistry,
  translatedTextOf,
  translateTextInBrowser,
  translateTextOnHost,
  type HostTranslateRequest,
} from "../translate.ts";
import {
  CLOSED_FOLD_SCOPE_KEY,
  loopNextIndex,
  loopPrevIndex,
  matchingUnitKeysOf,
  parseSearchClosedFolds,
  parseSearchQuery,
  serializeSearchClosedFolds,
  unitMatchesOnScreen,
  type SearchUnit,
  type SearchWord,
} from "../in-view-search.ts";
import { readStorage, writeStorage } from "../storage.ts";
import { foldGroupKey, foldPathsByOffset } from "../fold-tree.ts";
import { FoldOpenStore } from "../fold-open-store.ts";
import {
  canPrettyRawLine,
  prettyRawLine,
  setRawViewPretty,
  useRawViewPretty,
  RAW_PRETTY_MAX_CHARS,
} from "../raw-view-mode.ts";
import { foldSummaryView, type FoldSummaryDecoration } from "../timeline-summary.ts";
import {
  agentDirectionMarker,
  peerChannelLabel,
  peerMessagePresentation,
} from "../agent-communication-view.ts";
import { reindexStableSelection } from "../user-nav.ts";
import { forkActionState, liveChain, type ForkActionState } from "../fork-point.ts";
import { isScopedDump, sessionDumpRequest } from "../session-dump-action.ts";
import { forkDividerGroupIndex } from "../fork-divider.ts";
import { saySlots } from "../say-merge.ts";
import { findExistingOneOnOne } from "./OneOnOneComposer.tsx";
import {
  defaultTimelineAutoOpen,
  foldGroupShouldAutoOpen,
  parseTimelineAutoOpenSettings,
  timelineAutoOpenStorageKey,
  toggleTimelineAutoOpen,
  type TimelineAutoOpenSettings,
} from "../timeline-auto-open.ts";
import { SearchBar } from "./SearchBar.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { ErrorView } from "./ErrorView.tsx";
import { InlineDiffViewer, InlineFileViewer } from "./InlineFileViewer.tsx";
import { Tabs } from "./Tabs.tsx";

/**
 * In-view search context threaded down to every SegmentView (DR-0022 §3 —
 * "TL は text/thinking/tool セグメント"). Each Segment is one search "unit",
 * keyed `${offset}-${segIndex}` (offset = its TurnLine's byte offset, stable
 * across a "load older" prepend just like the 👤 nav's userTurnKeys —
 * segIndex disambiguates multiple segments sharing one line). Bundled into a
 * single object rather than five separate props so the FoldGroup/
 * LineView/*Bubble prop-drilling chain only grows by one prop
 * per component.
 */
interface TLSearchCtx {
  words: SearchWord[];
  /** DOM ref registration for rendered-text matching and ↑/↓ navigation. */
  registerRef: (key: string, el: HTMLElement | null) => void;
  /** A mounted unit swapped the text it displays without any fold opening or
   * closing — a thinking segment moving between its original and its ja tab.
   * The 📁-off match set and the highlight ranges are both read off the
   * rendered text, so that swap has to invalidate them the same way a `toggle`
   * does; nothing else fires when only the body changes. */
  notifyDisplayChange: () => void;
}

/**
 * Per-item raw JSONL lookup (kawaz r55 m89: 「個別に raw モードトグルが
 * 欲しい。そのアイテムが raw jsonl 用ビューコンポーネントとトグルされる
 * イメージ」). Keyed by the item's byte offset — the same key the rich view
 * already uses — and returning every jsonl line that item was built from
 * (`itemRawSourceOffsets`: normally the item's own line, plus the merged
 * tool_result line for a tool card). Threaded as context rather than as a
 * prop because the toggle sits on items several levels down the
 * FoldGroup/LineView chain, and every one of them would
 * otherwise have to forward it unchanged.
 */
const ItemRawContext = createContext<((offset: number) => RawTranscriptRow[]) | null>(null);

/** raw / pretty の切替タブ (kawaz r76 m91)。raw 展開のすぐ上に出す (全体 raw
 * ビューの先頭、項目トグルなら展開した行の直前)。設定は raw-view-mode.ts の
 * グローバル store — 全体ビューと項目トグル、複数ペインの Timeline が同じ
 * 1 つの値を見る。`disabled` は「この場に整形できる行が 1 つも無い」場合 —
 * 押しても何も変わらないボタンを生かしておかない。 */
function RawModeTabs({
  disabled = false,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const pretty = useRawViewPretty();
  const setPretty = setRawViewPretty;
  return (
    <div class="tl-raw-mode">
      <button
        type="button"
        class={"tl-thinking-tab" + (pretty ? "" : " active")}
        aria-pressed={!pretty}
        onClick={() => setPretty(false)}
        title="JSONL の行をそのまま表示"
      >
        raw
      </button>
      <button
        type="button"
        class={"tl-thinking-tab" + (pretty ? " active" : "")}
        aria-pressed={pretty}
        disabled={disabled}
        onClick={() => setPretty(true)}
        title={disabled ? disabledReason : "JSON として整形して表示"}
      >
        pretty
      </button>
    </div>
  );
}

/**
 * Wraps one rendered timeline item with a `raw` toggle that swaps it for the
 * verbatim jsonl line(s) it came from. Layout-neutral by construction: the
 * wrapper is a column flex box just like the two containers items live in
 * (`.tl-lines` and `.tl-guided-content`), so a bubble's own `align-self`
 * still decides which side it sits on.
 */
function ItemRawToggle({
  offset,
  uuid,
  selectedPosition = false,
  onSelectPosition,
  children,
}: {
  offset: number;
  uuid?: string;
  selectedPosition?: boolean;
  onSelectPosition?: (uuid: string) => void;
  children: ComponentChildren;
}) {
  const getRows = useContext(ItemRawContext);
  const [raw, setRaw] = useState(false);
  const rows = raw && getRows ? getRows(offset) : [];
  // この項目の行が 1 つも整形できないなら pretty を選ばせない (押しても
  // 全行が raw に落ちるだけ)。項目あたり数行なので毎 render の判定で足りる。
  const anyPretty = rows.some((row) => canPrettyRawLine(row.text));
  return (
    <div
      class={`tl-item${raw ? " tl-item-raw-on" : ""}${selectedPosition ? " tl-position-selected" : ""}`}
      data-timeline-uuid={uuid}
      onClick={(event) => {
        if (!uuid || !onSelectPosition) return;
        const target = event.target as Element;
        if (target.closest("a, button, input, textarea, select, summary")) return;
        onSelectPosition(uuid);
      }}
    >
      {/* ラベルが "raw" ではなく "jsonl" なのは、ccmsg 吹き出し / システム
       * メッセージが本文内に持つ msg|raw タブとの衝突を避けるため — あちらの
       * "raw" は「rich パースを通さない本文テキスト」、こちらは「この項目の
       * 元になった JSONL 行そのもの」で別物。 */}
      <button
        type="button"
        class="tl-item-raw-toggle"
        aria-pressed={raw}
        title={raw ? "この項目をリッチ表示に戻す" : "この項目の元 JSONL 行を表示"}
        onClick={() => setRaw((v) => !v)}
      >
        jsonl
      </button>
      {raw ? (
        rows.length === 0 ? (
          // 対応する行が引けない = 表示の元になった行がキャッシュ外
          // (load older 前) — rich 表示に戻す以外にできることがないので
          // その旨だけ出す。
          <p class="tl-empty">(この項目の元 JSONL 行は読み込み範囲外)</p>
        ) : (
          <>
            <RawModeTabs
              disabled={!anyPretty}
              disabledReason="この項目の JSONL 行は JSON として整形できません"
            />
            {rows.map((row) => (
              <RawLineRow key={row.offset} row={row} />
            ))}
          </>
        )
      ) : (
        children
      )}
    </div>
  );
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
 * thinking / tool_use / tool_result / meta の全展開部で
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
  trailing,
}: {
  ts: string | null;
  label: string;
  open?: boolean;
  decoration?: FoldSummaryDecoration;
  /** Secondary label placed after the main one — which item of this kind the
   * fold holds (an attachment's hook name / file path). */
  trailing?: string | null;
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
      {trailing ? <span class="tl-fold-trailing">{trailing}</span> : null}
    </summary>
  );
}

// エージェント識別子 (avatar + 名前)。`linkify=true` の時だけ名前クリックで
// TL 遷移リンクを描く (kawaz r46m15 の「名前クリックで良いんじゃない?」の
// 適用先を絞る)。kawaz 2026-07-23 追加要件: フォルド閉状態 (= FoldSummary)
// では中身のクリック責務は open/close のみに専念させたいので、そこには
// linkify を渡さない。展開後のバブル内ヘッダ (AgentCard 側) では従来通り
// リンク化する。fold の details toggle と両立させるため click は
// stopPropagation する (バブル内でも fold summary の別 <details> に
// 巻き込まれないよう予防的に維持)。model があれば名前のすぐ右に淡色で
// 並べる (Agent spawn 用。SendMessage / peer-message は model 情報を
// 持たないので undefined で無表示)。
function AgentIdentity({
  name,
  model,
  linkify = false,
}: {
  name: string;
  model?: string;
  linkify?: boolean;
}) {
  const tlHref = useContext(AgentTimelineHrefsContext).get(name);
  return (
    <span class="tl-agent-identity">
      <Avatar seed={`agent:${name}`} size={18} />
      {linkify && tlHref ? (
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

/** Sender-scoped `FilePathResolveCtx` for the session that this Timeline pane
 * belongs to (kawaz r46m62): TL displays this session's own transcript, so
 * the "sender" of every assistant / thinking segment is the session owner
 * itself, and `filepath[:LINE[:COL]]` inline-code tokens should resolve
 * against that session's own cwd/repo_root. Undefined when the daemon has
 * not yet announced the peer row (rare — cleared to plain code, same as
 * before this DR). The `LinkedMarkdownView` at each MarkdownView call site
 * consumes this via useContext. */
const SessionFilePathCtxContext = createContext<FilePathResolveCtx | undefined>(undefined);

interface TimelineAutoOpenContextValue {
  settings: TimelineAutoOpenSettings;
  revision: number;
}

const TimelineAutoOpenContext = createContext<TimelineAutoOpenContextValue>({
  settings: defaultTimelineAutoOpen(false),
  revision: 0,
});

/** Open/closed state for every fold in this Timeline, so that nav can open one
 * whose body is not mounted yet. The value is a store object created once per
 * Timeline, never a new object per toggle — see fold-open-store.ts. */
const FoldOpenContext = createContext<FoldOpenStore>(new FoldOpenStore());

/**
 * A fold's own view of that store: `open` for the `<details>`, `mountBody` for
 * whether to render the body at all.
 *
 * A closed fold's body is 72-96% of a real transcript
 * (docs/findings/2026-08-12-timeline-windowing-design.md) and none of it is
 * visible until the fold opens, so it is not rendered until then. A closed
 * `<details>` is exactly as tall either way, so nothing above or below it
 * moves when the body appears — this buys the node count without any of the
 * scroll-anchoring machinery a windowed list would need.
 *
 * `mountBody` stays true once opened, so closing does not throw away state the
 * reader can see (a translated thinking segment, an item toggled to jsonl).
 */
function useFoldOpen(
  key: string,
  defaultOpen: boolean,
): {
  open: boolean;
  mountBody: boolean;
  setOpen: (open: boolean) => void;
} {
  const store = useContext(FoldOpenContext);
  const [, bump] = useState(0);
  useEffect(() => store.subscribe(key, () => bump((n) => n + 1)), [store, key]);
  const open = store.isOpen(key, defaultOpen);
  useEffect(() => {
    if (open) store.markMounted(key);
  }, [store, key, open]);
  const setOpen = useCallback((next: boolean) => store.set(key, next), [store, key]);
  return { open, mountBody: open || store.isBodyMounted(key), setOpen };
}

/** Fold-group 内で peer 発 CcmsgBubble を描画するために必要な、Timeline 直下で
 * だけ供給できる共有状態のバンドル (r55 m14, kawaz 裁定: peer 発 ccmsg は
 * boundary から外して fold group 内で thinking/agent と同格に扱う)。
 *
 * - now: msg 相対時刻の再描画 tick 値 (useNow)
 * - rooms/peers: CcmsgBubble の rich 表示 (identicon / hue / filepath-linker)
 *   に必要な AppState の投影
 * - visibleCcmsgKeys: `ccmsgRenderTargets` が確定させた「描画するバブル」の
 *   key 集合 (boundary 側と共有)。同じ ccmsg event が両経路に流れても一箇所
 *   だけ残る (kawaz r15 mid=21 の 2 重表示回避方針を維持)
 *
 * boundary 側 CcmsgBubble が使う registerUserTurnRef / onUserTurnClick /
 * selected / navKey は u1 発 (右寄せユーザバブル) 限定の user-nav 用配線で、
 * peer 発 (fold group 内) では未使用 — 本 context には含めない。
 */
interface CcmsgRenderCtxValue {
  now: number;
  rooms: ReadonlyMap<string, RoomState>;
  peers: readonly PeerInfo[];
  visibleCcmsgKeys: ReadonlySet<string>;
}
const CcmsgRenderContext = createContext<CcmsgRenderCtxValue | null>(null);

function useCategoryOpen(
  category: "thinking" | "ccmsg" | "agent",
): [boolean, (open: boolean) => void] {
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

/**
 * Body of a Read card: the file's text, the image it returned, the error it
 * failed with, or a note when no result has been loaded for it.
 *
 * The image is rendered from the base64 the transcript row already carries,
 * as a data URL, rather than from the daemon's /fs-serve endpoint the Files
 * view uses. A Read's subject is often a temp file (a pasted attachment in
 * the per-user ccmsg attachment directory under `$TMPDIR`) that may be gone
 * by the time anyone reads the transcript, and the base64 is exactly what the
 * model was
 * shown — downscaled by the harness, so a full-resolution re-fetch would not
 * be the same picture. Cost of the choice: those bytes (~100-400KB) become a
 * DOM string, so the `<img>` is only mounted once the fold is open.
 */
function FileReadResultView({
  path,
  result,
  open,
}: {
  path: string;
  result: FileToolResult | null;
  open: boolean;
}) {
  if (result === null) {
    return (
      <p class="tl-file-tool-unavailable">
        読み取り結果はまだ読み込まれていません (実行中か、結果の行が読み込み範囲より後)。
        上へスクロールして古い行を読み込むと表示されます。
      </p>
    );
  }
  if (result.kind === "error") {
    return <p class="tl-file-tool-error">{result.message}</p>;
  }
  if (result.kind === "image") {
    return (
      <div class="tl-file-tool-image">
        {open ? (
          <img
            src={`data:${result.mediaType};base64,${result.base64}`}
            width={result.width ?? undefined}
            height={result.height ?? undefined}
            alt={path}
          />
        ) : null}
      </div>
    );
  }
  return <InlineFileViewer path={path} content={result.content} />;
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
          ) : segment.kind === "file-write" ? (
            <InlineFileViewer path={segment.path} content={segment.content} />
          ) : (
            <FileReadResultView path={segment.path} result={segment.result} open={open} />
          )}
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

/**
 * The file body an attachment carried, drawn like a Read card's (kawaz r99
 * m35) — before this, an edited-file or @-mentioned-file row showed only raw
 * JSON with the text as one escaped string.
 *
 * The content comes from the transcript row itself, so the preview works for a
 * file that has since changed or been deleted; the *path* above it links into
 * Files only when the same existence probe the persisted-output link uses says
 * the file is still there. The daemon allowlists these paths for external
 * reads (DR-0024), so an existing file's link resolves rather than 403s.
 */
function AttachmentFileView({ file }: { file: AttachmentFile }) {
  const ctx = useContext(SessionFilePathCtxContext);
  useFilePathCacheTick();
  useEffect(() => {
    if (ctx) enqueueFilePathProbe(ctx.sid, file.path);
  }, [file.path, ctx?.sid]);
  const stat = ctx ? getFilePathStatus(ctx.sid, file.path) : undefined;
  const href =
    ctx && stat && stat !== "pending"
      ? hrefFromStatEntry(
          ctx.sid,
          { path: viewerPathForAbsolute(file.path, ctx.containmentRoot) },
          { path: file.path },
        )
      : null;
  return (
    <div class="tl-attachment-file">
      {href ? (
        <a class="tl-attachment-file-path" href={href}>
          {file.path}
        </a>
      ) : (
        <div class="tl-attachment-file-path">{file.path}</div>
      )}
      <InlineFileViewer path={file.path} content={file.content} startLine={file.startLine} />
    </div>
  );
}

/** The output half of a `! <cmd>` card. Split out because an output row that
 * arrived without its command renders the same block on its own. */
function BashRunOutput({ output }: { output: BashCommandOutput }) {
  const ctx = useContext(SessionFilePathCtxContext);
  const persistedPath = output.persisted?.path ?? null;
  // Gate the link on the same existence probe the inline-code linkifier uses.
  // The sidecar lives beside the transcript rather than inside the session's
  // workspace, so serving it depends on the daemon having folded the stub's
  // path into DR-0024's exact-path `external_files` allowlist. It does, but
  // the probe stays as the affordance's condition: a sidecar that was cleaned
  // up, or a stub the two parsers read differently, then costs a dead link
  // rather than a `path not allowed` error, and the path itself still shows as
  // text the user can open themselves.
  // `useFilePathCacheTick` re-renders this card when the batch answer lands.
  useFilePathCacheTick();
  useEffect(() => {
    if (persistedPath && ctx) enqueueFilePathProbe(ctx.sid, persistedPath);
  }, [persistedPath, ctx?.sid]);
  const persistedStat =
    persistedPath && ctx ? getFilePathStatus(ctx.sid, persistedPath) : undefined;
  const persistedHref =
    persistedPath && ctx && persistedStat && persistedStat !== "pending"
      ? hrefFromStatEntry(
          ctx.sid,
          { path: viewerPathForAbsolute(persistedPath, ctx.containmentRoot) },
          { path: persistedPath },
        )
      : null;
  return (
    <>
      {output.persisted ? (
        <div class="tl-bashrun-persisted">
          <div class="tl-bashrun-persisted-note">{output.persisted.note}</div>
          {persistedHref ? (
            <a
              class="tl-bashrun-persisted-link"
              href={persistedHref}
              target="_blank"
              rel="noopener"
            >
              全文を別タブで開く
            </a>
          ) : null}
          <div class="tl-bash-output-label">preview</div>
          <pre class="tl-bashrun-out">{output.persisted.preview}</pre>
        </div>
      ) : null}
      {output.stdout !== null ? <pre class="tl-bashrun-out">{output.stdout}</pre> : null}
      {output.stderr !== null ? (
        <>
          <div class="tl-bash-output-label">stderr</div>
          <pre class="tl-bashrun-out is-error">{output.stderr}</pre>
        </>
      ) : null}
      {output.persisted === null && output.stdout === null && output.stderr === null ? (
        <div class="tl-bash-result-status">(出力なし)</div>
      ) : null}
    </>
  );
}

/**
 * A TUI `! <cmd>` run, drawn on the user side of the conversation as a
 * terminal execution rather than as speech (kawaz r76m20). Deliberately not a
 * `<details>` fold: unlike the harness plumbing that surrounds it this is
 * something the user typed and expects to see, so it stays open and the
 * *output* is what gets bounded — `max-height` + scroll in CSS, with the
 * oversized case already reduced by Claude Code itself to a preview plus a
 * link to the full bytes (see `BashCommandOutput`).
 */
function BashRunCard({
  command,
  output,
  ts,
}: {
  command: string | null;
  output: BashCommandOutput | null;
  ts: string | null;
}) {
  return (
    <div class="tl-line tl-bashrun">
      <div class="tl-file-tool-card tl-bash-card">
        <div class="tl-bashrun-head">
          <span class="tl-bashrun-badge">shell</span>
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
        </div>
        {command !== null ? (
          <div class="tl-bash-command">
            <CodeBlock code={command || "(空のコマンド)"} lang="bash" />
          </div>
        ) : null}
        {output ? <BashRunOutput output={output} /> : null}
        {command !== null && output === null ? (
          <div class="tl-bash-result-status">実行中 / 結果なし</div>
        ) : null}
      </div>
    </div>
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
  title,
  body,
  model,
  channelLabel,
}: {
  name: string;
  direction: "inbound" | "outbound";
  title?: string | null;
  body: string;
  /** Transport this message rode (`peerChannelLabel`) — shown as one quiet
   * chip on the header's right edge so a Claude Code cross-session peer can
   * be told from an in-process teammate without giving it a different bubble.
   * `null`/undefined for the unmarked default. */
  channelLabel?: string | null;
  // Agent spawn 用: モデル名は名前のすぐ右に淡色で並べる (kawaz r46m15:
  // 「モデル名は名前のすぐ右に置くとかで良いんじゃない?他の 2 エージェント
  // メッセージタイプのやつも」)。SendMessage / peer-message はモデル情報を
  // 持たないので undefined。
  model?: string;
}) {
  const marker = agentDirectionMarker(direction);
  // AgentCard の展開表示は CcmsgBubble (別セッション間 msg) と同じ rich
  // バブル形式に統一する (kawaz r55m29 裁定: 「もういいよ ccmsg 形式でさ。
  // そこから微調整していく」)。hue seed は AgentIdentity アイコンと同じ
  // `agent:${name}` — 同画面に並ぶ AgentCard とアイコンで色が揃う。左寄せ
  // (`.tl-bubble-left`) + max-width 85% で右端 (ユーザエリア) に触れさせない。
  //
  // ヘッダ順序 (kawaz r55m33): 行頭に direction marker (🤖← / 🤖→)、続けて
  // 相手セッションの icon + 名前 (model chip があれば名前の右)。peer-message
  // はルーム経由ではないため 🏠 room 表記は付けない (kawaz r55m32 で撤回)。
  // 右上の "送信 / 受信 / new / タスク指示 …" badge チップは kawaz 指示外
  // の改変だったので撤去し、direction は marker で表現する。
  // body は plain pre-wrap ではなく LinkedMarkdownView で描画: SendMessage /
  // spawn の prompt に含まれる `path:line` を TL 側同様にリンク化する
  // (filePathCtx はセッション owner の SessionFilePathCtxContext を使う)。
  const filePathCtx = useContext(SessionFilePathCtxContext);
  const hue = hueForSeed(`agent:${name}`);
  return (
    <div
      class={`tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-agent tl-bubble-agent-${direction}`}
      style={{ "--member-hue": String(hue) }}
    >
      <div class="tl-bubble-body">
        <div class="tl-bubble-from tl-agent-card-head">
          <span class="tl-agent-direction-marker">{marker}</span>
          <AgentIdentity name={name} model={model} linkify />
          {channelLabel ? (
            <span
              class="tl-agent-badge"
              title="Claude Code ネイティブのセッション間メッセージ (SendMessage / ListAgents)"
            >
              {channelLabel}
            </span>
          ) : null}
        </div>
        {title ? <div class="tl-agent-title">{title}</div> : null}
        {body ? (
          <div class="tl-agent-md">
            <LinkedMarkdownView source={body} ctx={filePathCtx} />
          </div>
        ) : null}
      </div>
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
  // translateTextOnHost が英語段落ごとに 1 op を送るための
  // ws.translate ラッパ。複数 thinking・複数段落をまとめず、各 op を独立して
  // 並列実行する (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  hostRequest: HostTranslateRequest;
}

type TranslationTab = "original" | "ja-host" | "ja-browser";

/** 翻訳タブ 1 行分の items。availability が false の経路はタブ自体を出さない
 * (見せる view が無い)。thinking と assistant 応答で同じ並びを使う。 */
function translationTabItems(
  availability: TranslationAvailability,
): { id: TranslationTab; label: string }[] {
  return [
    { id: "original", label: "original" },
    ...(availability.host ? [{ id: "ja-host" as const, label: "ja(host)" }] : []),
    ...(availability.browser ? [{ id: "ja-browser" as const, label: "ja(browser)" }] : []),
  ];
}

/** 選択中の翻訳タブに対応する本文と、翻訳中の進捗ラベルを供給する。
 *
 * タブの選択状態は呼び出し側が持つ — thinking は segment ごとに 1 タブ列、
 * assistant 応答はバブルの hover ツールバー 1 つがその中の text segment 全部
 * を束ねる、と所有者が違うため。ここが持つのは「この text をこの経路で訳した
 * 結果」だけで、選択中のタブにまだ訳が無ければその経路の翻訳を起動する。
 *
 * 訳文は原文とペアで保持する: text 自体が差し替わった (tail 追記で行が
 * 読み直された) 時に、前の原文の訳をそのまま出し続けないため。
 *
 * 保持する訳は「途中経過 (done: false)」と「完成訳 (done: true)」の 2 相を
 * 取る。長い thinking は段落数だけ翻訳 op が直列に並ぶので、完成まで待つと
 * 数分間 1 文字も変わらない — 段落の訳が届くたびに途中経過で差し替えて、
 * 訳せたところから順に日本語になっていくようにする。done は「もう起動し
 * 直さなくてよい / 進捗ラベルを消してよい」の判定に要るので、途中経過とは
 * 区別して持つ (途中経過の text で代用すると、再マウントや再選択のたびに
 * 途中で止まった訳を完成扱いしてしまう)。 */
interface TranslatedBody {
  source: string;
  text: string;
  done: boolean;
}

function useTranslatedText(
  text: string,
  availability: TranslationAvailability,
  tab: TranslationTab,
  /** 表示中の綴りが差し替わった時に呼ばれる (in-view search の再計算契機)。 */
  onDisplayChange?: () => void,
): { bodyText: string; translatingLabel: string | null } {
  const [host, setHost] = useState<TranslatedBody | null>(null);
  const [browser, setBrowser] = useState<TranslatedBody | null>(null);
  // 「今この原文を訳している最中」を原文そのもので表す (boolean だと text が
  // 変わった時に前の原文の進行中フラグと区別できない)。
  const [hostPending, setHostPending] = useState<string | null>(null);
  const [browserPending, setBrowserPending] = useState<string | null>(null);

  const hostBody = host !== null && host.source === text ? host : null;
  const browserBody = browser !== null && browser.source === text ? browser : null;
  const hostText = hostBody?.text ?? null;
  const browserText = browserBody?.text ?? null;
  const hostDone = hostBody?.done ?? false;
  const browserDone = browserBody?.done ?? false;
  const hostTranslating = hostPending === text;
  const browserTranslating = browserPending === text;

  useEffect(() => {
    if (tab === "ja-host") {
      if (!availability.host || hostDone || hostTranslating) return;
      setHostPending(text);
      // 途中経過は「この原文の翻訳を今走らせている自分」だけが書く。text が
      // 差し替わった後に前の原文の遅れた partial が届いても source が違うので
      // 表示には出ない (hostBody の source 一致判定で落ちる)。
      void translateTextOnHost(text, availability.hostRequest, (partial) =>
        setHost({ source: text, text: partial, done: false }),
      )
        .then((result) => setHost({ source: text, text: result, done: true }))
        // 経路ごと失敗した時は原文へ倒す (タブは選ばれたまま、内容は原文)。
        .catch(() => setHost({ source: text, text, done: true }))
        .finally(() => setHostPending((pending) => (pending === text ? null : pending)));
      return;
    }
    if (tab === "ja-browser") {
      if (!availability.browser || browserDone || browserTranslating) return;
      setBrowserPending(text);
      void translateTextInBrowser(text, (partial) =>
        setBrowser({ source: text, text: partial, done: false }),
      )
        .then((result) => setBrowser({ source: text, text: result, done: true }))
        .finally(() => setBrowserPending((pending) => (pending === text ? null : pending)));
    }
  }, [
    tab,
    text,
    availability.host,
    availability.browser,
    availability.hostRequest,
    hostDone,
    browserDone,
    hostTranslating,
    browserTranslating,
  ]);

  const bodyText =
    tab === "ja-host" && hostText !== null
      ? hostText
      : tab === "ja-browser" && browserText !== null
        ? browserText
        : text;

  // The first body a unit renders needs no notification: whoever reads the
  // rendered text already re-runs when a unit mounts. Only a later swap of the
  // same unit's body is invisible to them.
  const displayedTextRef = useRef(bodyText);
  useEffect(() => {
    if (displayedTextRef.current === bodyText) return;
    displayedTextRef.current = bodyText;
    onDisplayChange?.();
  }, [bodyText, onDisplayChange]);

  // 訳が入った直後の 1 render (state 更新と pending 解除が別 microtask) で
  // 「本文は訳文なのに翻訳中」と出さないよう、完成の有無も条件に含める。
  // 判定に使うのは done であって本文の有無ではない — 途中経過が入っている
  // 間はまだ残りの段落を訳しているので、ラベルは出したままにする。
  const translating =
    (tab === "ja-host" && hostTranslating && !hostDone) ||
    (tab === "ja-browser" && browserTranslating && !browserDone);

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

  return { bodyText, translatingLabel };
}

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
      onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}
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

  // The host route is the default comparison result when both are present: it
  // is the dictionary-like path this feature adds, while browser remains an
  // independently selectable comparison surface.
  function selectDefaultTranslation() {
    // 全段落が日本語等で翻訳 skip されるテキストは original のまま (kawaz
    // r38 mid=54) — 訳タブを選んでも内容が原文と同一で、確認クリックの
    // 無駄を生むだけ。
    if (isTranslationSkippedText(text)) return;
    if (translationAvailability.host) setTab("ja-host");
    else if (translationAvailability.browser) setTab("ja-browser");
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
    if (translationAvailability.host && hasCachedHostText(text)) {
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

  const hasTranslationTab = translationAvailability.host || translationAvailability.browser;

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

function SegmentView({
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

// システム由来 user メッセージの rich 表示 (U2 kawaz spec): transcript-model.ts's
// parseSystemMessageFields が返す SystemMessageRich の 3 レイアウトを描画する
// だけの純表示コンポーネント — パース自体は行わない (ロジックは transcript-
// model.ts 側でユニットテスト可能に保つ、他の *-model.ts / Timeline.tsx の
// 分業と同じ)。"event" フィールドだけ等幅フォントを当てる (kawaz spec:
// 「event 本文は monospace で」) — task-notification 以外の kind がたまたま
// 同名フィールドを持つことは想定していないが、フィールド名一致だけで判定する
// のでどの kind から来ても等幅になる (副作用として無害)。
type PeerMessageRich = PeerRelay;

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
          {presentation.channelLabel ? (
            <span class="tl-agent-idle-channel">{presentation.channelLabel}</span>
          ) : null}
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
    case "bash":
      // Reached only when a `! <cmd>` row somehow renders through the
      // system-message path instead of standing on its own (an unpaired half
      // whose sibling never arrived, a hand-built line). Same card either way
      // so the two paths can't look different.
      return <BashRunCard command={rich.command} output={rich.output} ts={null} />;
    case "peer": {
      // One card (or compact idle row) per relayed turn — a relay line often
      // batches several, and each stands on its own.
      return (
        <>
          {rich.relays.map((relay, i) =>
            peerMessagePresentation(relay).kind === "idle" ? (
              <IdlePeerRow key={i} peer={relay} ts={null} />
            ) : (
              <AgentCard
                key={i}
                name={relay.from}
                direction="inbound"
                title={relay.summary}
                body={relay.body}
                channelLabel={peerChannelLabel(relay.channel)}
              />
            ),
          )}
        </>
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
      <Tabs
        class="tl-thinking-tabs"
        tabClass="tl-thinking-tab"
        label="システムメッセージの表示"
        selected={tab}
        onSelect={setTab}
        items={[
          { id: "rich", label: "rich" },
          { id: "raw", label: "raw" },
        ]}
      />
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
  const relays = rich.display === "peer" ? rich.relays : [];
  // A line carrying only idle notifications never becomes a fold: each is
  // demoted to its own compact row. One that also carries a real relayed turn
  // keeps the fold — the fold's identity comes from that turn, not the idle
  // noise it happened to be batched with.
  if (relays.length > 0 && relays.every((relay) => relay.category === "idle")) {
    return (
      <>
        {relays.map((relay, i) => (
          <IdlePeerRow key={i} peer={relay} ts={line.ts} />
        ))}
      </>
    );
  }
  const peer = relays.find((relay) => relay.category !== "idle") ?? relays[0] ?? null;
  // peer 形に落ちたものがエージェントメッセージのカテゴリ (kawaz r55 m35:
  // AUTO OPEN の A チェックで開いておいてほしい対象)。spawn prompt は
  // wrapper の有無に関わらず parseSystemMessageFields が peer 形を返すので
  // (r55m155)、ここで kind を個別に見る必要はない。
  const isAgentCategory = peer !== null;
  const open = isAgentCategory ? agentOpen : manualOpen;
  const setOpen = isAgentCategory ? setAgentOpen : setManualOpen;
  const taskSummary =
    kind === "task-notification" && rich.display === "fields" ? rich.heading : null;
  // kind 文字列は internal enum なので UI に出す時だけ人間可読形へ (現状
  // spawn-prompt のみ special-case、他 kind は enum ラベルのまま踏襲)。
  // A cross-session relay is still `peer-message` on the wire, but naming the
  // transport in the closed summary is what makes the fold readable without
  // opening it — the peer's channel is the one thing the kind enum can't say.
  const kindLabel =
    kind === "spawn-prompt"
      ? "spawn prompt"
      : peer?.channel === "cross-session"
        ? "cross-session"
        : kind;
  // `! <cmd>` の入力行は閉じたままでも何を実行したか分かるように、summary に
  // コマンドそのものを出す (出力行は本文側にしかないので kindLabel のまま)。
  const bashCommand = rich.display === "bash" ? rich.command : null;
  // Closed summary names the relay the fold is identified by; the rest of a
  // batched line is counted so nothing inside is invisible while it is closed.
  const extraRelays = relays.length - 1;
  const label = peer
    ? `${kindLabel} ← ${peer.from}${extraRelays > 0 ? ` +${extraRelays}` : ""}`
    : bashCommand !== null
      ? `$ ${bashCommand}`
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

/** fold group 内で peer 発 ccmsg messages を描画する (r55 m14 kawaz 裁定)。
 * CcmsgBubble を再利用するため、boundary 側 (Timeline() 直下) と同じ props
 * を組み立てる。共有状態 (now / rooms / peers / visibleCcmsgKeys) は
 * CcmsgRenderContext から取る。どのバブルを出すかは `ccmsgRenderTargets` が
 * 分類フェーズで確定済み — ここは key の在否を読むだけ (render 中に dedup
 * 状態を書き換えない: fold の開閉は Timeline 本体を再実行しないため、
 * render 中の mutation では 2 回目以降の pass で自分を消してしまう)。
 * u1 発は含まれない前提 (classifyBoundaryLine で boundary に格上げされて
 * いる) — 万一混じっても同じ key 集合で dedup される。 */
function PeerCcmsgLineView({
  line,
  offset,
  messages,
  searchCtx,
}: {
  line: TurnLine;
  offset: number;
  messages: CcmsgMessage[];
  searchCtx: TLSearchCtx | undefined;
}) {
  const ctx = useContext(CcmsgRenderContext);
  if (ctx === null) {
    // 供給元 (Timeline) の Provider 外で呼ばれた場合の防御 — 実運用では
    // ここに来ない (Timeline は常に Provider を張るため)。
    return null;
  }
  // raw タブ用: boundary 側と同ロジック (text segment 結合)。
  const rawText = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  return (
    <>
      {messages.map((m, j) => {
        if (!ctx.visibleCcmsgKeys.has(ccmsgUnitKey(offset, j))) return null;
        return (
          // 1 行から複数バブルが出るケース: どのバブルの jsonl トグルも同じ
          // 行を指す (itemRawSourceOffsets の doc comment 参照)。
          <ItemRawToggle key={`${offset}-${j}`} offset={offset}>
            <CcmsgBubble
              message={m}
              rawText={rawText}
              now={ctx.now}
              searchKey={ccmsgUnitKey(offset, j)}
              searchCtx={searchCtx}
              // navKey/register/onUserTurnClick/selected は u1 (右寄せ user
              // bubble) 用の user-nav 配線。peer 発では未使用なので undefined /
              // false 固定 (userNavTargets 側も message.from !== "u1" を弾く
              // ためここに来る対象は元々 nav 対象外)。
              registerUserTurnRef={NOOP_REGISTER_REF}
              onUserTurnClick={NOOP_ON_CLICK}
              selected={false}
              room={ctx.rooms.get(m.room)}
              peers={ctx.peers}
            />
          </ItemRawToggle>
        );
      })}
    </>
  );
}

const NOOP_REGISTER_REF = (_key: string, _el: HTMLElement | null) => {};
const NOOP_ON_CLICK = (_navKey: string) => {};

// fold group 内 (非境界) の 1 entry を描画する — thinking/tool_use-only の
// assistant turn、tool-result-only の user turn、meta 行、broken 行、
// そしてシステム由来 user メッセージ (ccmsg メッセージを含まないもの、含む
// 場合は u1 発なら境界として CcmsgBubble 側、peer 発なら本関数内
// PeerCcmsgLineView 経由で CcmsgBubble を直接描画) を扱う。u1 発本物の
// ユーザ発話 / アシスタント最終応答 / u1 発 ccmsg は Timeline() 側の
// UserPromptBubble/AssistantBubble/CcmsgBubble が担当するため、
// registerUserTurnRef はここでは不要 (fold group 内に isUserTextTurn な行は
// 絶対に来ない — classifyBoundaryLine が boundary として弾くため、u1 発
// ccmsg も同様)。
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
      <ItemRawToggle offset={offset}>
        <div class="tl-line tl-broken">
          <pre class="tl-broken-raw">{line.raw || "(空行)"}</pre>
        </div>
      </ItemRawToggle>
    );
  }
  if (line.kind === "meta") {
    // attachment 行だけは共通 chrome (`attachment <type>`) + type 別詳細を出す
    // — 種類が多く、閉じたままでは全部が同じ「attachment」に見えるため。詳細を
    // 持たない type は従来どおり raw JSON だけになる。
    const attachment = line.attachment;
    return (
      <ItemRawToggle offset={offset}>
        <details class="tl-line tl-fold">
          <FoldSummary
            ts={line.ts}
            label={attachment ? `attachment ${attachment.type}` : line.summary}
            trailing={attachment?.trailing}
          />
          {attachment && attachment.fields.length > 0 ? (
            <dl class="tl-sysmsg-dl">
              {attachment.fields.map((f) => (
                <div class="tl-sysmsg-field" key={f.name}>
                  <dt>{f.name}</dt>
                  <dd class={f.name === "event" ? "tl-sysmsg-mono" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {attachment?.file ? <AttachmentFileView file={attachment.file} /> : null}
          <pre class="tl-fold-body">{line.raw}</pre>
        </details>
      </ItemRawToggle>
    );
  }
  // r55 m14 (peer ccmsg を fold group 内で thinking/agent と同格に): この
  // line が peer 発 (u1 以外) の ccmsg messages を運んでいるなら、SystemMessageFold
  // に落とさず CcmsgBubble を直接描画する — boundary 側と同じ吹き出し UI に
  // 揃え、閉時は thinking/agent と同トーンの 1 行 summary が出る。u1 発を含む
  // 行は classifyBoundaryLine が boundary に格上げして Timeline トップで
  // 処理するのでここには来ない (groupTimelineLines の isBoundaryLine 経由)。
  const peerCcmsgMessages = line.kind === "turn" ? extractCcmsgMessages(line) : [];
  if (peerCcmsgMessages.length > 0) {
    return (
      <PeerCcmsgLineView
        line={line as TurnLine}
        offset={offset}
        messages={peerCcmsgMessages}
        searchCtx={searchCtx}
      />
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
    line.role === "user" && line.userMessageKind && !isUserSpeechKind(line.userMessageKind)
      ? line.userMessageKind
      : null;
  if (sysKind) {
    return (
      <ItemRawToggle offset={offset}>
        <SystemMessageFold
          kind={sysKind}
          line={line}
          translationAvailability={translationAvailability}
          foldGroupOpen={foldGroupOpen}
        />
      </ItemRawToggle>
    );
  }
  // cache-keepalive 応答 (kawaz r259 m60): text segment 1 個だけの assistant
  // turn なので、下の既定経路では SegmentView の text 分岐に落ちてトークンの
  // 生文字列が ▶ も時刻もラベルも無しで裸で並ぶ — 同じ fold 内の
  // task-notification / queue-operation 行と揃わない。システム由来 user
  // メッセージ (SystemMessageFold) と同じ「▶ 時刻 ラベル」の 1 行に畳み、
  // 中身はトークンそのものを開いてから見せる。
  if (isCacheKeepaliveReplyLine(line)) {
    return (
      <ItemRawToggle offset={offset}>
        <details class="tl-line tl-fold">
          <FoldSummary ts={line.ts} label={CACHE_KEEPALIVE_FOLD_LABEL} />
          <pre class="tl-fold-body">{segmentSearchText(line.segments[0]!)}</pre>
        </details>
      </ItemRawToggle>
    );
  }
  // 残り: thinking/tool_use-only の assistant turn、tool-result-only の
  // user turn — 中身の各 segment 自体が (SegmentView 経由で) fold 済みの
  // 1 行 summary を持つので、turn の外枠はプレーンな container のまま
  // (二重に時刻を出さない)。
  return (
    <ItemRawToggle offset={offset}>
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
    </ItemRawToggle>
  );
}

// LineView and FoldGroup (each memoized right where it is
// defined) render the fold side of the timeline, which is 73-96% of every
// entry in a real transcript — and a live tail re-rendered the whole of it
// once per appended line, because Preact recurses into every child of a
// re-rendered parent whether or not its props moved. Memoizing them narrows
// the re-render to the groups that actually changed: 2360 -> 3 fold-side
// component renders per appended line, measured on a 2180-line window.
//
// This only pays off because incremental-cross-line.ts hands back the *same*
// `entries` array for an unchanged group. Two other props have to hold still
// for the same reason, and are memoized in Timeline() below for it:
// `translationAvailability` and `searchCtx`.
const MemoLineView = memo(LineView);

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
  // The auto-open settings are this group's *default*; Timeline drops every
  // stored override when their revision changes, so a settings edit lands here
  // without the store having to know what any group's default is.
  const { open, mountBody, setOpen } = useFoldOpen(foldGroupKey(entries), groupAutoOpen);
  const thinkingCount = useMemo(
    () =>
      entries.filter(
        ({ line }) =>
          line.kind === "turn" &&
          line.segments.some(
            (segment) => segment.kind === "thinking" || segment.kind === "thinking-hidden",
          ),
      ).length,
    [entries],
  );
  const ccmsgCount = useMemo(
    () => entries.reduce((count, entry) => count + ccmsgMessageCount(entry), 0),
    [entries],
  );
  const agentMessageCount = useMemo(
    () => entries.reduce((count, entry) => count + agentCommunicationCount(entry), 0),
    [entries],
  );
  const itemCount = useMemo(
    () => entries.filter((entry) => !isDirectFoldEntry(entry)).length,
    [entries],
  );
  // 単独の plain item は fold を作らず直接見せる (kawaz r38 mid=44)。
  if (!foldGroupNeedsOuterFold(entries)) {
    const { offset, line } = entries[0]!;
    return (
      <div class="tl-guided-content">
        <MemoLineView
          line={line}
          offset={offset}
          translationAvailability={translationAvailability}
          foldGroupOpen={false}
          searchCtx={searchCtx}
        />
      </div>
    );
  }
  return (
    <details
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
        {thinkingCount > 0 || ccmsgCount > 0 || agentMessageCount > 0 ? (
          <>
            {thinkingCount > 0 ? (
              <span class="tl-summary-thinkings">{thinkingCount} thinking</span>
            ) : null}
            {ccmsgCount > 0 ? (
              <>
                {thinkingCount > 0 ? " + " : ""}
                <span class="tl-summary-ccmsg">{ccmsgCount} ccmsg</span>
              </>
            ) : null}
            {agentMessageCount > 0 ? (
              <>
                {thinkingCount > 0 || ccmsgCount > 0 ? " + " : ""}
                <span class="tl-summary-agent-messages">{agentMessageCount} agent messages</span>
              </>
            ) : null}
            {itemCount > 0 ? (
              <>
                {thinkingCount > 0 || ccmsgCount > 0 || agentMessageCount > 0 ? " + " : ""}
                <span class="tl-summary-items">{itemCount} items</span>
              </>
            ) : (
              ""
            )}
          </>
        ) : (
          foldGroupLabel(entries)
        )}
      </summary>
      <div class="tl-fold-group-body tl-guided">
        <FoldGuide />
        <div class="tl-guided-content">
          {mountBody
            ? entries.map(({ offset, line }) => (
                <MemoLineView
                  key={offset}
                  line={line}
                  offset={offset}
                  translationAvailability={translationAvailability}
                  foldGroupOpen={open}
                  searchCtx={searchCtx}
                />
              ))
            : null}
        </div>
      </div>
    </details>
  );
}

const MemoFoldGroup = memo(FoldGroup);

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
  registerUserTurnRef: (key: string, el: HTMLElement | null) => void;
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
      <div class="tl-bubble-body">
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

/** assistant バブルのハンバーガーから開く「重い操作」一式に必要なもの。
 *
 * fork / dump は URL の選択位置 (`position`) に紐づく操作のままで、バブルの
 * ツールバーは**その置き場所**を増やすだけ (kawaz 裁定: 不可逆・重い操作は
 * 明示選択のまま、hover だけで発火させない)。ハンバーガーを開く操作自体が
 * その明示選択に当たるので、開いた項目をその場で選択位置にする。 */
interface BubbleActions {
  sid: string;
  /** 現在の選択位置 (URL の position、無選択なら "head")。 */
  position: string;
  forkAction: ForkActionState;
  forkAvailable: boolean;
  onFork: (resumeAt: string) => void;
  /** この項目を選択位置にする (選択済みなら呼ばない — toggle なので外れる)。 */
  onSelect: (uuid: string) => void;
}

function BubbleActionsMenu({ actions }: { actions: BubbleActions }) {
  return (
    // 本文クリックは項目選択のトグルなので、メニュー内の余白 / 説明文への
    // クリックがそこへ伝播すると、開いたばかりのメニューの足元 (選択位置) が
    // 外れる。メニューの中はメニューの中で完結させる。
    <div class="tl-msg-menu" onClick={(e) => e.stopPropagation()}>
      <ForkAction
        state={actions.forkAction}
        available={actions.forkAvailable}
        onFork={actions.onFork}
      />
      <DumpFileAction sid={actions.sid} position={actions.position} />
    </div>
  );
}

function AssistantBubble({
  line,
  offset,
  translationAvailability,
  now,
  searchCtx,
  actions,
}: {
  line: TurnLine;
  offset: number;
  translationAvailability: TranslationAvailability;
  now: number;
  searchCtx: TLSearchCtx | undefined;
  /** 重い操作 (fork / dump) の材料。agent TL のように選択位置を表せない
   * 文脈では undefined で、ハンバーガー自体を出さない。 */
  actions: BubbleActions | undefined;
}) {
  // 既定は常に original (kawaz r135m50)。thinking のような自動選択はしない。
  const [tab, setTab] = useState<TranslationTab>("original");
  const [source, setSource] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasTranslationTab = translationAvailability.host || translationAvailability.browser;

  // Reconnect can replace a macOS daemon with a non-capable daemon (same guard
  // as ThinkingSegment): a selected host tab must fall back to original rather
  // than keep showing text no live route can produce.
  useEffect(() => {
    if (tab === "ja-host" && !translationAvailability.host) setTab("original");
  }, [tab, translationAvailability.host]);

  // メニューは選択位置に紐づいて意味を持つので、選択が他の項目へ移ったら
  // 畳む (残しても「fork 地点を選んでください」しか出せない)。
  const selectedHere = actions !== undefined && actions.position === line.uuid;
  useEffect(() => {
    if (menuOpen && !selectedHere) setMenuOpen(false);
  }, [menuOpen, selectedHere]);

  // メニューは本文の上に重なるオーバーレイなので、外側を触ったら畳む
  // (置きっぱなしだと下の項目が押せない)。ツールバーごと囲うことで、翻訳
  // タブ等の隣接操作では閉じない。
  const toolbarRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(toolbarRef, menuOpen, () => setMenuOpen(false));
  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

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
            assistantView={{ tab, source }}
          />
        ))}
      </div>
      {/* 時刻と同じ 1 行に置く: ツールバーは通常 opacity 0 なので、行の高さが
       * hover で動かない (本文の上に重ねると 1 行目の右端を隠す、本文の下に
       * 出し入れするとレイアウトが跳ねる)。 */}
      <div class="tl-bubble-footer">
        {line.ts ? <span class="tl-bubble-time">{formatMsgTime(line.ts, now)}</span> : null}
        <div class={`tl-msg-toolbar${menuOpen ? " tl-msg-toolbar-open" : ""}`} ref={toolbarRef}>
          {hasTranslationTab ? (
            <Tabs
              class="tl-thinking-tabs"
              tabClass="tl-thinking-tab"
              label="本文の言語"
              selected={tab}
              onSelect={setTab}
              items={translationTabItems(translationAvailability)}
            />
          ) : null}
          <Tabs
            class="tl-thinking-tabs"
            tabClass="tl-thinking-tab"
            label="本文の表示形式"
            selected={source ? "source" : "md"}
            onSelect={(id) => setSource(id === "source")}
            items={[
              { id: "md", label: "md", title: "markdown として表示" },
              { id: "source", label: "source", title: "markdown の原文を表示 (コピペ用)" },
            ]}
          />
          {actions === undefined ? null : (
            // ☰ とメニューを同じ包みに入れる: メニューはこの包みを基準に
            // 絶対配置され、TL のレイアウトを一切動かさない。
            <div class="tl-msg-menu-anchor">
              <button
                type="button"
                class="tl-thinking-tab tl-msg-menu-toggle"
                aria-expanded={menuOpen}
                aria-label="この項目の操作"
                title="fork / dump"
                onClick={() => {
                  const next = !menuOpen;
                  // 開く操作 = この項目を fork/dump の対象に決める明示選択。
                  if (next && !selectedHere && line.uuid) actions.onSelect(line.uuid);
                  setMenuOpen(next);
                }}
              >
                ☰
              </button>
              {menuOpen ? <BubbleActionsMenu actions={actions} /> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Claude Code's synthesized "the turn was cut short" line
 * (`assistantMessageKind === "api-error"`, transcript-model.ts) — main-context
 * overflow, API failure, usage limit, ... It wears the wire "assistant" role,
 * so AssistantBubble would render it as the agent's own final response
 * (purple bubble, markdown), which reads as "the agent said this".
 *
 * Rendered as a danger-colored notice row rather than a chat bubble: the
 * bubble shape *is* the "someone spoke" signal in this Timeline (user green /
 * assistant purple / peer blue), so anything that isn't speech must leave it.
 * It stays a standalone boundary entry (not folded into the surrounding tools
 * group like system-origin user lines are) because it marks where a turn
 * ended — the same structural role `assistant-response` plays — and because a
 * failure that cost a whole turn shouldn't need a click to notice.
 *
 * Body text is rendered verbatim (no markdown): the wording is the upstream
 * CLI's — sometimes a raw JSON error payload — not authored prose. */
function ApiErrorNotice({ line }: { line: TurnLine }) {
  const text = systemMessageRawText(line);
  return (
    <div
      class="tl-line tl-api-error"
      title="Claude Code が報告した turn の中断 (エージェントの発話ではない)"
    >
      {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
      <span class="tl-api-error-label">turn interrupted</span>
      {text === "" ? (
        <span class="tl-empty-turn">(空)</span>
      ) : (
        <span class="tl-api-error-text">{text}</span>
      )}
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

/** 保持する (room, mid) 数の上限。1 セッションで開く transcript が増えるほど
 * 別々の key が積み上がり、値は msg 本文なので 1 件が小さいとも限らない。
 * 溢れた key は「まだ fetch していない」状態に戻るだけで、次にその bubble が
 * mount された時に read し直される (= "failed" と同じ復帰経路)。 */
const CCMSG_BODY_CACHE_MAX_ENTRIES = 256;

function setCcmsgBody(key: string, entry: CcmsgBodyCacheEntry): void {
  setBounded(CCMSG_BODY_CACHE, key, entry, CCMSG_BODY_CACHE_MAX_ENTRIES);
}

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
          setCcmsgBody(key, "failed");
          return null;
        }
        const m = resp.msgs[0]!;
        const body: CcmsgReadBody = {
          from: m.from,
          ...(m.to ? { to: m.to } : {}),
          msg: m.msg,
          ts: m.ts,
        };
        setCcmsgBody(key, body);
        return body;
      })
      .catch(() => {
        setCcmsgBody(key, "failed");
        return null;
      });
    setCcmsgBody(key, p);
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
  room,
  peers,
}: {
  message: CcmsgMessage;
  rawText: string;
  now: number;
  navKey?: string;
  registerUserTurnRef: (key: string, el: HTMLElement | null) => void;
  onUserTurnClick: (navKey: string) => void;
  selected: boolean;
  // In-view search (DR-0022 §3, extended by kawaz r26 mid=97's 💬 target
  // toggle): undefined whenever the ccmsg target toggle is off, mirroring
  // SegmentView's searchCtx={undefined} convention for out-of-scope units —
  // only message.msg (the "msg" tab) is searchable, the raw fallback tab
  // stays unhighlighted like every other raw fallback in this file.
  searchKey: string;
  searchCtx: TLSearchCtx | undefined;
  /** ROOM チャットの MsgItem と同じ rich 表示 (identicon / memberLabel /
   * hue カラー / filepath-linker) をするための解決元。`message.room` の
   * RoomState は AppState.rooms 由来で、まだ届いていない (subscribe 前 /
   * 破棄済み) 場合は undefined — その時は id そのままの from 表記に
   * degrade する (アイコン非表示・memberLabel は id 返し・hue は from
   * id 自体を seed に fallback、これは ROOM 側 MsgItem と同じ挙動)。 */
  room: RoomState | undefined;
  peers: readonly PeerInfo[];
}) {
  const [tab, setTab] = useState<"msg" | "raw">("msg");
  // peer 側 bubble は thinking と同じ fold パターンに乗せる (kawaz r55 m10)。
  // auto-open は独立軸 "ccmsg" (C トグル、kawaz r55 m11) で制御 — TL 既定は
  // C=on (自 TL に届く peer ccmsg は主要文脈)、agent TL は C=off (peer 会話
  // よりも agent 通信/items を主にする defaultTimelineAutoOpen 参照)。
  const [foldOpen, setFoldOpen] = useCategoryOpen("ccmsg");
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
  // バルーン配色は ROOM 側 MsgItem と同一の bubbleHue (room 基準色 + room 内
  // member の nth 等分割、kawaz r55m54/m56)。同じ room の同じ発言者なら ROOM /
  // TL で同色になる。room 未解決なら undefined = 無彩色 degrade。
  const hue = isUser ? undefined : bubbleHue(room, from || message.from);
  // filePathCtxForSender は ROOM 側と同じ helper。room が未解決な場面では
  // undefined を返し LinkedMarkdownView が MarkdownView に degrade する
  // (プレーン表示、既存挙動と同じ)。
  const filePathCtx = room ? filePathCtxForSender(room, peers, from) : undefined;
  const isMatch = searchCtx !== undefined && searchCtx.words.length > 0;
  const innerBubble = (
    <div
      class={`${
        isUser
          ? "tl-bubble tl-bubble-right tl-bubble-ccmsg-user"
          : "tl-bubble tl-bubble-left tl-bubble-peer tl-bubble-ccmsg-peer"
      }${selected ? " tl-bubble-user-nav-selected" : ""}`}
      style={hue !== undefined ? { "--member-hue": String(hue) } : undefined}
      ref={
        isUser
          ? (el) => {
              if (navKey !== undefined) registerUserTurnRef(navKey, el);
            }
          : undefined
      }
      onClick={isUser && navKey !== undefined ? () => onUserTurnClick(navKey) : undefined}
    >
      <div class="tl-bubble-body">
        <div class="tl-bubble-from">
          {isUser ? (
            <>
              <UserAvatar size={16} />
              {memberLabel(ADMIN_ID, room)}
            </>
          ) : from ? (
            <>
              <MemberAvatar id={from} room={room} />
              {memberLabel(from, room)}
            </>
          ) : (
            "…"
          )}
          {(() => {
            // u1 (ADMIN_ID) は always-exempt 配信済みなので mention 表示から
            // 除外 (TimelineItem 側と同ポリシー、kawaz 2026-07-20)。
            const shown = to?.filter((id) => id !== ADMIN_ID) ?? [];
            if (!shown.length) return null;
            return (
              <span class="msg-to">
                {" → "}
                {shown.map((id, i) => (
                  // ROOM 側 MsgItem と同構造の (avatar + name) ペア。id 重複が
                  // あっても衝突しないよう `${id}-${i}` を key に混ぜる。
                  <span key={`${id}-${i}`} class="msg-to-item">
                    {i > 0 ? ", " : null}
                    <MemberAvatar id={id} room={room} />
                    {memberLabel(id, room)}
                  </span>
                ))}
              </span>
            );
          })()}
          {" · #"}
          {message.room}
          {message.mid === undefined ? null : `m${message.mid}`}
        </div>
        <Tabs
          class="tl-thinking-tabs"
          tabClass="tl-thinking-tab"
          label="ccmsg メッセージの表示"
          selected={tab}
          onSelect={setTab}
          items={[
            { id: "msg", label: "msg" },
            { id: "raw", label: "raw" },
          ]}
        />
        {tab === "msg" ? (
          // tl-ccmsg-msg: chat 様式の本文なので単一改行を行分けとして見せる
          // (CSS の white-space: pre-wrap、kawaz r17 mid=13)。markdown AST は
          // 段落内の改行を text node "\n" のまま保持しており、素の <p> では
          // 空白に潰れる。文書様式が前提の assistant markdown には波及させない
          // (ソフト折り返しを空白扱いする通常の markdown 表示のまま)。
          <div class="tl-ccmsg-msg">
            <LinkedMarkdownView source={msgBody} ctx={filePathCtx} restricted={isUser} />
          </div>
        ) : (
          <pre class="tl-fold-body">{rawText}</pre>
        )}
      </div>
      <span class="tl-bubble-time">{formatMsgTime(ts, now)}</span>
    </div>
  );
  // u1 (自分の発話) は主役側なので従来通り右寄せ吹き出しをそのまま。
  // peer は thinking と同じ fold パターン (details + summary + tl-guided) で
  // 包み、閉時は identicon + 名前 + #room + preview の 1 行、開時は既存の
  // rich 表示 (hue / タブ / LinkedMarkdownView) を保つ。fold 自体の
  // 左インデント・フォントサイズは CSS 側 (.tl-ccmsg-fold / .tl-ccmsg-body)
  // で thinking と揃える。
  const bubble = isUser ? (
    innerBubble
  ) : (
    <details
      class={`tl-fold tl-ccmsg-fold${selected ? " tl-bubble-user-nav-selected" : ""}`}
      open={foldOpen}
      onToggle={(e) => setFoldOpen((e.currentTarget as HTMLDetailsElement).open)}
      ref={(el) => {
        if (navKey !== undefined) registerUserTurnRef(navKey, el);
      }}
      onClick={navKey === undefined ? undefined : () => onUserTurnClick(navKey)}
    >
      {/* kawaz r55 m14: 閉時サマリは thinking/agent の `▶ HH:MM:SS <kind>`
       * と同トーンの控えめ 1 行 (identicon + 名前 + #room[m<mid>] + preview
       * を tl-summary-decoration の小さいチップにまとめる)、開時は装飾を
       * 落として時刻 + `ccmsg` ラベルだけ (rich な hue バブルは本文側に出る)。
       * FoldSummary を直接使わないのは MemberAvatar/memberLabel が room 依存
       * のため — decoration を context 化するより summary を局所組立する方が
       * 素直。 */}
      {foldOpen ? (
        <summary>
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
          <span class="tl-fold-label">ccmsg</span>
        </summary>
      ) : (
        <summary class="tl-decorated-summary tl-ccmsg-summary">
          {ts ? <span class="tl-time">{formatClockTime(ts)}</span> : null}
          {/* agent decoration (`peer-message ← name`) と同じ寸法感の控えめな
           * 1 行 (kawaz r55 m14): `ccmsg ← <avatar> <name>`。#room / preview
           * のような詳細は展開後の rich バブル本体に寄せる — 閉サマリで hue 枠
           * カードを出さない (「ウザい/デカい」対処)。 */}
          <span class="tl-fold-label tl-summary-decoration tl-ccmsg-summary-body">
            <span>ccmsg</span>
            <span class="tl-direction-badge tl-direction-inbound">←</span>
            {from ? <MemberAvatar id={from} room={room} /> : null}
            <strong class="tl-ccmsg-summary-name">{from ? memberLabel(from, room) : "…"}</strong>
          </span>
        </summary>
      )}
      <div class="tl-guided">
        <FoldGuide />
        <div class="tl-ccmsg-body">{innerBubble}</div>
      </div>
    </details>
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

/** One line of the raw view: its cache position and absolute byte offset in
 * the gutter, the verbatim jsonl text beside it. Long lines (pasted images,
 * big tool results) render truncated behind a per-row expander so switching
 * into the raw view never has to lay out megabytes at once. */
function RawLineRow({ row }: { row: RawTranscriptRow }) {
  const [expanded, setExpanded] = useState(false);
  const pretty = useRawViewPretty();
  // 整形は選択中のときだけ (巨大行の JSON.parse を raw 表示のたびに走らせ
  // ない)。失敗しても表示を止めず raw に落として理由だけ添える — 壊れた行を
  // そのまま読めることが raw ビューの存在理由なので、整形不能は例外ではなく
  // 通常の分岐。
  const prettied = useMemo(() => (pretty ? prettyRawLine(row.text) : null), [pretty, row.text]);
  const text = prettied?.ok ? prettied.text : row.text;
  const preview = useMemo(() => truncateRawLine(text), [text]);
  const shown = expanded ? text : preview.text;
  return (
    <div class="tl-raw-row">
      <div class="tl-raw-gutter">
        <span class="tl-raw-index">{row.index}</span>
        {/* 生 JSONL の各行を rich 表示側のバブルと突き合わせるための座標 —
         * rich 側の Preact key と同じ絶対 byte offset (lineByteOffsets)。 */}
        <span class="tl-raw-offset" title={`byte offset ${row.offset} / ${row.bytes} bytes`}>
          @{row.offset}
        </span>
      </div>
      <div class="tl-raw-line">
        {prettied && !prettied.ok ? (
          <p class="tl-raw-note">
            {prettied.reason === "too-large"
              ? `(${row.text.length.toLocaleString()} 文字 — 整形の上限 ${RAW_PRETTY_MAX_CHARS.toLocaleString()} 文字を超えるため raw 表示)`
              : "(JSON として解釈できない行 — raw 表示)"}
          </p>
        ) : null}
        {prettied?.ok ? (
          // 装飾は FileViewer / markdown の fence と同じ Shiki パイプライン
          // (CodeBlock -> highlight.ts) をそのまま使う。json 文法は既に
          // バンドル済みで、トークナイズ失敗時の plain fallback も込み。
          <CodeBlock code={shown} lang="json" />
        ) : (
          <pre class="tl-fold-body tl-raw-text">{shown}</pre>
        )}
        {preview.truncated ? (
          <button type="button" class="tl-raw-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "省略表示に戻す" : `… 残り ${text.length - preview.text.length} 文字を表示`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The seam in a forked session: everything above it was copied from the
 * ancestor when the fork was taken, everything below is this session's own.
 * A labelled hairline in the sidebar's `.tree-section-label` register — the
 * point is to be findable while scrolling past, not to announce itself. */
function ForkDivider({ origin }: { origin: ForkOrigin }) {
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

/** 目的の scroll 位置を 0/60/300/1000ms の 4 回書く (kawaz r17 mid=26)。
 * fold group / 画像 / フォント / markdown / Shiki highlight の非同期差し替えで
 * paint 後も scrollHeight が伸びるため、1 発では狙いの位置に落ち着かない。
 * 末尾 1000ms はリロード直後の初期 fetch (2MB) 向け。
 *
 * 中断条件は scroll 位置でなく **ユーザ入力 (wheel / touch / キー)** で判定
 * する (kawaz r17 mid=37 のリグレッション対策): 位置ベースのガードだと、初回
 * ロード直後の「まだ top に居る」状態を「ユーザが上に離れた」と誤認して全
 * タイマーが空振りする。programmatic scroll はこれらのイベントを発火しない
 * ので、ユーザの意図した離脱だけを正確に拾える。
 *
 * 戻り値は effect の cleanup にそのまま返せる中断関数。 */
function settledScroll(
  getEl: () => HTMLElement | null,
  apply: (el: HTMLElement) => void,
): () => void {
  const el0 = getEl();
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
      const el = getEl();
      if (el && !cancelled) apply(el);
    }, ms),
  );
  const lastId = setTimeout(detach, 1001);
  return () => {
    ids.forEach(clearTimeout);
    clearTimeout(lastId);
    detach();
  };
}

/** `container` の scrollTop に書けば `target` が「TL の表示領域の一番上」＝
 * sticky な `.tl-toolbar` のすぐ下に来る値。toolbar の実高さを毎回測るのは
 * モバイル幅で 2 行以上に wrap するため (kawaz r35 mid=51: 固定の
 * scroll-margin-top では不足して対象がヘッダ裏に隠れた)。👤 nav の
 * ジャンプと uuid 直アクセスの着地が同じ「ヘッダ直下」に揃う唯一の定義。 */
function topBelowToolbar(container: HTMLElement, target: HTMLElement): number {
  const toolbar = container.querySelector<HTMLElement>(".tl-toolbar");
  const toolbarBottom =
    toolbar?.getBoundingClientRect().bottom ?? container.getBoundingClientRect().top;
  return target.getBoundingClientRect().top - toolbarBottom + container.scrollTop;
}

/** dump をファイルに書き出すアクションの状態。path は daemon ホスト上の絶対
 * パスで、次にすることは「別のセッションに渡す」なので表示したまま残す。 */
type DumpActionState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; path: string; entries: number }
  | { kind: "error"; msg: string };

/** dump をファイルに書き出すアクション。無選択ならセッション全体、項目を
 * 選択中ならその record 以降 (選択自身を含む) を切り出す。fork と違い
 * off-chain の record も正当な起点 (session-dump-action.ts 参照)。 */
function DumpFileAction({ sid, position }: { sid: string; position: string }) {
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
            onChange={(e) => setNoThinking((e.target as HTMLInputElement).checked)}
          />
          thinking を除く
        </label>
        <label>
          <input
            type="checkbox"
            checked={noAgent}
            onChange={(e) => setNoAgent((e.target as HTMLInputElement).checked)}
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

/** アクションタブのうち「選択中の項目」に対する操作 (セッション単位の操作は
 * DumpFileAction のようにその上下に並ぶ)。 */
function ForkAction({
  state,
  available,
  onFork,
}: {
  state: ForkActionState;
  /** hello の `fork_available`。fork は launcher テンプレの起動なので、daemon
   * に launcher が無い時はボタンを出さない (押しても起動フォームが「未設定」
   * を返すだけ)。 */
  available: boolean;
  onFork: (resumeAt: string) => void;
}) {
  if (!available) {
    return <p class="tl-float-note">daemon にセッション起動 (launcher) が設定されていません。</p>;
  }
  if (state.kind === "no-selection") {
    return <p class="tl-float-note">fork 地点にする項目をクリックして選択してください。</p>;
  }
  if (state.kind === "off-chain") {
    return (
      <p class="tl-float-note">
        この項目は放棄された分岐上にあります。resume が読み込む会話に含まれないので fork
        地点にできません。
      </p>
    );
  }
  // 選択項目を「残す」か「消す」かは同じ強さの 2 択なので、片方を既定にして
  // もう片方をオプション扱いにせず、2 つのボタンとして並べる (kawaz r115 m9)。
  // ボタン名がそのまま境界の説明になっていて、どちらを押すと何が残るかを
  // 読む前に分かる。
  return (
    <div class="tl-float-fork">
      <button type="button" class="tl-float-action" onClick={() => onFork(state.resumeAt)}>
        この項目まで残して fork
      </button>
      {state.resumeAtBefore === undefined ? null : (
        <button
          type="button"
          class="tl-float-action"
          onClick={() => onFork(state.resumeAtBefore as string)}
        >
          この項目から消して fork
        </button>
      )}
      <p class="tl-float-note">
        {state.resumeAtBefore === undefined
          ? "この項目の直前が読み込まれていないので、消す側は選べません。older を読み込むと選べます。"
          : "「まで残す」= この項目までが新セッションの記憶に残ります。「から消す」= この項目以降の記憶が消えます。"}
      </p>
    </div>
  );
}

export function Timeline({
  sid,
  timeline,
  search,
  sessionStatus,
  agent,
  active,
  visible,
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
  active: boolean;
  /** Timeline タブが実際に画面に出ているか (`active` はセッション単位なので、
   * Files タブを見ている間も true のまま)。タブ往復では Timeline は unmount
   * されず scroller の scrollTop が残るため、「Timeline タブをクリックした
   * のに途中/一番上のまま」になる (kawaz r76 m47)。head 表示への遷移は
   * 「最新を見たい」意図なので、可視化された瞬間に末尾へ寄せ直す。 */
  visible: boolean;
}) {
  const { store, ws } = useApp();
  const appState = useStoreState(store);
  const connStatus = appState.connStatus;
  const currentLocator = parseUrl(location.pathname, location.search);
  const currentPosition =
    currentLocator.view === "timeline" && currentLocator.sid === sid
      ? (currentLocator.position ?? "head")
      : "head";
  // 位置指定 URL (`/timeline/<uuid>`) は親セッションの TL しか指せない —
  // locator の grammar 上、agent TL (`/timeline/agent/...`) の position は
  // 常に "head" で、agent ref と uuid を同時に表す形が無い (locator.ts)。
  // agent TL で位置を書き込むと agent ref が落ち、項目をクリックしただけで
  // 親 TL へ弾き出される。表せない選択なので agent TL では行わない。
  // 選択中のバルーンを再クリックしたら選択解除 = head に戻す (kawaz r76 m71:
  // 「今だと msgid を外す方法が無い」)。head に戻しても**その場ではスクロール
  // しない** — 末尾ジャンプは「Timeline タブが再表示された」時だけの挙動で、
  // 選択解除は URL と装飾を外すだけ。
  // 画面内のバルーンをクリックした選択では **スクロールしない** (kawaz r115 m4:
  // 「クリックした瞬間に勝手に一番上へ寄せられると、ダブルクリックの単語選択が
  // できないし、2 クリック目が別の場所に当たって事故る」)。着地スクロールは
  // 「外から その位置へ来た」時 (直リンク / 戻る・進む) の挙動なので、クリック
  // 発の遷移は着地済みとして先にマークしておき、下の着地 effect を空振りさせる。
  const landedPositionRef = useRef<string | null>(null);
  // pin を張ってからユーザ自身がスクロールしたか (wheel / touch / キー)。
  // 最下部検知で pin を外してよいかの判定に使う (shouldReturnToHead)。
  const userScrolledSincePinRef = useRef(false);
  const selectPosition = useCallback(
    (uuid: string) => {
      if (agent && (agent.agentId || agent.teammate)) return;
      const next = togglePosition(currentPosition, uuid);
      landedPositionRef.current = next === "head" ? null : positionLandingKey(sid, next);
      userScrolledSincePinRef.current = false;
      rememberTimelinePosition(sid, next);
      replaceNavigation(timelineHref(sid, next));
    },
    [sid, currentPosition, agent?.agentId, agent?.teammate],
  );

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
  // agentKey identifies *which* subagent this drilldown Timeline belongs to,
  // for the per-agent auto-open storage key below — agentId is the primary
  // identity, runId/teammate are fallbacks for refs that only carry those
  // (mirrors the `...(agent.teammate ? { teammate: ... } : {})` subscribe
  // payload a few lines down, which prefers the same fields).
  const agentKey = agent?.agentId ?? agent?.runId ?? agent?.teammate;
  const [autoOpenSettings, setAutoOpenSettings] = useState(() =>
    parseTimelineAutoOpenSettings(
      readStorage(timelineAutoOpenStorageKey(sid, agentKey)),
      defaultTimelineAutoOpen(agentActive),
    ),
  );
  const [autoOpenRevision, setAutoOpenRevision] = useState(0);
  const [autoOpenPanelOpen, setAutoOpenPanelOpen] = useState(false);
  // パネル外 click で自動収納 (kawaz r38 mid=66)。useFabPopup と同じ理由で
  // click イベント (tap 完了) のみ — mousedown/touchstart はスクロール目的の
  // タッチでも閉じてしまう。open 中だけ listener を張る。項目リストへの
  // click だけは畳まない (判断は shouldCloseSidePanel)。
  const autoOpenFloatRef = useRef<HTMLDivElement | null>(null);
  const tlLinesRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!autoOpenPanelOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (shouldCloseSidePanel(e.target, autoOpenFloatRef.current, tlLinesRef.current)) {
        setAutoOpenPanelOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [autoOpenPanelOpen]);
  // 開いている間だけ TL の列を右に詰めて、パネルの真下に隠れて押せない項目を
  // 無くす (issue 2026-08-16-timeline-float-panel-blocks-record-click)。パネル
  // 幅は中身 (fork の説明文 / dump の出力先パス) で変わるので実測して渡す。
  const [floatReserve, setFloatReserve] = useState(0);
  useEffect(() => {
    const float = autoOpenFloatRef.current;
    const column = float?.parentElement;
    if (!float || !column) return;
    const measure = () => {
      setFloatReserve(
        sidePanelReserveWidth(
          autoOpenPanelOpen,
          float.getBoundingClientRect().width,
          column.getBoundingClientRect().width,
          TL_SIDE_PANEL_MIN_CONTENT_PX,
        ),
      );
    };
    measure();
    // padding-right は column の border-box 幅も float の幅も変えないので、
    // この observe が自分自身を再発火させるループにはならない。
    const observer = new ResizeObserver(measure);
    observer.observe(float);
    observer.observe(column);
    return () => observer.disconnect();
  }, [autoOpenPanelOpen]);
  useEffect(() => {
    setAutoOpenSettings(
      parseTimelineAutoOpenSettings(
        readStorage(timelineAutoOpenStorageKey(sid, agentKey)),
        defaultTimelineAutoOpen(agentActive),
      ),
    );
    setAutoOpenRevision((revision) => revision + 1);
  }, [sid, agentKey, agentActive]);
  const toggleAutoOpen = useCallback(
    (key: keyof TimelineAutoOpenSettings) => {
      setAutoOpenSettings((current) => {
        const next = toggleTimelineAutoOpen(current, key);
        writeStorage(timelineAutoOpenStorageKey(sid, agentKey), JSON.stringify(next));
        return next;
      });
      setAutoOpenRevision((revision) => revision + 1);
    },
    [sid, agentKey],
  );
  const autoOpenContext = useMemo<TimelineAutoOpenContextValue>(
    () => ({ settings: autoOpenSettings, revision: autoOpenRevision }),
    [autoOpenSettings, autoOpenRevision],
  );

  // Fold open/closed state for this session's timeline. A session switch gets a
  // fresh store (the offsets its keys are built from mean nothing in another
  // transcript); an auto-open settings change only drops the overrides, so
  // every fold falls back to the new default.
  const foldOpenStore = useMemo(() => new FoldOpenStore(), [sid]);
  useEffect(() => foldOpenStore.reset(), [foldOpenStore, autoOpenRevision]);
  // Bumped when any fold body mounts for the first time, which is the moment
  // nav into a previously-closed fold can find the element it wants to scroll
  // to. See the pin-landing and search-reveal effects below.
  const [foldMountRevision, setFoldMountRevision] = useState(0);
  useEffect(
    () => foldOpenStore.subscribeMounted(() => setFoldMountRevision((n) => n + 1)),
    [foldOpenStore],
  );
  useEffect(() => {
    if (!active || agentActive) return;
    if (connStatus !== "connected") return;
    // Wait for the subscribe before undoing it: the daemon runs this
    // connection's requests concurrently, so an unsubscribe sent while the
    // subscribe is still in flight could be answered first and leave the tail
    // watch installed with nobody reading it.
    const subscribed = ws.transcriptSubscribe(sid).catch(() => {});
    return () => {
      void subscribed.then(() => ws.transcriptUnsubscribe(sid).catch(() => {}));
    };
  }, [active, sid, connStatus, agentActive]);

  // Ask once per session where its copied fork history ends. An agent
  // transcript is never a fork of anything (only whole sessions fork), and the
  // seam cannot move as the session appends, so there is nothing to refresh:
  // the store keeping the answer (incl. `null` = no seam) is what stops this
  // from re-asking on every visit.
  const forkOrigin = appState.sessionTrees.get(sid)?.forkOrigin;
  useEffect(() => {
    if (!active || agentActive) return;
    if (connStatus !== "connected") return;
    if (forkOrigin !== undefined) return;
    void ws
      .forkOrigin(sid)
      .then((res) => {
        if (!res.ok) return;
        store.dispatch({ type: "timeline/fork-origin", sid, origin: res.origin });
      })
      // A seam is decoration: a failed resolve leaves the Timeline as it was,
      // and the next visit retries.
      .catch(() => {});
  }, [active, agentActive, sid, connStatus, forkOrigin !== undefined]);

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
    if (!active || timeline.status !== "idle") return;
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
  }, [active, sid, timeline.status, connStatus]);

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
    if (!active || !timeline.needsResync) return;
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
  }, [active, sid, timeline.needsResync, connStatus]);

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
    if (!active || connStatus !== "connected") return;
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
  }, [active, sid, connStatus]);

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

  // Per-line derivations (JSON parse, UTF-8 size) are memoized per *line*,
  // not per lines-array: the store hands us a new array for every live-tail
  // push, and re-deriving the whole window meant re-parsing the entire
  // transcript once per appended line. See incremental-line-map.ts.
  const parseCacheRef = useRef(emptyLineMapCache<ParsedLine>());
  const byteLengthCacheRef = useRef(emptyLineMapCache<number>());
  const perLine = useMemo(() => {
    parseCacheRef.current = mapLinesIncrementally(
      parseCacheRef.current,
      timeline.lines,
      parseTranscriptLine,
    );
    return parseCacheRef.current.values;
  }, [timeline.lines]);
  const byteLengths = useMemo(() => {
    byteLengthCacheRef.current = mapLinesIncrementally(
      byteLengthCacheRef.current,
      timeline.lines,
      utf8ByteLength,
    );
    return byteLengthCacheRef.current.values;
  }, [timeline.lines]);
  // The passes that need the whole window (queue-operation pairing,
  // tool_use/tool_result joining, tools folding) run over the per-line results
  // — they read neighbouring lines, so they can't be folded into the per-line
  // cache. They stay whole-window here too; what is incremental is the
  // *identity* of their output, so a live-tail append leaves the FoldGroup of
  // every untouched group holding the same `entries` array as before and
  // Preact can skip it. See incremental-cross-line.ts.
  //
  // `offsets` are absolute byte offsets, one per cached line — stable Preact
  // keys across a "load older" prepend (see transcript-model.ts's
  // lineByteOffsets doc). `groups` is the tools folding (kawaz spec):
  // boundary lines (user prompts / assistant user-facing final responses)
  // stay standalone entries, everything between them collapses into one fold
  // group — see transcript-model.ts's groupTimelineLines doc comment.
  const crossLineCacheRef = useRef(emptyCrossLineCache());
  const { parsed, offsets, groups } = useMemo(() => {
    crossLineCacheRef.current = crossLineIncrementally(crossLineCacheRef.current, {
      start: timeline.start,
      raws: timeline.lines,
      perLine,
      byteLengths,
    });
    return crossLineCacheRef.current;
  }, [timeline.start, timeline.lines, perLine, byteLengths]);
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
  // Null whenever the seam is outside the loaded window, so paging older is
  // what makes the divider appear rather than anything here.
  const forkDividerIndex = useMemo(
    () => forkDividerGroupIndex(groups, forkOrigin?.boundary_uuid),
    [groups, forkOrigin?.boundary_uuid],
  );
  // 同一 ccmsg event (room + ts + from、DR-0027 以降は room + mid) が transcript
  // の複数箇所から抽出される場合 (queue-operation enqueue と task-notification
  // 経由の Monitor tool_result 両方に載っているケース、kawaz r15 mid=21) の
  // 二重表示を避ける。**どれを描画するかは分類フェーズで確定**させ、render は
  // key の在否を読むだけにする — boundary 側 (下の groups.map) と fold-group 側
  // (CcmsgRenderContext 経由の PeerCcmsgLineView) は別コンポーネントなので、
  // render 中に共有 Set を mutate すると fold の開閉のような子局所 re-render で
  // 判定が変わってしまう。
  // --- `ccmsg say` バブルの差し込み (kawaz r244m14) ---
  //
  // say はセッション transcript には echo されない (protocol の SayEvent 参照:
  // 喋った本人の context を食うだけなので意図的に切ってある) ので、TL に出すには
  // transcript 以外の唯一の記録 — そのセッションの 1on1 room — から時刻で合流
  // させるしかない (say-merge.ts)。バブル自体は RoomView と同じ TimelineItem を
  // 使う (見た目も既読ボタンの経路も 1 実装のまま)。agent TL は別セッションの
  // transcript を見ているので対象外 — その say はこの transcript のものではない。
  const oneOnOne = useMemo(
    () => (agent ? null : findExistingOneOnOne(appState, sid)),
    [appState.rooms, sid, agent],
  );
  const oneOnOneId = oneOnOne?.id;
  const oneOnOneHistory = oneOnOne?.history;
  // room の events は「開いた room だけ」取りに行く設計 (store の room.history)。
  // TL に say を出すにはその履歴が要るので、TL が実際に画面に出ている時にだけ
  // 1 回取る — 見ていない間は何もしない (DR-0009/0020 と同じ線引き)。失敗は
  // "error" のまま置き、reconnect / 再表示が再試行になる (RoomView と同じ)。
  useEffect(() => {
    if (!visible || !oneOnOneId || oneOnOneHistory !== "idle") return;
    store.dispatch({ type: "room-history/loading", room: oneOnOneId });
    void ws
      .roomHistory(oneOnOneId)
      .then((res) => {
        store.dispatch({
          type: "room-history/loaded",
          room: oneOnOneId,
          ...(res.ok ? {} : { error: res.error.msg }),
        });
      })
      .catch(() => {
        store.dispatch({ type: "room-history/loaded", room: oneOnOneId, error: "disconnected" });
      });
  }, [visible, oneOnOneId, oneOnOneHistory, store, ws]);
  const says = useMemo(
    () =>
      (oneOnOne?.timeline ?? []).filter(
        (ev): ev is Extract<DeliveredEvent, { type: "say" }> => ev.type === "say",
      ),
    [oneOnOne?.timeline],
  );
  const saySlotsByGroup = useMemo(() => saySlots(groups, says), [groups, says]);
  // 既読は RoomView と同じ非楽観 — 成功は broadcast される say_read を store が
  // 畳んで未読集合から消す。失敗を黙って捨てると「押しても何も起きない」に
  // 見えるので、TL でも 1 行のエラーとして出して次の試行まで残す。
  const [sayReadError, setSayReadError] = useState<string | null>(null);
  const handleSayRead = useCallback(
    (seq: number): void => {
      if (!oneOnOneId) return;
      void ws
        .sayRead(oneOnOneId, seq)
        .then((res) => {
          setSayReadError(res.ok ? null : res.error.msg);
        })
        .catch(() => {
          setSayReadError("接続エラーのため既読にできませんでした");
        });
    },
    [ws, oneOnOneId],
  );
  const sayNodes = (slot: number) => {
    if (!oneOnOne) return [];
    return (saySlotsByGroup[slot] ?? []).map((ev) => (
      <TimelineItem
        key={`say-${ev.seq ?? ev.ts}`}
        event={ev}
        room={oneOnOne}
        peers={appState.peers}
        now={now}
        onSayRead={handleSayRead}
      />
    ));
  };

  const ccmsgTargets = useMemo(() => ccmsgRenderTargets(groups), [groups]);
  // Which folds enclose each line, so that nav can open them by key. Only the
  // fold side has entries here; a boundary bubble is always mounted.
  const foldPaths = useMemo(() => foldPathsByOffset(groups), [groups]);
  const openFoldsAt = useCallback(
    (offset: number | undefined) => {
      if (offset === undefined) return;
      for (const key of foldPaths.get(offset) ?? []) foldOpenStore.set(key, true);
    },
    [foldPaths, foldOpenStore],
  );
  // Carried over whenever the set of visible bubbles is unchanged: this rides
  // in a context value, so a fresh Set per appended line would re-render every
  // ccmsg bubble on the page even though nothing about them moved.
  const visibleCcmsgKeysRef = useRef<ReadonlySet<string>>(new Set());
  const visibleCcmsgKeys = useMemo(() => {
    const next = new Set(ccmsgTargets.map((target) => target.key));
    const previous = visibleCcmsgKeysRef.current;
    if (previous.size === next.size && [...next].every((key) => previous.has(key))) return previous;
    visibleCcmsgKeysRef.current = next;
    return next;
  }, [ccmsgTargets]);

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
  const userTurnRefs = useRef(new Map<string, HTMLElement>());
  const registerUserTurnRef = useCallback((key: string, el: HTMLElement | null) => {
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

  // Fold scope (📁, kawaz r76m73). Unlike the target toggles this one *is*
  // persisted (loaded once at mount, never reset on session switch): it is a
  // standing preference about how the reader wants "[N/M]" to relate to what
  // is on screen, not part of any single query — same posture as FileTree's
  // `.gitignore` toggle.
  const [searchClosedFolds, setSearchClosedFolds] = useState(() =>
    parseSearchClosedFolds(readStorage(CLOSED_FOLD_SCOPE_KEY)),
  );
  const toggleSearchClosedFolds = useCallback(() => {
    setSearchClosedFolds((prev) => {
      const next = !prev;
      writeStorage(CLOSED_FOLD_SCOPE_KEY, serializeSearchClosedFolds(next));
      return next;
    });
  }, []);

  // With closed folds out of scope, "[N/M]" depends on the open/closed state
  // of every <details> on the page — but opening one only re-renders that
  // fold's own subtree (FoldGroup keeps `open` in local state, see
  // ccmsgRenderTargets' doc comment), so nothing would re-run the match effect
  // below. This bumps a revision the effect depends on. Only armed while the
  // toggle is off and a query is live: when closed folds *are* in scope the
  // count is fold-independent by construction, and re-running the effect
  // (highlightRenderedText over every unit) on each toggle would be pure
  // waste — expanding a big fold group fires one `toggle` per nested fold.
  const [foldRevision, setFoldRevision] = useState(0);
  // The other half of the same invalidation: a mounted unit can change the text
  // it shows with nothing folding. A thinking segment switching to its ja tab
  // leaves the 📁-off verdict standing on text that is no longer on screen
  // (measured 2026-08-12: a ja-only query stayed "1/1" after the segment went
  // back to its original, until a fold toggle forced the recount), and leaves
  // the highlight ranges painted over the old spelling. Armed regardless of the
  // 📁 toggle: the highlight pass reads the rendered text in either scope.
  const [displayRevision, setDisplayRevision] = useState(0);
  const notifyDisplayChange = useCallback(() => setDisplayRevision((n) => n + 1), []);
  const searchIsLive = parsedSearch.words.length > 0 && !parsedSearch.hasError;
  useEffect(() => {
    if (searchClosedFolds || !searchIsLive) return;
    const listener = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement) setFoldRevision((n) => n + 1);
    };
    document.addEventListener("toggle", listener, true);
    return () => document.removeEventListener("toggle", listener, true);
  }, [searchClosedFolds, searchIsLive]);

  // 展開した JSONL を raw / pretty どちらで読むか (kawaz r76 m91) は TL の
  // state ではなく raw-view-mode.ts の永続グローバル設定 — 個々の項目を
  // 開いた JSONL をどう読みたいかは読み手の恒常的な好みなので、ここには
  // 持たない (searchClosedFolds と同じ posture)。
  // 生 JSONL の行 + その絶対 byte offset。rich 側の Preact key と同じ offset
  // 由来なので、raw の行と rich のバブルを突き合わせられる。項目ごとの
  // jsonl トグル (rawRowByOffset、kawaz r55 m89) が「どの項目が展開される
  // か事前に判らない」ため常に必要 (kawaz r135m28: Timeline 全体をまるごと
  // 切り替える raw ヘッダーは削除、個別トグルのみ残す)。行テキストは
  // `timeline.lines` を指すだけなのでコピーは発生しない。データは rich と
  // 同じ `timeline.lines` — daemon への追加取得なし。
  const rawRows = useMemo(
    () => rawTranscriptRowsFrom(timeline.lines, offsets, byteLengths),
    [timeline.lines, offsets, byteLengths],
  );
  const rawRowByOffset = useMemo(() => {
    const map = new Map<number, RawTranscriptRow>();
    for (const row of rawRows) map.set(row.offset, row);
    return map;
  }, [rawRows]);
  const itemRawSources = useMemo(() => itemRawSourceOffsets(parsed, offsets), [parsed, offsets]);
  // Read through a ref rather than closed over, so the identity of this
  // callback — and with it the ItemRawContext value every timeline item
  // subscribes to — survives a live-tail append. The lookup tables it reads
  // are rebuilt on every append, but nothing reads them until someone toggles
  // an item to jsonl, and by then the ref holds the current pair.
  const itemRawLookupRef = useRef({ itemRawSources, rawRowByOffset });
  itemRawLookupRef.current = { itemRawSources, rawRowByOffset };
  const getItemRawRows = useCallback((offset: number) => {
    const { itemRawSources: sources, rawRowByOffset: rows } = itemRawLookupRef.current;
    return (sources.get(offset) ?? [])
      .map((o) => rows.get(o))
      .filter((row): row is RawTranscriptRow => row !== undefined);
  }, []);

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
  // 訳が 1 段落届くたびに進む counter。thinking の検索テキストは訳の到着で
  // 増える (原文だけ -> 原文 + 訳) ので、これを searchUnits の入力にして
  // 「訳が来たら M が増える方向で再計算される」を成立させる。unit の key は
  // 訳と無関係なので、再計算しても D0 の identity は保たれる。
  const translationRevision = useSyncExternalStore(
    subscribeTranslationRegistry,
    getTranslationRevision,
  );

  const searchUnits = useMemo(() => {
    const units: SearchUnit[] = [];
    const targets = { user: targetUser, ai: targetAI, ccmsg: targetCcmsg };
    const pushLine = (offset: number, line: ParsedLine) => {
      if (line.kind !== "turn") return;
      if (line.role === "user" && line.userMessageKind && !isUserSpeechKind(line.userMessageKind))
        return;
      // 同じ理由で assistant 側の合成行 (Claude Code の turn 中断報告) も除外:
      // ApiErrorNotice は searchCtx を渡さず本文を verbatim 描画するので、
      // ここで数えると highlight も scroll 先も無い ghost match になる。
      if (isApiErrorLine(line)) return;
      // keepalive 応答も同じ — fold 内の 1 行 summary + <pre> 本文で、
      // searchCtx を渡さない verbatim 描画になっている。
      if (isCacheKeepaliveReplyLine(line)) return;
      line.segments.forEach((seg, i) => {
        if (!isSearchableSegment(seg, targets)) return;
        const text = segmentSearchText(seg);
        // 翻訳タブを持つ unit (thinking / assistant 応答本文) は表示が訳文へ
        // 差し替わりうるので、届いている訳をもう 1 つの綴りとして持たせる
        // (原文クエリ・訳文クエリのどちらでも数に入る)。
        const translatable =
          seg.kind === "thinking" || (seg.kind === "text" && seg.role === "assistant");
        const translated = translatable ? translatedTextOf(text) : null;
        units.push({
          key: `${offset}-${i}`,
          texts: translated === null ? [text] : [text, translated],
        });
      });
    };
    for (const group of groups) {
      if (group.kind === "fold") {
        for (const entry of group.entries) pushLine(entry.offset, entry.line);
      } else {
        pushLine(group.offset, group.line);
      }
    }
    // ccmsg messages (💬 toggle): 描画されるバブルそのもの (boundary 側 = u1 発、
    // fold group 内 = peer 発) を分類フェーズの確定結果から document 順に拾う。
    // render 側と同じ key 集合を使うので、💬 toggle の [N/M] と実 DOM 数が
    // 乖離しない (dedup で落ちた message が幽霊マッチとして数に残らない)。
    // A bubble whose body was truncated on the wire renders the full message
    // CcmsgBubble fetches on mount, so its rendered text can outrun `msg`.
    // Counting the extracted body keeps the unit's membership decidable from
    // the transcript alone; a match that exists only in the lazily-fetched
    // remainder is not counted (and gets no highlight either way).
    if (targetCcmsg) {
      for (const target of ccmsgTargets) {
        units.push({ key: target.key, texts: [target.message.msg] });
      }
    }
    return units;
  }, [groups, ccmsgTargets, targetUser, targetAI, targetCcmsg, translationRevision]);

  // Unit key -> the line it came from, so a match inside a not-yet-mounted
  // fold can be reached: the key alone says nothing about where it lives, and
  // the DOM no longer holds the answer. Built from the same walk as
  // `searchUnits` rather than by taking the key apart.
  const searchUnitOffsets = useMemo(() => {
    const offsetByKey = new Map<string, number>();
    for (const group of groups) {
      const entries = group.kind === "fold" ? group.entries : [group];
      for (const entry of entries) {
        if (entry.line.kind !== "turn") continue;
        entry.line.segments.forEach((_segment, i) =>
          offsetByKey.set(`${entry.offset}-${i}`, entry.offset),
        );
      }
    }
    for (const target of ccmsgTargets) offsetByKey.set(target.key, target.offset);
    return offsetByKey;
  }, [groups, ccmsgTargets]);

  // The "M" in "[N/M]" and the document-order nav ↑/↓ walks (DR-0022 §2.1/
  // §2.2). What a collapsed fold contributes is the 📁 toggle's call: on
  // (default), units count regardless of whether their fold is open and
  // revealAndScroll expands ancestors on nav, so "M" reflects everything
  // loaded; off, only text that is actually on screen counts and "M" moves as
  // folds are opened and closed.
  //
  // With the toggle on this is a pure function of the transcript and the
  // query: a unit counts because its text matches, not because it is mounted
  // or its fold is open. That is what keeps "M" still while the reader
  // navigates — ↑/↓ expands folds on its way to a match, and a DOM-derived
  // count used to drop a unit each time one opened (measured 2026-08-12:
  // "1/9" walked down to "5/7" over four ↓ presses, because the match effect
  // re-ran against the half-rendered fold and cached `matched: false`).
  //
  // With the toggle off "on screen" is the question being asked, so the
  // answer legitimately depends on the DOM; that branch filters the model's
  // set down by re-matching each mounted unit's *visible* text.
  const searchUnitRefs = useRef(new Map<string, HTMLElement>());
  const registerSearchUnitRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) searchUnitRefs.current.set(key, el);
    else searchUnitRefs.current.delete(key);
  }, []);

  const modelMatchingKeys = useMemo(
    () => (parsedSearch.hasError ? [] : matchingUnitKeysOf(searchUnits, parsedSearch.words)),
    [searchUnits, parsedSearch],
  );

  const [onScreenMatchingKeys, setOnScreenMatchingKeys] = useState<string[]>([]);
  useEffect(() => {
    if (searchClosedFolds) return;
    const unitByKey = new Map(searchUnits.map((unit) => [unit.key, unit]));
    const next = modelMatchingKeys.filter((key) => {
      const el = searchUnitRefs.current.get(key);
      const unit = unitByKey.get(key);
      if (el === undefined || unit === undefined) return false;
      return unitMatchesOnScreen(unit, visibleRenderedText(el), parsedSearch.words);
    });
    setOnScreenMatchingKeys((current) =>
      current.length === next.length && current.every((key, i) => key === next[i]) ? current : next,
    );
  }, [
    searchUnits,
    modelMatchingKeys,
    parsedSearch,
    searchClosedFolds,
    foldRevision,
    foldMountRevision,
    displayRevision,
  ]);

  const matchingUnitKeys = searchClosedFolds ? modelMatchingKeys : onScreenMatchingKeys;

  const [searchCurrentIndex, setSearchCurrentIndex] = useState(0);
  // A fresh search (query edit, mode/scope toggle flip, or session switch)
  // always starts back at the first match.
  // Deps deliberately omit matchingUnitKeys: the reset key is "the query/
  // session changed", not the array's identity (which also changes on every
  // tail append / fold-independent reparse and would reset the index far
  // more often than intended).
  useEffect(() => {
    setSearchCurrentIndex(matchingUnitKeys.length > 0 ? 1 : 0);
  }, [searchQueryText, searchCaseSensitive, searchRegex, searchClosedFolds, sid]);
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

  // Decoration only (DR-0022 §3). This paints the CSS Custom Highlight ranges
  // over whatever is mounted and wires each unit's click-to-select; it no
  // longer decides who is a match. `highlightRenderedText`'s boolean return is
  // deliberately ignored — a unit that is mounted but momentarily unpainted
  // (a fold mid-open, markdown still rendering) must not change "M", and the
  // ranges catch up on their own: rendered-text-search re-collects on every
  // `toggle` event.
  //
  // foldMountRevision is what carries "a unit that did not exist a moment ago
  // does now". With 📁 on, foldRevision is deliberately not armed, so opening a
  // fold on the way to a match used to change nothing here — and now that the
  // fold's body arrives with that open, the match would land in view unpainted
  // (observed 2026-08-12: ↓ into a closed fold scrolled correctly with an
  // empty CSS.highlights).
  useEffect(() => {
    const currentKey =
      searchCurrentIndex > 0 ? matchingUnitKeys[searchCurrentIndex - 1] : undefined;
    for (const unit of searchUnits) {
      const el = searchUnitRefs.current.get(unit.key);
      if (!el) continue;
      if (parsedSearch.words.length === 0 || parsedSearch.hasError) {
        removeRenderedTextHighlights(el);
        continue;
      }
      highlightRenderedText(
        el,
        parsedSearch.words,
        () => {
          const position = matchingUnitKeys.indexOf(unit.key);
          if (position >= 0) setSearchCurrentIndex(position + 1);
        },
        searchClosedFolds,
      );
      setRenderedTextCurrent(el, unit.key === currentKey);
    }
    return () => {
      for (const el of searchUnitRefs.current.values()) removeRenderedTextHighlights(el);
    };
  }, [
    searchUnits,
    parsedSearch,
    matchingUnitKeys,
    searchCurrentIndex,
    searchClosedFolds,
    foldRevision,
    foldMountRevision,
    displayRevision,
  ]);

  // Auto-expand every ancestor <details> (fold group / system-message fold)
  // before scrolling — Phase 2's "fold との相互作用込み"
  // (DR-0022 §4): a match living inside a collapsed fold must actually
  // become visible when navigated to, not silently scroll to a hidden
  // element. Mirrors FoldGuide's ancestor-`<details>`-via-`closest()` trick
  // used elsewhere in this file, walking outward through nested folds.
  // Opens a closed <details> in a way that survives the imminent re-render.
  // FoldGroup/ThinkingSegment both render a *controlled*
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

  // A match inside a fold that has never been opened has no element yet: the
  // fold's body is only rendered once it opens. Opening it by key is the first
  // half of the jump; `pendingSearchReveal` is the second, resumed by the
  // effect below once that render has put the unit on the page.
  const [pendingSearchReveal, setPendingSearchReveal] = useState<string | null>(null);
  useEffect(() => {
    if (pendingSearchReveal === null) return;
    const el = searchUnitRefs.current.get(pendingSearchReveal);
    if (!el) return;
    setPendingSearchReveal(null);
    revealAndScroll(el);
  }, [pendingSearchReveal, foldMountRevision]);

  function scrollToSearchMatch(oneBasedIdx: number) {
    const key = matchingUnitKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    const el = searchUnitRefs.current.get(key);
    if (el) {
      revealAndScroll(el);
      return;
    }
    openFoldsAt(searchUnitOffsets.get(key));
    setPendingSearchReveal(key);
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
    return {
      words: parsedSearch.words,
      registerRef: registerSearchUnitRef,
      notifyDisplayChange,
    };
  }, [parsedSearch.words, registerSearchUnitRef, notifyDisplayChange]);

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
  // 側面パネルの「アクション」タブが選択中の項目に対して出せるもの。項目
  // クリックで付く位置選択 (`/timeline/<uuid>`) をそのまま入力に使う —
  // 選択モデルを 2 つ持たないのは 👤 nav に相乗りしていた時と同じ姿勢で、
  // 対象が user turn から「uuid を持つ全項目」に広がっただけ (kawaz r115 m7)。
  // 放棄された分岐上のレコードは resume が読み込まないので fork 地点にできない
  // (実測: `No message found`)。表示はするが fork だけ出さないための判定材料。
  const chain = useMemo(() => liveChain(parsed), [parsed]);
  const forkAction = useMemo(
    () => forkActionState(currentPosition, chain),
    [currentPosition, chain],
  );
  // 同じアクション一式を assistant バブルのハンバーガーからも開ける
  // (BubbleActions)。側面パネルと材料を共有するので、どちらから開いても
  // 「選択中の項目に対する fork / dump」という意味は 1 つのまま。
  // agent TL は位置選択を URL で表せない (selectPosition が no-op) ので
  // 渡さない = ハンバーガーを出さない。
  const bubbleActions = useMemo<BubbleActions | undefined>(
    () =>
      agent && (agent.agentId || agent.teammate)
        ? undefined
        : {
            sid,
            position: currentPosition,
            forkAction,
            forkAvailable: appState.forkAvailable,
            // fork 元はこの画面に出ているセッション = 生きているので、
            // cwd/model/effort はランチャー側が live state から補える
            // (SessionCreator の forkSourceDefaults)。リンクには「どの
            // セッションの、どの地点か」だけを載せる。
            onFork: (resumeAt: string) =>
              pushNavigation(
                `${location.pathname}${location.search}`,
                prefillSidebarState({ kind: "fork", sessionId: sid, resumeAt }),
              ),
            onSelect: selectPosition,
          },
    [
      sid,
      currentPosition,
      forkAction,
      appState.forkAvailable,
      store,
      selectPosition,
      agent?.agentId,
      agent?.teammate,
    ],
  );

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
    if (isNearBottomRef.current) {
      // pin 中は「ユーザが自分でスクロールして最下部に来た」時だけ head に戻す。
      // pin 直後 (= 画面内クリックでの選択) にここを通すと、選択した瞬間に URL と
      // 装飾が剥がされて **最下部が見えている間はメッセージを選べない** (kawaz
      // r115 m4)。この effect は currentPosition の変化でも再実行されるので、
      // scroll イベントが 1 度も来ていなくてもここへ来る。
      if (currentPosition !== "head") {
        if (!shouldReturnToHead(currentPosition, userScrolledSincePinRef.current)) return;
        rememberTimelinePosition(sid, "head");
        replaceNavigation(timelineHref(sid));
        return;
      }
      rememberTimelinePosition(sid, "head");
      return;
    }
    const viewportTop = el.getBoundingClientRect().top;
    const visible = [...el.querySelectorAll<HTMLElement>("[data-timeline-uuid]")].find(
      (item) => item.getBoundingClientRect().bottom > viewportTop,
    );
    const uuid = visible?.dataset.timelineUuid;
    if (uuid) rememberTimelinePosition(sid, uuid);
  }, [currentPosition, sid]);

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
    // ユーザ自身のスクロール操作だけを拾う (programmatic scroll はこれらの
    // イベントを発火しない — settledScroll の中断判定と同じ考え方)。pin 中の
    // 「最下部まで自分で降りてきたら head に戻す」判定に使う。
    const onUserScrollIntent = () => {
      userScrolledSincePinRef.current = true;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onUserScrollIntent, { passive: true });
    container.addEventListener("touchmove", onUserScrollIntent, { passive: true });
    container.addEventListener("keydown", onUserScrollIntent);
    // スクロールバーのドラッグは wheel も touch も出さないので mousedown で拾う。
    // バルーンのクリックでも発火するが、click は mousedown の後なので
    // selectPosition のリセットが最後に効く (pin 直後は false のまま)。
    container.addEventListener("mousedown", onUserScrollIntent);
    checkNearBottom();
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onUserScrollIntent);
      container.removeEventListener("touchmove", onUserScrollIntent);
      container.removeEventListener("keydown", onUserScrollIntent);
      container.removeEventListener("mousedown", onUserScrollIntent);
    };
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
  const scrollToBottomSettled = useCallback(
    () =>
      settledScroll(
        () => scrollRef.current,
        (el) => {
          el.scrollTop = el.scrollHeight;
        },
      ),
    [],
  );
  useEffect(() => {
    prevEndRef.current = timeline.end;
    isNearBottomRef.current = currentPosition === "head";
    if (currentPosition !== "head") return;
    return scrollToBottomSettled();
    // 依存は [sid] のみ意図的 — timeline.end を含めると「セッション切替
    // 検知」ではなく毎回の tail 追記でもリセットされてしまい、下の
    // tail-append effect の appended 判定が常に false になってしまう。
  }, [sid]);

  // Timeline タブが「隠れている → 見えている」に変わった瞬間の末尾ジャンプ
  // (kawaz r76 m47)。上の [sid] effect は mount / セッション切替でしか走らず、
  // タブ往復では Timeline が unmount されない (SessionView の visitedTabs が
  // hidden のまま保持する) ため scroller の scrollTop が前回のまま残る。
  // head 以外 (= /timeline/<uuid> 直リンクでタブが開いた場合) は下の
  // uuid 着地 effect が担当するので、ここでは触らない。
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible || currentPosition !== "head") return;
    return scrollToBottomSettled();
  }, [visible, currentPosition]);

  // Live tail で新しい行が追記されたとき (`timeline.end` が伸びる) だけ、か
  // つユーザが最下部付近を見ているときだけ自動スクロールする (kawaz spec)。
  // `end` は「load older」prepend では変わらない (applyTimelineLoaded) の
  // で、この条件は自然に prepend を除外し、tail 追記 (と初回 tail ロード)
  // だけに反応する。smooth アニメーションなし — 高頻度で届く tail 行ごとに
  // アニメーションが重なるとかえって読みにくいため、即座にジャンプする。
  // Closes the latency trace started in ws.ts: useLayoutEffect runs once the
  // appended rows are in the document, which is the boundary the trace names
  // dom_commit. (The later scroll settle below is deliberately not part of it —
  // markdown/highlight keep resizing for a second after the rows are visible.)
  useLayoutEffect(() => {
    if (timeline.status !== "loaded") return;
    activeTraceCollector()?.noteDomCommit(sid, timeline.end);
  }, [sid, timeline.end, timeline.status]);

  useEffect(() => {
    const appended = timeline.end > prevEndRef.current;
    const initialLoad = prevEndRef.current === 0 && timeline.end > 0;
    prevEndRef.current = timeline.end;
    // currentUserIdx を最大値に初期化 (kawaz r17 mid=54): リロード直後
    // (refresh: end が減る/等しい) と初回読み込み (initialLoad) の両方で
    // "末尾ユーザメッセージ" を選択状態にする。tail 追記 (appended) 時は
    // ユーザが今どこを読んでいるかに関係なく数値を勝手に増やさない。
    if (initialLoad || !appended) setCurrentUserIdx(userTurnKeys.length);
    if (!appended || currentPosition !== "head") return;
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

  // pin 位置 (`/timeline/<uuid>`) への着地。**その位置を開いた / その位置へ
  // 遷移した最初の 1 回だけ**スクロールし、以降は選択装飾を出すだけ
  // (kawaz r76 m71: 「#id 付きで URL を開いたときと同じ感覚 + 選択メッセージ
  // に装飾を付与する程度の意味」)。この effect は tail 追記や markdown /
  // highlight 差し替えによる `parsed` の変化でも走るので、着地済みのキーを
  // ref に覚えて再スクロールを止める — さもないと pin したまま上を読んでいる
  // 最中に TL が更新されるたび pin 位置へ引き戻される。着地キーの ref は
  // selectPosition (クリック選択で先に着地済みとマークする側) と共有するため
  // 上で宣言している。
  useEffect(() => {
    // head に戻った (= 選択解除 / 末尾追いつき) 時点で着地履歴を捨てる。同じ
    // uuid を選び直したら、それは新しい遷移なので改めて着地させる。
    if (currentPosition === "head") landedPositionRef.current = null;
    if (timeline.status !== "loaded" || currentPosition === "head") return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-timeline-uuid="${CSS.escape(currentPosition)}"]`,
    );
    if (!target) {
      // Still means "outside the loaded window" and nothing else: `uuid` is
      // only ever passed to the boundary bubbles rendered below, never to the
      // fold side, so a pin target is always mounted regardless of any fold.
      rememberTimelinePosition(sid, "head");
      replaceNavigation(timelineHref(sid));
      return;
    }
    rememberTimelinePosition(sid, currentPosition);
    const key = positionLandingKey(sid, currentPosition);
    if (!shouldLandOnPosition(landedPositionRef.current, key)) return;
    landedPositionRef.current = key;
    // 外から来た pin (直リンク / 戻る・進む)。着地スクロールはユーザ操作では
    // ないので、ここを起点に「自分でスクロールしたか」を数え直す。
    userScrolledSincePinRef.current = false;
    // 着地は「対象が TL 表示領域の一番上 (toolbar 直下)」(kawaz r76 m47) —
    // 画面中央ではなく先頭に置く。scrollIntoView({block:"center"}) では
    // sticky toolbar を考慮できず、そもそも中央になってしまうので、👤 nav
    // と同じ topBelowToolbar で位置を計算して container 側へ書く。
    return settledScroll(
      () => scrollRef.current,
      (container) => container.scrollTo({ top: topBelowToolbar(container, target) }),
    );
  }, [sid, currentPosition, timeline.status, parsed]);

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
    const top = topBelowToolbar(container, target);

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
  // filepath 解決 ctx は「この pane が表示しているセッション自身」の cwd/
  // repo_root を使う (kawaz r46m62、TL は自セッションの発言表示なので発言者
  // = 自分)。peer 行がまだ届いていない (WS 接続直後などの短い間) は
  // undefined になり、LinkedMarkdownView がプレーンな MarkdownView に degrade
  // する — 同じ経路を ROOM 側 (filePathCtxForSender で送信者未解決時) も
  // 使っているので挙動は揃う。
  const selfPeer = useMemo(() => appState.peers.find((p) => p.sid === sid), [appState.peers, sid]);
  const sessionFilePathCtx = useMemo<FilePathResolveCtx | undefined>(
    () =>
      selfPeer
        ? { sid, cwd: selfPeer.cwd, repoRoot: selfPeer.repo_root, repo: selfPeer.repo }
        : undefined,
    [sid, selfPeer],
  );
  // r55 m14: peer 発 ccmsg は boundary から外れて fold group 内 (LineView →
  // PeerCcmsgLineView) で CcmsgBubble を描画するため、boundary 側 (下の
  // groups.map) と fold-group 側が **同一の可視 key 集合** (visibleCcmsgKeys、
  // 上の分類フェーズで確定) を参照する。どちらの経路も読むだけなので、
  // fold の開閉が何度起きても判定は変わらない。
  // Memoized because a context value is the one prop `memo` can't intercept:
  // a new object here re-renders every ccmsg bubble in the transcript, past
  // the memoized fold groups that would otherwise have been skipped.
  const ccmsgRenderValue = useMemo<CcmsgRenderCtxValue>(
    () => ({ now, rooms: appState.rooms, peers: appState.peers, visibleCcmsgKeys }),
    [now, appState.rooms, appState.peers, visibleCcmsgKeys],
  );
  return (
    <FileToolSidContext.Provider value={sid}>
      <SessionFilePathCtxContext.Provider value={sessionFilePathCtx}>
        <AgentTimelineHrefsContext.Provider value={agentTimelineHrefs}>
          <TimelineAutoOpenContext.Provider value={autoOpenContext}>
            <FoldOpenContext.Provider value={foldOpenStore}>
              <CcmsgRenderContext.Provider value={ccmsgRenderValue}>
                <ItemRawContext.Provider value={getItemRawRows}>
                  <div
                    class="timeline-view"
                    ref={scrollRef}
                    style={{ "--tl-float-reserve": `${floatReserve}px` }}
                  >
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
                      <>
                        <SearchBar
                          words={parsedSearch.words}
                          queryText={searchQueryText}
                          onQueryChange={(queryText) => changeSearch({ queryText })}
                          caseSensitive={searchCaseSensitive}
                          onToggleCaseSensitive={() =>
                            changeSearch({ caseSensitive: !searchCaseSensitive })
                          }
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
                          foldScope={{
                            searchClosedFolds,
                            onToggle: toggleSearchClosedFolds,
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
                      </>
                      <button type="button" onClick={scrollToTop} title="最上部へ">
                        ⤒
                      </button>
                      <button type="button" onClick={scrollToBottom} title="最下部へ">
                        ⤓
                      </button>
                    </div>
                    {timeline.status === "error" ? (
                      <ErrorView
                        mark="!"
                        tone="danger"
                        title="transcript を読み込めませんでした"
                        detail={timeline.error}
                        action={{ label: "再試行 (tail から読み直す)", onClick: refresh }}
                      />
                    ) : (
                      <div class="tl-lines" ref={tlLinesRef}>
                        {parsed.length === 0 && says.length === 0 ? (
                          <p class="tl-empty">(空の transcript)</p>
                        ) : (
                          <>
                            {sayReadError !== null ? (
                              <p class="tl-say-error">{sayReadError}</p>
                            ) : null}
                            {groups
                              .map((group, i) => {
                                if (group.kind === "fold") {
                                  return (
                                    <MemoFoldGroup
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
                                      <ItemRawToggle
                                        key={offset}
                                        offset={offset}
                                        uuid={line.uuid}
                                        selectedPosition={currentPosition === line.uuid}
                                        onSelectPosition={selectPosition}
                                      >
                                        <UserPromptBubble
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
                                      </ItemRawToggle>
                                    );
                                  case "assistant-response":
                                    return (
                                      <ItemRawToggle
                                        key={offset}
                                        offset={offset}
                                        uuid={line.uuid}
                                        selectedPosition={currentPosition === line.uuid}
                                        onSelectPosition={selectPosition}
                                      >
                                        <AssistantBubble
                                          line={line}
                                          offset={offset}
                                          translationAvailability={translationAvailability}
                                          now={now}
                                          searchCtx={searchCtx}
                                          actions={bubbleActions}
                                        />
                                      </ItemRawToggle>
                                    );
                                  case "api-error":
                                    return (
                                      <ItemRawToggle
                                        key={offset}
                                        offset={offset}
                                        uuid={line.uuid}
                                        selectedPosition={currentPosition === line.uuid}
                                        onSelectPosition={selectPosition}
                                      >
                                        <ApiErrorNotice line={line} />
                                      </ItemRawToggle>
                                    );
                                  case "bash-command":
                                    return (
                                      <ItemRawToggle
                                        key={offset}
                                        offset={offset}
                                        uuid={line.uuid}
                                        selectedPosition={currentPosition === line.uuid}
                                        onSelectPosition={selectPosition}
                                      >
                                        <BashRunCard
                                          command={boundary.segment.command}
                                          output={boundary.segment.output}
                                          ts={line.ts}
                                        />
                                      </ItemRawToggle>
                                    );
                                  case "bash-command-output":
                                    return (
                                      <ItemRawToggle
                                        key={offset}
                                        offset={offset}
                                        uuid={line.uuid}
                                        selectedPosition={currentPosition === line.uuid}
                                        onSelectPosition={selectPosition}
                                      >
                                        <BashRunCard
                                          command={null}
                                          output={boundary.segment}
                                          ts={line.ts}
                                        />
                                      </ItemRawToggle>
                                    );
                                  case "ccmsg": {
                                    // raw タブ用の「この行に何が書いてあったか」:
                                    // extractCcmsgMessages が読むのと同じ text segment 結合
                                    // (subscribe / teammate-message wrapper の原文はそこにある)。
                                    const rawText = line.segments
                                      .filter(
                                        (s): s is Extract<Segment, { kind: "text" }> =>
                                          s.kind === "text",
                                      )
                                      .map((s) => s.text)
                                      .join("\n");
                                    return boundary.messages
                                      .map((m, j) => {
                                        if (!visibleCcmsgKeys.has(ccmsgUnitKey(offset, j)))
                                          return null;
                                        const navKey = `ccmsg:${offset}:${j}`;
                                        return (
                                          <ItemRawToggle
                                            key={`${offset}-${j}`}
                                            offset={offset}
                                            uuid={line.uuid}
                                            selectedPosition={currentPosition === line.uuid}
                                            onSelectPosition={selectPosition}
                                          >
                                            <CcmsgBubble
                                              message={m}
                                              rawText={rawText}
                                              now={now}
                                              searchKey={ccmsgUnitKey(offset, j)}
                                              searchCtx={searchCtx}
                                              navKey={
                                                userTurnKeySet.has(navKey) ? navKey : undefined
                                              }
                                              registerUserTurnRef={registerUserTurnRef}
                                              onUserTurnClick={onUserTurnClick}
                                              selected={selectedUserTurnKey === navKey}
                                              room={appState.rooms.get(m.room)}
                                              peers={appState.peers}
                                            />
                                          </ItemRawToggle>
                                        );
                                      })
                                      .filter((n) => n !== null);
                                  }
                                }
                              })
                              // Index-aligned with `groups` on both counts: the seam
                              // splices in ahead of the first group of forked-off
                              // history, and each slot's say bubbles ahead of the
                              // first group that is newer than them.
                              .flatMap((node, i) => [
                                ...sayNodes(i),
                                ...(i === forkDividerIndex
                                  ? [<ForkDivider key="fork-divider" origin={forkOrigin!} />, node]
                                  : [node]),
                              ])}
                            {/* 読み込み済み window より新しい say (= 喋った turn の行が
                                まだ jsonl に無い live のケース) は末尾に出す。 */}
                            {sayNodes(groups.length)}
                          </>
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
                        aria-label={autoOpenPanelOpen ? "パネルを閉じる" : "パネルを開く"}
                        aria-expanded={autoOpenPanelOpen}
                        onClick={() => setAutoOpenPanelOpen((open) => !open)}
                      >
                        {autoOpenPanelOpen ? "›" : "‹"}
                      </button>
                      <div class="tl-float-body">
                        <fieldset
                          class="tl-auto-open"
                          aria-label="自動オープンする Timeline カテゴリ"
                        >
                          <legend>auto open</legend>
                          {(["U", "R", "C", "T", "A"] as const).map((category) => {
                            const fixed = category === "U" || category === "R";
                            // C/T/A の checkbox 表示状態と toggle 対象キーの対応。
                            // U/R は境界要素なので常に表示 (fixed)。
                            const settingKey =
                              category === "C" ? "ccmsg" : category === "T" ? "thinking" : "agent";
                            return (
                              <label
                                key={category}
                                title={fixed ? "常に表示" : `${category} を自動オープン`}
                              >
                                <input
                                  type="checkbox"
                                  checked={fixed ? true : autoOpenSettings[settingKey]}
                                  disabled={fixed}
                                  onChange={() => {
                                    if (!fixed) toggleAutoOpen(settingKey);
                                  }}
                                />
                                {category}
                              </label>
                            );
                          })}
                          <span class="tl-auto-open-separator" aria-hidden="true" />
                          <label title="C/T/A を含む外側の fold を自動オープン">
                            <input
                              type="checkbox"
                              checked={autoOpenSettings.items}
                              onChange={() => toggleAutoOpen("items")}
                            />
                            N items
                          </label>
                        </fieldset>
                      </div>
                    </div>
                    <div class="tl-bottom-controls">
                      {/* 非対話 (kawaz r135m37): FAB と重なる位置にあり、
                       * ボタンだと誤クリックで Status タブへ飛ぶ事故が多い。
                       * 表示はそのまま残し、クリック導線だけ塞ぐ。 */}
                      {miniLines.length > 0 ? (
                        <div class="tl-status-mini">
                          {miniLines.map((line) => (
                            <span
                              key={`${line.kind}-${line.text}`}
                              class={`tl-status-mini-line tl-status-mini-${line.kind}`}
                            >
                              {line.text}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </ItemRawContext.Provider>
              </CcmsgRenderContext.Provider>
            </FoldOpenContext.Provider>
          </TimelineAutoOpenContext.Provider>
        </AgentTimelineHrefsContext.Provider>
      </SessionFilePathCtxContext.Provider>
    </FileToolSidContext.Provider>
  );
}
