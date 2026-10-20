// 1 秒ごとに更新される現在時刻 hook。進行中の経過時間 (「応答中 …1m12s」)
// を秒単位で進めるための専用で、分単位の雑更新でよい相対時間表示は
// useNow (3 分おき) を使う。mount 中だけ interval を張り、値は epoch ms。
import { useEffect, useState } from "preact/hooks";

export const SECOND_TICK_MS = 1000;

export function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), SECOND_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
