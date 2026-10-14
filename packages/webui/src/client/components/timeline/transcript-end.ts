// 読み込み済みの transcript の終わり (`timeline.end`、byte offset) が前に見た時
// からどう動いたか。末尾追従 (useStickToBottom) と 👤 ナビ (useUserTurnNav) が、
// それぞれ自分の前回の印と比べて同じ規則で判定する。
//
// `end` は live tail の追記と tail の読み直しでだけ動き、"load older" (前に
// 足す) では動かない (store.ts の applyTimelineLoaded)。なので「伸びた」は
// 追記か、伸びた tail の読み直しを意味する。

/** 前に見た時のセッションと終わり。まだ見ていなければ null。 */
export interface EndMark {
  sid: string;
  end: number;
}

/**
 * - `entered`: 初めて見た (mount) か、別のセッションになった
 * - `initial-load`: 空 (0) から伸びた。初回の読み込みが届いた
 * - `appended`: それ以外で伸びた
 * - `shrank`: 縮んだ (読み直した tail が前より手前で終わった)
 * - `unchanged`: 同じ
 */
export type EndChange = "entered" | "initial-load" | "appended" | "shrank" | "unchanged";

export function classifyEndChange(previous: EndMark | null, sid: string, end: number): EndChange {
  if (previous === null || previous.sid !== sid) return "entered";
  if (end === previous.end) return "unchanged";
  if (end < previous.end) return "shrank";
  return previous.end === 0 ? "initial-load" : "appended";
}
