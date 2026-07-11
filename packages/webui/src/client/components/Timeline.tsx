// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TimelineState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { errorMessage, formatClockTime } from "../utils.ts";
import {
  foldGroupLabel,
  groupTimelineLines,
  isUserTextTurn,
  lineByteOffsets,
  parseTranscriptLine,
  scrollPositionToUserTurnIndex,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "../transcript-model.ts";
import { MarkdownView } from "../markdown-view.tsx";
import { hasTranslatorApi, translateThinkingText } from "../translate.ts";

// Live tail 自動スクロール追従 (U2 kawaz spec: 「ユーザが最下部付近を見ている
// 時だけ自動スクロール追従、上にスクロール中は追従しない」) の「最下部付近」
// のしきい値 (px)。ちょうど末端に張り付いていなくても数行分の余裕は追従対象
// にする、というよくあるチャット UI の慣習値。
const NEAR_BOTTOM_PX = 80;

// thinking 翻訳タブ (U2 kawaz spec): Chrome built-in Translator API が使える
//環境でのみ original|ja タブを描画する (feature-detect は hasTranslatorApi
// 呼び出し側で行う。タブ自体を出さない = レイアウト変化なし、という spec の
// 要件を満たすためモジュールレベルで一度だけ判定してコンポーネントに渡す)。
function ThinkingSegment({
  text,
  translatorAvailable,
}: {
  text: string;
  translatorAvailable: boolean;
}) {
  const [tab, setTab] = useState<"original" | "ja">("original");
  // null = まだ翻訳していない (ja タブ初回クリックで遅延実行、kawaz spec)。
  // 翻訳結果自体は translate.ts 側で段落単位にメモリキャッシュされるので、
  // fold 開閉やタブ往復で再翻訳は起きない。
  const [jaText, setJaText] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  function selectJa() {
    setTab("ja");
    if (jaText === null && !translating) {
      setTranslating(true);
      void translateThinkingText(text).then((result) => {
        setJaText(result);
        setTranslating(false);
      });
    }
  }

  const bodyText = tab === "ja" && jaText !== null ? jaText : text;

  return (
    <details class="tl-fold tl-thinking">
      <summary>thinking</summary>
      {translatorAvailable ? (
        <div class="tl-thinking-tabs">
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "original" ? " active" : "")}
            onClick={() => setTab("original")}
          >
            original
          </button>
          <button
            type="button"
            class={"tl-thinking-tab" + (tab === "ja" ? " active" : "")}
            onClick={selectJa}
          >
            ja
          </button>
        </div>
      ) : null}
      <div class="tl-thinking-body">
        {/* ja タブの翻訳結果も markdown レンダリング (kawaz spec: 「ja 表示も
         * markdown レンダリング」) — original と同じ MarkdownView を再利用。 */}
        <MarkdownView source={bodyText} />
        {tab === "ja" && translating && jaText === null ? (
          <p class="tl-thinking-translating">翻訳中…</p>
        ) : null}
      </div>
    </details>
  );
}

function SegmentView({
  segment,
  translatorAvailable,
}: {
  segment: Segment;
  translatorAvailable: boolean;
}) {
  switch (segment.kind) {
    case "text":
      // Markdown rendering (DR-0010) is assistant-only: a user turn's text
      // is what the human actually typed, so it's shown verbatim rather than
      // interpreted as markdown syntax.
      return (
        <div class={"tl-text tl-text-" + segment.role}>
          {segment.role === "assistant" ? <MarkdownView source={segment.text} /> : segment.text}
        </div>
      );
    case "thinking":
      return <ThinkingSegment text={segment.text} translatorAvailable={translatorAvailable} />;
    case "tool-use":
      return (
        <details class="tl-fold">
          <summary>tool_use: {segment.name}</summary>
          <pre class="tl-fold-body">{JSON.stringify(segment.input, null, 2)}</pre>
        </details>
      );
    case "tool-result":
      return (
        <details class="tl-fold">
          <summary>tool_result{segment.isError ? " (error)" : ""}</summary>
          <pre class="tl-fold-body">{segment.text}</pre>
        </details>
      );
    case "unknown-segment":
      return (
        <details class="tl-fold">
          <summary>{segment.type}</summary>
          <pre class="tl-fold-body">{JSON.stringify(segment.raw, null, 2)}</pre>
        </details>
      );
  }
}

