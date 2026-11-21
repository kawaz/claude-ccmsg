// 同じ間隔で時刻を進めたい component が多数ある時に、間隔ごとに 1 本だけの
// interval を共有する現在時刻 hook。SESSIONS の各行の経過時間のように、行の数
// だけ component が同じ間隔で進む場所のためで、行ごとに interval を張ると行の
// 数だけ別々の時刻に起こされる。共有すれば 1 回の tick で全部が同じ時刻に進み、
// 描き直しも 1 回にまとまる。interval は購読者がいる間だけ張り、値は epoch ms。
import { useEffect, useState } from "preact/hooks";

interface SharedClock {
  listeners: Set<(now: number) => void>;
  id: ReturnType<typeof setInterval>;
}

const clocks = new Map<number, SharedClock>();

function subscribe(intervalMs: number, listener: (now: number) => void): () => void {
  let clock = clocks.get(intervalMs);
  if (clock === undefined) {
    const listeners = new Set<(now: number) => void>();
    const id = setInterval(() => {
      const now = Date.now();
      for (const notify of listeners) notify(now);
    }, intervalMs);
    clock = { listeners, id };
    clocks.set(intervalMs, clock);
  }
  const held = clock;
  held.listeners.add(listener);
  return () => {
    held.listeners.delete(listener);
    if (held.listeners.size > 0) return;
    clearInterval(held.id);
    clocks.delete(intervalMs);
  };
}

/** `intervalMs` ごとに進む現在時刻 (epoch ms)。同じ間隔の購読者どうしは
 * 1 本の interval を共有し、同じ tick で同じ時刻を受け取る。 */
export function useSharedNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(intervalMs, setNow), [intervalMs]);
  return now;
}
