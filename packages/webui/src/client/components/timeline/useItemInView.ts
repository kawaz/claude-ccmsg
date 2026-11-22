// TL の行の列の項目 (位置 `data-timeline-uuid` を持つ行) が、TL の表示領域
// (scroller の見えている範囲から sticky な toolbar の下まで) に入っているか
// (DR-0054 §10)。末尾の「↑最新のプロンプトへ移動↑」を出すかの判定が使う。
//
// 見えているかは IntersectionObserver が知らせる値で、スクロールの event を
// 測って求めない。ブラウザの layout という外の仕組みとの同期なので Effect に
// 置く。行の要素は過去分の読み込み等で作り直されることがあるので、描いている
// 内容が変わるたびに要素を探し直して見張り直す。
import { useEffect, useState } from "preact/hooks";

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
  // 知らせは見張った位置ごとに持つ: 別の項目に替わった直後に前の項目の答えを
  // 使わない。
  const [seen, setSeen] = useState<{ uuid: string; inView: boolean } | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (uuid === null || scroller === null) return;
    const target = scroller.querySelector<HTMLElement>(
      `.tl-lines > [data-timeline-uuid="${CSS.escape(uuid)}"]`,
    );
    if (target === null) return;
    // toolbar は scroller の中で sticky に上端を覆うので、その下だけを見えて
    // いる範囲にする。
    const toolbar = scroller.querySelector<HTMLElement>(".tl-toolbar");
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last !== undefined) setSeen({ uuid, inView: last.isIntersecting });
      },
      { root: scroller, rootMargin: `-${String(toolbar?.offsetHeight ?? 0)}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
    // content は要素を探し直すきっかけとしてだけ deps に入れる。
  }, [scrollRef, uuid, content]);
  return seen !== null && seen.uuid === uuid ? seen.inView : undefined;
}
