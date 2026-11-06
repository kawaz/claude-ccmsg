// thinking / assistant 本文の ja 訳 (plamo / host / browser) の取得とタブ。
import type { RefObject } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getPendingHostTranslationCount,
  subscribePendingHostTranslation,
  translateTextInBrowser,
  translateTextOnHost,
  hasEnglishParagraph,
  type HostTranslateRequest,
  type PartialTextListener,
} from "../../translate.ts";
import { hasCachedPlamoText, translateTextWithPlamo } from "../../plamo-translate.ts";

// thinking 翻訳比較タブ (DR-0023、ja(plamo) は DR-0049): original は常に
// 基準面、plamo/browser/host は各経路が利用可能な時だけ追加する。どの翻訳
// 経路も `\n\n` 単位で段落分割する。browser / host は日本語を含む段落を
// 保持して英語段落だけを訳し、plamo は空でない段落を全部送る。
export interface TranslationAvailability {
  host: boolean;
  browser: boolean;
  // translateTextOnHost が英語段落ごとに 1 op を送るための
  // ws.translate ラッパ。複数 thinking・複数段落をまとめず、各 op を独立して
  // 並列実行する (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  hostRequest: HostTranslateRequest;
  /** ja(plamo) の翻訳サーバの base URL。hello で届き `/health` が通った時
   * だけあり、無ければ ja(plamo) タブを出さない (DR-0049)。 */
  plamoUrl?: string | undefined;
}

export type TranslationTab = "original" | "ja-plamo" | "ja-host" | "ja-browser";

/** 翻訳タブ 1 行分の items。availability が false の経路はタブ自体を出さない
 * (見せる view が無い)。thinking と assistant 応答で同じ並びを使う。並びは
 * 速くて品質の良い経路から、将来削る候補の host を末尾に (DR-0049 §8)。 */
export function translationTabItems(
  availability: TranslationAvailability,
): { id: TranslationTab; label: string }[] {
  return [
    { id: "original", label: "original" },
    ...(availability.plamoUrl !== undefined
      ? [{ id: "ja-plamo" as const, label: "ja(plamo)" }]
      : []),
    ...(availability.browser ? [{ id: "ja-browser" as const, label: "ja(browser)" }] : []),
    ...(availability.host ? [{ id: "ja-host" as const, label: "ja(host)" }] : []),
  ];
}

/** 選ばれている `tab` が今の availability で出ているタブか (original は常に
 * 出ている)。再接続で daemon が替わる・翻訳サーバの URL が消えると、選んで
 * いた訳タブの経路が無くなる — その時は original へ戻すための判定。 */
export function isTranslationTabOffered(
  tab: TranslationTab,
  availability: TranslationAvailability,
): boolean {
  return translationTabItems(availability).some((item) => item.id === tab);
}

