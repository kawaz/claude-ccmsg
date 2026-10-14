// "👤 N/M" のユーザ発話ナビ (kawaz spec): toolbar の ↑/↓ で前後のユーザ発話へ
// 飛び、N/M でどこを選んでいるかを出す。
//
// N はスクロール位置から推定しない (kawaz r17 mid=54, 2026-07-15: 推定は
// 「変な挙動しかしないゴミ」と判定された)。開いた時・初回の読み込み・読み直し
// で縮んだ時に最後の発話 (M) を選び、以降は ↑/↓ と発話のクリックで読み手が
// 明示的に選んだものだけを保つ。live tail の追記では勝手に動かさず、選んで
// いる発話を指したまま番号だけ付け直す。
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { loopNextIndex, loopPrevIndex } from "../../in-view-search.ts";
import type { AgentRef } from "../../locator.ts";
import type { TimelineGroup } from "../../transcript-model.ts";
import { userNavTargets } from "../../transcript-model.ts";
import { reindexStableSelection } from "../../user-nav.ts";
import { classifyEndChange, type EndMark } from "./transcript-end.ts";
import { topBelowToolbar } from "./toolbar-offset.ts";

export interface UserTurnNav {
  /** 発話バブルの key (文書順)。M はこの長さ。 */
  keys: readonly string[];
  keySet: ReadonlySet<string>;
  /** N (1 始まり、発話が無ければ 0)。 */
  currentIndex: number;
  /** ↑/↓ かクリックで選んだ後だけ、選んでいる発話の key (装飾用)。 */
  selectedKey: string | undefined;
  /** 発話バブルの DOM を key で登録する (飛び先)。 */
  registerUserTurnRef: (key: string, el: HTMLElement | null) => void;
  /** ↑ / ↓: 前後の発話を選んでそこへスクロールする (端で反対側へ回る)。 */
  goPrev: () => void;
  goNext: () => void;
  /** N のボタン: 選んでいる発話へ戻る。 */
  scrollToCurrent: () => void;
  /** 発話バブルのクリック: スクロールせずにその発話を選ぶ。 */
  onUserTurnClick: (navKey: string) => void;
}

export function useUserTurnNav({
  sid,
  agent,
  groups,
  end,
  scrollRef,
}: {
  sid: string;
  agent: AgentRef | null | undefined;
  groups: readonly TimelineGroup[];
  /** 読み込み済みの transcript の終わり (`timeline.end`)。 */
  end: number;
  scrollRef: { readonly current: HTMLElement | null };
}): UserTurnNav {
  // Stable key of every mounted green bubble in document order. The pure
  // model applies the same ccmsg deduplication as rendering, so the denominator
  // and every index in this array have exactly one DOM target.
  const keys = useMemo(() => userNavTargets(groups).map((target) => target.key), [groups]);
  const keySet = useMemo(() => new Set(keys), [keys]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [activated, setActivated] = useState(false);

  // 発話の顔ぶれ (keys) と transcript の終わり (end) のどちらが変わっても、N を
  // 1 回の更新で決める: 開いた・初回の読み込み・縮んだなら最後の発話、それ
  // 以外は選んでいた発話の新しい番号。前回の keys と終わりは自分で覚える。
  const previousKeysRef = useRef(keys);
  const markRef = useRef<EndMark | null>(null);
  useEffect(() => {
    const previousKeys = previousKeysRef.current;
    previousKeysRef.current = keys;
    const change = classifyEndChange(markRef.current, sid, end);
    markRef.current = { sid, end };
    const selectLast = change === "entered" || change === "initial-load" || change === "shrank";
    setCurrentIndex((current) =>
      selectLast ? keys.length : (reindexStableSelection(current, previousKeys, keys) ?? current),
    );
  }, [keys, sid, end]);

  useEffect(() => {
    setActivated(false);
  }, [sid, agent?.agentId, agent?.runId, agent?.teammate]);

  // nav key -> mounted DOM node for each green bubble. Entries for turns
  // dropped by a "更新" (replace) reload are pruned so the Map doesn't
  // accumulate detached nodes across repeated refreshes.
  const turnRefs = useRef(new Map<string, HTMLElement>());
  const registerUserTurnRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) turnRefs.current.set(key, el);
    else turnRefs.current.delete(key);
  }, []);
  useEffect(() => {
    const validKeys = new Set(keys);
    for (const key of turnRefs.current.keys()) {
      if (!validKeys.has(key)) turnRefs.current.delete(key);
    }
  }, [keys]);

  const animationRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    },
    [],
  );

  function scrollToTurn(oneBasedIdx: number) {
    const key = keys[oneBasedIdx - 1];
    if (key === undefined) return;
    const target = turnRefs.current.get(key);
    const container = scrollRef.current;
    if (!target || !container) return;
    setActivated(true);
    const top = topBelowToolbar(container, target);

    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
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
        animationRef.current = requestAnimationFrame(animate);
      } else {
        animationRef.current = null;
      }
    };
    animationRef.current = requestAnimationFrame(animate);
  }

  // 境界は 1 ≤ idx ≤ M。ループ遷移は DR-0022 §2.2 で search nav と共通化された
  // in-view-search.ts の loopPrevIndex/loopNextIndex に委譲。
  function goPrev() {
    const next = loopPrevIndex(currentIndex, keys.length);
    if (next === 0) return;
    setCurrentIndex(next);
    scrollToTurn(next);
  }

  function goNext() {
    const next = loopNextIndex(currentIndex, keys.length);
    if (next === 0) return;
    setCurrentIndex(next);
    scrollToTurn(next);
  }

  // 👤 nav のクリック同期 (DR-0022 §2.2 を 👤 nav にも統一適用): クリックされた
  // 吹き出しの key が keys の何番目かを引いて、スクロールなしで N を合わせる。
  // 今の描画対象に無い key なら何もしない。
  const onUserTurnClick = useCallback(
    (navKey: string) => {
      const pos = keys.indexOf(navKey);
      if (pos < 0) return;
      setActivated(true);
      setCurrentIndex(pos + 1);
    },
    [keys],
  );

  return {
    keys,
    keySet,
    currentIndex,
    selectedKey: activated ? keys[currentIndex - 1] : undefined,
    registerUserTurnRef,
    goPrev,
    goNext,
    scrollToCurrent: () => scrollToTurn(currentIndex),
    onUserTurnClick,
  };
}
