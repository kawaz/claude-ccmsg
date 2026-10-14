// in-view 検索 (DR-0022): クエリの parse、検索対象の unit の一覧、[N/M] の
// 数え方 (📁 で閉じた fold を含めるか)、ハイライトの塗り、↑/↓ での移動と
// 閉じた fold の中の一致への到達。
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import { useApp } from "../../context.ts";
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
} from "../../in-view-search.ts";
import {
  highlightRenderedText,
  removeRenderedTextHighlights,
  setRenderedTextCurrent,
  visibleRenderedText,
} from "../../rendered-text-search.ts";
import { readStorage, writeStorage } from "../../storage.ts";
import type { SessionTreeState } from "../../store.ts";
import {
  isApiErrorLine,
  isCacheKeepaliveReplyLine,
  isSearchableSegment,
  isUserSpeechKind,
  segmentSearchText,
  type ccmsgRenderTargets,
  type ParsedLine,
  type TimelineGroup,
} from "../../transcript-model.ts";
import { getTranslationLookup, subscribeTranslationRegistry } from "../../translate.ts";
import { useResettableState } from "../../useKeyedState.ts";
import type { ScrollHold } from "../../useScrollHold.ts";

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
export interface TLSearchCtx {
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

// Auto-expand every ancestor <details> (fold group / system-message fold)
// before scrolling — Phase 2's "fold との相互作用込み"
// (DR-0022 §4): a match living inside a collapsed fold must actually
// become visible when navigated to, not silently scroll to a hidden
// element. Mirrors FoldGuide's ancestor-`<details>`-via-`closest()` trick
// (folds.tsx), walking outward through nested folds.
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

function revealAndScroll(el: HTMLElement, scrollHold: ScrollHold) {
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
  const first = el.firstElementChild;
  const target = first instanceof HTMLElement ? first : el;
  // Held, not scrolled once: opening the ancestor folds just above
  // triggers Preact re-renders that keep shifting layout after this
  // synchronous call — a fold group's first open auto-expands every
  // thinking inside it and kicks off ja translation (ThinkingSegment's
  // foldGroupOpen effect), each of which grows content above/around the
  // match and strands a single immediate scrollIntoView at a stale position
  // (observed 2026-07-17: match ends up outside the viewport on first nav
  // into a closed fold). The hold re-centres on every such resize until the
  // reader scrolls (useScrollHold.ts).
  scrollHold.toElement(target, (_scroller, el) => el.scrollIntoView({ block: "center" }));
}

/** このセッションの検索条件 (クエリと照合のモード)。store に持ち、Session
 * Search から引き継がれる。 */
export type TimelineSearch = SessionTreeState["timelineSearch"];

export interface InViewSearch {
  words: SearchWord[];
  hasError: boolean;
  /** "[N/M]" の M。 */
  matchCount: number;
  /** "[N/M]" の N (1 始まり、一致が無ければ 0)。 */
  currentIndex: number;
  /** ↑ / ↓: 前後の一致へ移ってそこへスクロールする (端で反対側へ回る)。 */
  prev: () => void;
  next: () => void;
  /** クエリ・大文字小文字・正規表現の変更を store に流す。 */
  changeSearch: (next: Partial<TimelineSearch>) => void;
  targets: {
    user: boolean;
    ai: boolean;
    ccmsg: boolean;
    toggleUser: () => void;
    toggleAI: () => void;
    toggleCcmsg: () => void;
  };
  /** 📁: 閉じた fold の中も [N/M] に数えるか (localStorage に保存)。 */
  foldScope: { searchClosedFolds: boolean; toggle: () => void };
  /** 各 unit の描画に渡す。クエリが空なら undefined。 */
  searchCtx: TLSearchCtx | undefined;
}

/** `search` はこのセッションの検索条件 (store の timelineSearch)。
 * `openFoldsAt` / `foldMountRevision` は閉じた fold の中の一致へ飛ぶために、
 * `scrollHold` は一致の位置を後からの伸び縮みに対して保つために使う。 */
export function useInViewSearch({
  sid,
  search,
  groups,
  ccmsgTargets,
  openFoldsAt,
  foldMountRevision,
  scrollHold,
}: {
  sid: string;
  search: TimelineSearch;
  groups: readonly TimelineGroup[];
  ccmsgTargets: ReturnType<typeof ccmsgRenderTargets>;
  openFoldsAt: (offset: number | undefined) => void;
  foldMountRevision: number;
  scrollHold: ScrollHold;
}): InViewSearch {
  const { store } = useApp();
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
  // 訳が 1 段落届くたびに差し替わる読み口。thinking の検索テキストは訳の到着で
  // 増える (原文だけ -> 原文 + 訳) ので、これを searchUnits の入力にして
  // 「訳が来たら M が増える方向で再計算される」を成立させる。unit の key は
  // 訳と無関係なので、再計算しても D0 の identity は保たれる。
  const translations = useSyncExternalStore(subscribeTranslationRegistry, getTranslationLookup);

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
        const translated = translatable ? translations.translatedTextOf(text) : null;
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
  }, [groups, ccmsgTargets, targetUser, targetAI, targetCcmsg, translations]);

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

  // A fresh search (query edit, mode/scope toggle flip, or session switch)
  // always starts back at the first match. The reset key is "the query/
  // session changed", not the match array's identity (which also changes on
  // every tail append / fold-independent reparse and would reset the index far
  // more often than intended).
  const [searchCurrentIndex, setSearchCurrentIndex] = useResettableState<number>(
    [searchQueryText, searchCaseSensitive, searchRegex, searchClosedFolds, sid],
    () => (matchingUnitKeys.length > 0 ? 1 : 0),
  );
  // A handed-off query can exist before the initial transcript page arrives.
  // In that order the query reset above sees zero matches; initialize
  // the counter when loaded content first creates a non-empty match set without
  // resetting an already-selected index on later tail updates.
  useEffect(() => {
    setSearchCurrentIndex((current) => {
      if (matchingUnitKeys.length === 0) return 0;
      if (current <= 0) return 1;
      return Math.min(current, matchingUnitKeys.length);
    });
  }, [matchingUnitKeys.length, setSearchCurrentIndex]);

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
    // The registry Map itself is never replaced, only mutated, so the cleanup
    // clears whatever is registered when it runs.
    const unitElements = searchUnitRefs.current;
    const currentKey =
      searchCurrentIndex > 0 ? matchingUnitKeys[searchCurrentIndex - 1] : undefined;
    for (const unit of searchUnits) {
      const el = unitElements.get(unit.key);
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
      for (const el of unitElements.values()) removeRenderedTextHighlights(el);
    };
  }, [
    searchUnits,
    parsedSearch,
    matchingUnitKeys,
    searchCurrentIndex,
    setSearchCurrentIndex,
    searchClosedFolds,
    foldRevision,
    foldMountRevision,
    displayRevision,
  ]);

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
    revealAndScroll(el, scrollHold);
  }, [pendingSearchReveal, foldMountRevision, scrollHold]);

  function scrollToSearchMatch(oneBasedIdx: number) {
    const key = matchingUnitKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    const el = searchUnitRefs.current.get(key);
    if (el) {
      revealAndScroll(el, scrollHold);
      return;
    }
    openFoldsAt(searchUnitOffsets.get(key));
    setPendingSearchReveal(key);
  }

  // ↑/↓ move + scroll; a highlight click only updates the index (DR-0022
  // §2.2). Loop wrap is the same pure helper the 👤 nav uses
  // (useUserTurnNav).
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

  return {
    words: parsedSearch.words,
    hasError: parsedSearch.hasError,
    matchCount: matchingUnitKeys.length,
    currentIndex: searchCurrentIndex,
    prev: searchPrev,
    next: searchNext,
    changeSearch,
    targets: {
      user: targetUser,
      ai: targetAI,
      ccmsg: targetCcmsg,
      toggleUser: () => setTargetUser((v) => !v),
      toggleAI: () => setTargetAI((v) => !v),
      toggleCcmsg: () => setTargetCcmsg((v) => !v),
    },
    foldScope: { searchClosedFolds, toggle: toggleSearchClosedFolds },
    searchCtx,
  };
}
