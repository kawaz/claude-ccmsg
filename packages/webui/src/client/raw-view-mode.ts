// Timeline の raw JSONL 表示 (全体 raw ビュー / 項目ごとの jsonl トグル) が
// 共有する表示モードの model (kawaz r76 m91: 「jsonl 自体は raw 状態だが
// pretty & コード装飾表示モードにも切り替え出来ると嬉しい」)。
//
// raw = 生の 1 行そのまま (ファイル上のバイト列と 1:1)、pretty = その行を
// JSON として整形した複数行。整形は「読むための投影」であって元データでは
// ないので、raw 側の verbatim 保証 (rawTranscriptRows のドクコメント) は
// そのまま残し、pretty はいつでも raw に戻せる派生表示として扱う。
import { useEffect, useState } from "preact/hooks";
import { readStorage, writeStorage } from "./storage.ts";

/** pretty 化を試みる上限文字数。これを超える行は raw のまま表示する。
 *
 * 根拠: (a) 上限を超える行はほぼ base64 の貼り付け画像 / 巨大 tool_result
 * で、JSON.parse + stringify が数 MB の中間文字列を作った末に表示側では
 * RAW_LINE_PREVIEW_LIMIT (2000 文字) まで切り詰められる = 捨てるための
 * 仕事になる。(b) highlight.ts の HIGHLIGHT_MAX_BYTES と同値にしてあり、
 * これを超えた時点で Shiki 側も plain fallback するため、整形しても
 * 「コード装飾」という目的自体が達成できない。 */
export const RAW_PRETTY_MAX_CHARS = 200 * 1024;

/** pretty 化の結果。失敗は例外でなく理由付きの値で返す — 呼び出し側 (行の
 * 描画) はどちらの理由でも「raw のまま出す」に degrade するが、読み手には
 * 理由を出し分けて見せる必要があるため。 */
export type RawLinePretty =
  | { ok: true; text: string }
  | { ok: false; reason: "invalid-json" | "too-large" };

/**
 * 生 JSONL 1 行を 2 スペースインデントの JSON に整形する。
 *
 * JSON として読めない行 (書き込み途中で切れた末尾行、非 JSON のゴミ行) は
 * `invalid-json`。壊れた行こそ raw で確認したいというのが raw ビューの
 * 存在理由なので、部分パースや修復は一切しない。
 */
export function prettyRawLine(text: string, limit: number = RAW_PRETTY_MAX_CHARS): RawLinePretty {
  if (text.length > limit) return { ok: false, reason: "too-large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  // `undefined` を返し得るのは JSON.parse の結果としてはあり得ない
  // (JSON に undefined は無い) が、型の上では string を返す保証が無いので
  // 明示的に潰しておく。
  const out = JSON.stringify(parsed, null, 2);
  if (typeof out !== "string") return { ok: false, reason: "invalid-json" };
  return { ok: true, text: out };
}

/** pretty 化できる行かだけを判定する (整形結果は捨てる)。モード切替ボタンの
 * 活殺判定用 — 行が 1 つも整形できないなら pretty を選ばせない。 */
export function canPrettyRawLine(text: string, limit: number = RAW_PRETTY_MAX_CHARS): boolean {
  if (text.length > limit) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** raw 表示のモードの localStorage key。セッションごとではなくグローバル —
 * 「JSONL をどう読みたいか」という読み手の習慣であって、特定セッションの
 * 性質ではないため (in-view-search の CLOSED_FOLD_SCOPE_KEY と同じ posture)。 */
export const RAW_PRETTY_KEY = "ccmsg.rawView.pretty";

/** 明示的な "1" 以外は raw (= これまでの唯一の表示) に解決する。壊れた
 * 永続値も既定に落ちるだけで例外にしない (parseSearchClosedFolds と同じ)。 */
export function parseRawViewPretty(raw: string | null): boolean {
  return raw === "1";
}

export function serializeRawViewPretty(value: boolean): string {
  return value ? "1" : "0";
}

// --- グローバルな現在値 (store + hook) ---
//
// Timeline の local state ではなくモジュールに置く。この設定は localStorage
// に載るプロセス全体の好みであって、どの Timeline を見ているかとは独立して
// いる: TimelinePanes は Timeline を複数同時に mount するので、per-component
// state だと「片方のペインで pretty にしても隣は raw のまま」という、
// 永続設定としては辻褄の合わない状態が作れてしまう。store 越しなら購読中の
// 全 Timeline が 1 つの値を見る (useStore.ts と同型の最小 store)。

let pretty: boolean | null = null;
const listeners = new Set<() => void>();

/** 現在の pretty 設定。初回だけ localStorage から解決してメモする。 */
export function getRawViewPretty(): boolean {
  pretty ??= parseRawViewPretty(readStorage(RAW_PRETTY_KEY));
  return pretty;
}

/** 設定を変更して購読者に通知し、localStorage へ永続化する。 */
export function setRawViewPretty(value: boolean): void {
  if (getRawViewPretty() === value) return;
  pretty = value;
  writeStorage(RAW_PRETTY_KEY, serializeRawViewPretty(value));
  for (const listener of listeners) listener();
}

export function subscribeRawViewPretty(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 呼び出し元を pretty 設定の変更で再描画させる (useStoreState と同じ形)。 */
export function useRawViewPretty(): boolean {
  const [value, setValue] = useState(getRawViewPretty);
  useEffect(() => subscribeRawViewPretty(() => setValue(getRawViewPretty())), []);
  return value;
}