function LineView({
  line,
  offsetKey,
  registerUserTurnRef,
  translatorAvailable,
}: {
  line: ParsedLine;
  offsetKey: number;
  // Registers/unregisters this line's root element for a user-text turn only
  // (isUserTextTurn) — the "👤 N/M" nav indicator's DOM-measurement side, see
  // Timeline()'s userTurnRefs. No-op for every other line kind.
  registerUserTurnRef: (key: number, el: HTMLDivElement | null) => void;
  translatorAvailable: boolean;
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
      <details class="tl-line tl-meta">
        <summary>
          {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
          <span class="tl-meta-summary">{line.summary}</span>
        </summary>
        <pre class="tl-fold-body">{line.raw}</pre>
      </details>
    );
  }
  const isUserText = isUserTextTurn(line);
  // システム由来の "type:user" メッセージ分類 (U2 kawaz spec,
  // transcript-model.ts's classifyUserMessage): role:"user" かつ
  // "user-prompt" (= 本物のユーザ発話) 以外の kind が付いているラインだけ
  // チップを出し、緑吹き出しスタイル (.tl-text-user) を打ち消す
  // (.tl-turn-syskind, app.css)。この LineView 自体は「fold group の中の
  // 1 entry」としても「standalone entry」としても同じ描画ロジックを使う
  // (FoldGroup が entries.map で LineView を再利用) ので、グルーピングが
  // 変わってもチップ表示は変わらない。isUserTextTurn (U2 で改訂:
  // userMessageKind !== "user-prompt" なシステム由来メッセージは false) は
  // isBoundaryLine の判定にも使われるため、システム由来メッセージは境界に
  // ならず fold group 側に入る — その場合もここで同じチップ付き表示になる。
  const sysKind =
    line.role === "user" && line.userMessageKind && line.userMessageKind !== "user-prompt"
      ? line.userMessageKind
      : null;
  return (
    <div
      class={"tl-line tl-turn tl-turn-" + line.role + (sysKind ? " tl-turn-syskind" : "")}
      ref={isUserText ? (el) => registerUserTurnRef(offsetKey, el) : undefined}
    >
      {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
      {sysKind ? <span class="tl-user-kind-chip">{sysKind}</span> : null}
      <div class="tl-segments">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => (
            <SegmentView key={i} segment={seg} translatorAvailable={translatorAvailable} />
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
// unit-tested function; this component only renders it).
function FoldGroup({
  entries,
  registerUserTurnRef,
  translatorAvailable,
}: {
  entries: TimelineEntry[];
  registerUserTurnRef: (key: number, el: HTMLDivElement | null) => void;
  translatorAvailable: boolean;
}) {
  return (
    <details class="tl-line tl-fold-group">
      <summary>{foldGroupLabel(entries)}</summary>
      <div class="tl-fold-group-body">
        {entries.map(({ offset, line }) => (
          <LineView
            key={offset}
            line={line}
            offsetKey={offset}
            registerUserTurnRef={registerUserTurnRef}
            translatorAvailable={translatorAvailable}
          />
        ))}
      </div>
    </details>
  );
}

export function Timeline({ sid, timeline }: { sid: string; timeline: TimelineState }) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;

  // Chrome built-in Translator API の feature-detect (U2 kawaz spec): 環境が
  // 変わらない限り再評価不要なので mount 時に一度だけ判定する。
  const translatorAvailable = useMemo(() => hasTranslatorApi(), []);

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
  useEffect(() => {
    if (connStatus !== "connected") return;
    void ws.transcriptSubscribe(sid).catch(() => {});
    return () => {
      void ws.transcriptUnsubscribe(sid).catch(() => {});
    };
  }, [sid, connStatus]);

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
      .transcriptRead(sid)
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
      .transcriptRead(sid)
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

  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, { before: timeline.start })
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
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }

  // Re-parsing on every render is cheap (pure JSON.parse over cached
  // strings), but memoizing keeps it off the hot path of unrelated re-renders
  // (e.g. sidebar toggles) that don't change `timeline.lines`.
  const parsed = useMemo(() => timeline.lines.map(parseTranscriptLine), [timeline.lines]);
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

  // --- "👤 N/M" user-turn nav (kawaz spec): toolbar buttons to jump to the
  // top/bottom of the loaded transcript and to the previous/next user-text
  // turn, plus a live "current position" counter. ---

  // Preact-key (byte offset, stable across prepend) of every currently-loaded
  // user-text turn, in document order — the "M" denominator and the index
  // space goPrevUserTurn/goNextUserTurn/scrollPositionToUserTurnIndex work in.
  const userTurnKeys = useMemo(
    () =>
      parsed
        .map((line, i) => (isUserTextTurn(line) ? offsets[i] : null))
        .filter((k): k is number => k !== null),
    [parsed, offsets],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // key (byte offset) -> mounted DOM node for each user-text turn, populated
  // by LineView's ref callback. Only ever read for keys currently in
  // userTurnKeys; entries for turns dropped by a "更新" (replace) reload are
  // pruned below rather than left to leak.
  const userTurnRefs = useRef(new Map<number, HTMLDivElement>());
  const registerUserTurnRef = useCallback((key: number, el: HTMLDivElement | null) => {
    if (el) userTurnRefs.current.set(key, el);
    else userTurnRefs.current.delete(key);
  }, []);

  // 1-based "you're currently past turn N" count (0 = scrolled above the
  // first loaded user turn). Recomputed on scroll (rAF-throttled) and
  // whenever the loaded lines change (older-load/refresh shift both the
  // denominator and which turn is "current").
  const [currentUserIdx, setCurrentUserIdx] = useState(0);

  const recomputeCurrentUserIdx = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const tops = userTurnKeys
      .map((key) => userTurnRefs.current.get(key))
      .filter((el): el is HTMLDivElement => el != null)
      .map((el) => el.getBoundingClientRect().top - containerTop + container.scrollTop);
    setCurrentUserIdx(scrollPositionToUserTurnIndex(tops, container.scrollTop));
  }, [userTurnKeys]);

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

    const container = scrollRef.current;
    if (!container) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        recomputeCurrentUserIdx();
        checkNearBottom();
        ticking = false;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Recompute once immediately — otherwise the indicator stays "0/M" until
    // the first scroll event fires (e.g. right after the initial tail load).
    recomputeCurrentUserIdx();
    checkNearBottom();
    return () => container.removeEventListener("scroll", onScroll);
  }, [userTurnKeys, recomputeCurrentUserIdx, checkNearBottom]);

  // セッション切替時、前セッションの「どこまで読んだか (byte end)」を引き
  // 継がないようにリセットする — このリセットを先に走らせておくことで、下の
  // tail 検知 effect が「セッション切替による end の変化」を「tail 追記」と
  // 誤認して意図しない自動スクロールを起こさない (両 effect の実行順序は
  // 定義順、[sid] だけに依存するこの effect が先に走る)。
  const prevEndRef = useRef(timeline.end);
  useEffect(() => {
    prevEndRef.current = timeline.end;
    isNearBottomRef.current = true;
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
    prevEndRef.current = timeline.end;
    if (!appended || !isNearBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.end]);

  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function scrollToUserTurn(oneBasedIdx: number) {
    const key = userTurnKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    userTurnRefs.current.get(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // No "turn 0" — prev is only meaningful once we've passed at least a
  // second turn (currentUserIdx <= 1 means we're at/before the first).
  function goPrevUserTurn() {
    if (currentUserIdx <= 1) return;
    scrollToUserTurn(currentUserIdx - 1);
  }

  function goNextUserTurn() {
    if (currentUserIdx >= userTurnKeys.length) return;
    scrollToUserTurn(currentUserIdx + 1);
  }

  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  return (
    <div class="timeline-view" ref={scrollRef}>
      <div class="tl-toolbar">
        <button
          type="button"
          disabled={timeline.atStart || timeline.status === "loading"}
          onClick={loadOlder}
        >
          {timeline.atStart ? "先頭まで読み込み済み" : "older を読み込む"}
        </button>
        <button type="button" disabled={timeline.status === "loading"} onClick={refresh}>
          更新
        </button>
        <button type="button" onClick={scrollToTop} title="最上部へ">
          ⤒
        </button>
        <button type="button" onClick={scrollToBottom} title="最下部へ">
          ⤓
        </button>
        <div class="tl-user-nav">
          <span class="tl-user-nav-count">
            👤 {currentUserIdx}/{userTurnKeys.length}
          </span>
          <button
            type="button"
            disabled={currentUserIdx <= 1}
            onClick={goPrevUserTurn}
            title="前のユーザ発言へ"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={currentUserIdx >= userTurnKeys.length}
            onClick={goNextUserTurn}
            title="次のユーザ発言へ"
          >
            ↓
          </button>
        </div>
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
            groups.map((group) =>
              group.kind === "entry" ? (
                <LineView
                  key={group.offset}
                  line={group.line}
                  offsetKey={group.offset}
                  registerUserTurnRef={registerUserTurnRef}
                  translatorAvailable={translatorAvailable}
                />
              ) : (
                <FoldGroup
                  key={group.entries[0]!.offset}
                  entries={group.entries}
                  registerUserTurnRef={registerUserTurnRef}
                  translatorAvailable={translatorAvailable}
                />
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
