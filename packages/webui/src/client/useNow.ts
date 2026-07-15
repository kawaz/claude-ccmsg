// 相対時間表示 ("3h10m" 等) の雑更新用の現在時刻 hook (kawaz r17 mid=30、
// 2026-07-15)。3 分おきの setInterval で再描画を促す — 相対時間の精度は
// 分単位で十分で、秒精度の更新はレンダーコストの無駄 (kawaz「雑更新でよく
// 3分おきとかで十分」)。mount 中だけ interval を張り、値は epoch ms。
import { useEffect, useState } from "preact/hooks";

export const NOW_REFRESH_MS = 3 * 60 * 1000;

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
