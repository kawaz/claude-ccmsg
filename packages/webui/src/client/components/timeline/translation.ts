// thinking / assistant 本文の ja 訳 (host / browser) の取得とタブ。
import { useEffect, useRef, useState } from "preact/hooks";
import {
  getPendingHostTranslationCount,
  subscribePendingHostTranslation,
  translateTextInBrowser,
  translateTextOnHost,
  type HostTranslateRequest,
} from "../../translate.ts";

// thinking 翻訳比較タブ (DR-0023): original は常に基準面、host/browser
// は各経路が利用可能な時だけ追加する。両翻訳経路とも `\n\n` 単位で段落分割し、
// 日本語を含む段落を保持して英語段落だけを翻訳する。
export interface TranslationAvailability {
  host: boolean;
  browser: boolean;
  // translateTextOnHost が英語段落ごとに 1 op を送るための
  // ws.translate ラッパ。複数 thinking・複数段落をまとめず、各 op を独立して
  // 並列実行する (kawaz 裁定 r34 mid=11,13-14、DR-0023 addendum)。
  hostRequest: HostTranslateRequest;
}

export type TranslationTab = "original" | "ja-host" | "ja-browser";

/** 翻訳タブ 1 行分の items。availability が false の経路はタブ自体を出さない
 * (見せる view が無い)。thinking と assistant 応答で同じ並びを使う。 */
export function translationTabItems(
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

export function useTranslatedText(
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