/** 翻訳タブを 1 つでも出すか。 */
export function hasTranslationTabs(availability: TranslationAvailability): boolean {
  return availability.plamoUrl !== undefined || availability.host || availability.browser;
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

/** 1 経路でテキストを訳す関数。null はその経路が使えない。 */
type RouteTranslator = ((text: string, onPartial: PartialTextListener) => Promise<string>) | null;

/** 1 経路ぶんの訳の状態。`active` (その経路のタブが選ばれている) の間に、
 * この原文の完成訳も進行中の翻訳も無ければ翻訳を起動する。 */
function useRouteTranslation(
  text: string,
  active: boolean,
  translate: RouteTranslator,
): { text: string | null; done: boolean; translating: boolean } {
  const [body, setBody] = useState<TranslatedBody | null>(null);
  // 「今この原文を訳している最中」を原文そのもので表す (boolean だと text が
  // 変わった時に前の原文の進行中フラグと区別できない)。
  const [pending, setPending] = useState<string | null>(null);

  const current = body !== null && body.source === text ? body : null;
  const done = current?.done ?? false;
  const translating = pending === text;

  useEffect(() => {
    if (!active || translate === null || done || translating) return;
    setPending(text);
    // 途中経過は「この原文の翻訳を今走らせている自分」だけが書く。text が
    // 差し替わった後に前の原文の遅れた partial が届いても source が違うので
    // 表示には出ない (current の source 一致判定で落ちる)。
    void translate(text, (partial) => setBody({ source: text, text: partial, done: false }))
      .then((result) => setBody({ source: text, text: result, done: true }))
      // 経路ごと失敗した時は原文へ倒す (タブは選ばれたまま、内容は原文)。
      .catch(() => setBody({ source: text, text, done: true }))
      .finally(() => setPending((p) => (p === text ? null : p)));
  }, [active, text, translate, done, translating]);

  return { text: current?.text ?? null, done, translating };
}

export function useTranslatedText(
  text: string,
  availability: TranslationAvailability,
  tab: TranslationTab,
  /** 表示中の綴りが差し替わった時に呼ばれる (in-view search の再計算契機)。 */
  onDisplayChange?: () => void,
): { bodyText: string; translatingLabel: string | null } {
  const { plamoUrl, hostRequest } = availability;
  const hostAvailable = availability.host;
  const browserAvailable = availability.browser;
  const plamoTranslate = useMemo<RouteTranslator>(
    () =>
      plamoUrl === undefined
        ? null
        : (source, onPartial) => translateTextWithPlamo(source, plamoUrl, onPartial),
    [plamoUrl],
  );
  const hostTranslate = useMemo<RouteTranslator>(
    () =>
      hostAvailable
        ? (source, onPartial) => translateTextOnHost(source, hostRequest, onPartial)
        : null,
    [hostAvailable, hostRequest],
  );
  const browserTranslate = useMemo<RouteTranslator>(
    () => (browserAvailable ? translateTextInBrowser : null),
    [browserAvailable],
  );
  const plamo = useRouteTranslation(text, tab === "ja-plamo", plamoTranslate);
  const host = useRouteTranslation(text, tab === "ja-host", hostTranslate);
  const browser = useRouteTranslation(text, tab === "ja-browser", browserTranslate);
  const selected =
    tab === "ja-plamo" ? plamo : tab === "ja-host" ? host : tab === "ja-browser" ? browser : null;

  const bodyText = selected?.text ?? text;

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
  const translating = selected !== null && selected.translating && !selected.done;

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
    // 待ちキューは host 経路のみ意味を持つ (browser / plamo は直列でない)。
    if (tab === "ja-host" && pendingHostQueue > 0) parts.push(`(待ち ${pendingHostQueue})`);
    return parts.join(" ");
  })();

  return { bodyText, translatingLabel };
}

/** 既定のタブの自動選択 (DR-0049 §8)。thinking と assistant 応答のバブルが
 * 同じ判定を使う。
 *
 * `enabled` (thinking なら fold と details が開いている) の間に、ja(plamo) が
 * 使えて本文に英語の段落が 1 つでもあれば、要素が可視範囲の近くに来た時に
 * `setTab("ja-plamo")` する。それ以外は original のまま。host / browser は
 * 比較のために選べるタブで、既定にはしない。自動選択は 1 度だけで、返す
 * `selectTab` で人がタブを選んだ後は、その後に ja(plamo) が使えるようになっても
 * (health の確認は hello の後に届く) 自動では切り替えない。 */
export function useDefaultTranslationTab({
  text,
  enabled,
  plamoUrl,
  elementRef,
  setTab,
}: {
  text: string;
  enabled: boolean;
  plamoUrl: string | undefined;
  elementRef: RefObject<Element>;
  setTab: (tab: TranslationTab) => void;
}): (tab: TranslationTab) => void {
  const decidedRef = useRef(false);
  useEffect(() => {
    if (!enabled || decidedRef.current) return;
    if (plamoUrl === undefined || !hasEnglishParagraph(text)) return;

    const selectDefault = () => {
      if (decidedRef.current) return;
      decidedRef.current = true;
      setTab("ja-plamo");
    };

    // A cache hit sends nothing, so retain the immediate display behavior even
    // when this body is outside the prefetch range.
    if (hasCachedPlamoText(text)) {
      selectDefault();
      return;
    }

    const element = elementRef.current;
    if (element === null || typeof IntersectionObserver === "undefined") {
      selectDefault();
      return;
    }

    const root = element.closest(".timeline-view");
    let cancelPending: (() => void) | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          cancelPending = enqueueViewportTranslation(element, selectDefault);
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
  }, [enabled, text, plamoUrl, elementRef, setTab]);

  return useCallback(
    (tab: TranslationTab) => {
      decidedRef.current = true;
      setTab(tab);
    },
    [setTab],
  );
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

export function enqueueViewportTranslation(element: Element, start: () => void): () => void {
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
