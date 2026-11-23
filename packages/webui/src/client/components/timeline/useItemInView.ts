// TL の行の列の項目 (位置 `data-timeline-uuid` を持つ行) が、TL の表示領域
// (scroller の見えている範囲から sticky な toolbar の下まで) に入っているか
// (DR-0054 §10)。末尾の「↑最新のプロンプトへ移動↑」を出すかの判定が使う。
//
// 見えているかは IntersectionObserver が知らせる値で、スクロールの event を
// 測って求めない。ブラウザの layout という外の仕組みとの同期なので Effect に
// 置く。行の要素は過去分の読み込み等で作り直されることがあるので、描いている
// 内容が変わるたびに要素を探し直して見張り直す。
import { useEffect, useState } from "preact/hooks";
import { useEffectEvent } from "../../useEffectEvent.ts";

/** 位置 `uuid` の項目が TL の表示領域に入っているか。まだ知らせが来ていない
 * 時と、窓にその項目の要素が無い時は undefined。 */
export function useItemInView({
  scrollRef,
  uuid,
  content,
}: {
  /** TL の scroller (`.timeline-view`)。 */
  scrollRef: { readonly current: HTMLElement | null };
  /** 見張る項目の位置。null なら見張らない。 */
  uuid: string | null;
  /** 描いている内容 (group の列)。変わるたびに要素を探し直す (中身は読まない)。 */
  content: unknown;
}): boolean | undefined {
  return useInView({
    scrollRef,
    key: uuid,
    content,
    // toolbar は scroller の中で sticky に上端を覆うので、その下だけを見えて
    // いる範囲にする。
    findTarget: (scroller) =>
      uuid === null
        ? null
        : scroller.querySelector<HTMLElement>(
            `.tl-lines > [data-timeline-uuid="${CSS.escape(uuid)}"]`,
          ),
    topInset: (scroller) => scroller.querySelector<HTMLElement>(".tl-toolbar")?.offsetHeight ?? 0,
    bottomOutset: 0,
  });
}

/** 末尾の番兵が表示領域の下端に届いたとみなす余裕 (px)。最下部まで動いても
 * scrollTop が整数に丸められ、番兵が小数 px だけ下に残ることがある。 */
const TAIL_TOLERANCE_PX = 2;

/** TL の並びの末尾の番兵 (高さ 0 の要素) が TL の表示領域に入っているか
 * (DR-0054 §11)。入っていない = 最後の項目の下端が表示領域の下にある。
 * まだ知らせが来ていない時と、番兵が描かれていない時は undefined。 */
export function useTailInView({
  scrollRef,
  tailRef,
  content,
}: {
  /** TL の scroller (`.timeline-view`)。 */
  scrollRef: { readonly current: HTMLElement | null };
  /** 並びの末尾に置いた番兵。 */
  tailRef: { readonly current: HTMLElement | null };
  /** 描いている内容 (group の列)。変わるたびに要素を探し直す (中身は読まない)。 */
  content: unknown;
}): boolean | undefined {
  return useInView({
    scrollRef,
    key: "tail",
    content,
    findTarget: () => tailRef.current,
    topInset: () => 0,
    bottomOutset: TAIL_TOLERANCE_PX,
  });
}

function useInView({
  scrollRef,
  key,
  content,
  findTarget,
  topInset,
  bottomOutset,
}: {
  scrollRef: { readonly current: HTMLElement | null };
  /** 見張る対象の名札。替わった直後に前の答えを使わない。null なら見張らない。 */
  key: string | null;
  content: unknown;
  findTarget: (scroller: HTMLElement) => Element | null;
  topInset: (scroller: HTMLElement) => number;
  /** 表示領域の下端を外へ広げる分 (px)。 */
  bottomOutset: number;
}): boolean | undefined {
  // 知らせは見張った対象ごとに持つ: 別の対象に替わった直後に前の対象の答えを
  // 使わない。
  const [seen, setSeen] = useState<{ key: string; inView: boolean } | null>(null);
  const find = useEffectEvent(findTarget);
  const inset = useEffectEvent(topInset);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (key === null || scroller === null) return;
    const target = find(scroller);
    if (target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last !== undefined) setSeen({ key, inView: last.isIntersecting });
      },
      {
        root: scroller,
        rootMargin: `-${String(inset(scroller))}px 0px ${String(bottomOutset)}px 0px`,
      },
    );
    observer.observe(target);
    return () => observer.disconnect();
    // content は要素を探し直すきっかけとしてだけ deps に入れる。
  }, [scrollRef, key, content, bottomOutset]);
  return seen !== null && seen.key === key ? seen.inView : undefined;
}
