// 「サイドバーが overlay になる幅か」を JS 側で知るための hook。
//
// app.css の `@media (max-width: 720px)` と同じ境界を見る (片方だけ動かすと
// フォームがサイドバーにも main ペインにも出ない幅が生まれるので、変更時は
// 両方を直す。app.css 側の overlay ブロックにも同じ注記がある)。
//
// FilesPanes のように getComputedStyle で CSS を正本にする手は使えない:
// あちらは 1 つの要素の並び方を読むだけだが、こちらはフォームを
// 「サイドバーの中」と「main ペイン」のどちらの親に mount するかの選択で、
// CSS の表示切替で済ませようとすると両方に mount することになり、フォームの
// 入力内容と launcher の probe が二重に走る。
import { useEffect, useState } from "preact/hooks";

export const NARROW_LAYOUT_QUERY = "(max-width: 720px)";

export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_LAYOUT_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(NARROW_LAYOUT_QUERY);
    // 初期値は購読前に読んだものなので、ここで読み直す — 回転やウィンドウ
    // リサイズが mount と effect の間に入ると取りこぼす。
    setNarrow(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
