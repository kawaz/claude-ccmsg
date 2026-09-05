/** @jsxImportSource preact */
// クリップボードへの「コピー」ボタン。webui でコピーを提供する場所は
// StatusPanel のメタ情報 (TITLE / CWD / SESSION_ID / PID / ...) と SESSIONS
// リストの sid の 2 箇所あり、成功時の見え方 (1.5 秒だけ ✓ が出る) が揃って
// いないと「押した結果どうなるか」を場所ごとに覚え直すことになるので、
// 見た目と feedback をここに 1 本化する。
import { useEffect, useRef, useState } from "preact/hooks";

/** 成功マークが出ている時間。値そのものは押した場所に見えたままなので、
 * 「押した」ことが伝わればよく、居座らせる意味はない。 */
const COPIED_MARK_MS = 1500;

/** compact (= SESSIONS の行) のラベル。狭い行で「コピー」の 3 文字は sid の
 * 表示幅を食うので記号にする (kawaz r273 m29)。
 *
 * U+29C9 を選んだ理由は **単色で出る**こと: 📋 (U+1F4CB) は異体字セレクタ
 * U+FE0E を付けても WebKit / Chromium とも色付き絵文字のまま描かれ、行の中で
 * そこだけ色が浮く (両エンジンで実測)。同じく実測で、🗐 (U+1F5D0) / 🗎
 * (U+1F5CE) は字形が無く豆腐、❐ (U+2750) は「ただの四角」に見え、⎘
 * (U+2398) は小さすぎて潰れる。重なった 2 枚の四角は「複製」の一般的な図で、
 * 単色のまま周りの文字色に従う。 */
const COMPACT_ICON = "\u29C9";

/** ボタンに出す文字。成功時も置いたまま (見えなくするだけ) なので、ここが
 * ボタンの幅を決める。 */
export function copyButtonLabel(compact: boolean): string {
  return compact ? COMPACT_ICON : "コピー";
}

export function CopyButton({
  value,
  label,
  compact = false,
  onCopied,
}: {
  value: string;
  /** aria-label / title に入る対象名 ("CWD" 等)。ボタン自身の文字ではない。 */
  label: string;
  /** 4 行が縦に詰まった SESSIONS の行のような狭い場所向けの詰めた寸法と、
   * 文字ラベルの代わりのアイコン (下の COMPACT_ICON)。枠と色 (= コピー
   * ボタンだと分かる手掛かり) はそのまま。 */
  compact?: boolean;
  /** コピー成功の通知。押した場所側でも見せたい印がある時だけ使う
   * (SESSIONS の行では sid 自身が accent 色に染まる)。 */
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_MARK_MS);
      onCopied?.();
    } catch {
      // 失敗を成功と見分けられない印は出さない (安全でない文脈・権限拒否)。
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      class={
        "status-meta-copy" +
        (compact ? " status-meta-copy-compact" : "") +
        (copied ? " copied" : "")
      }
      title={`${label} をコピー`}
      aria-label={`${label} をコピー`}
      onClick={(e) => {
        // 行全体が選択リンクになっている場所 (SESSIONS の行) で押された時に、
        // コピーが遷移も兼ねてしまわないようにする。
        e.preventDefault();
        e.stopPropagation();
        void copy();
      }}
    >
      {/* ラベルは成功時も置いたまま (見えなくするだけ) で、✓ はその上に重ねる
       * — 文字を差し替えると「コピー」と「✓」の幅差でボタンが縮み、隣の値や
       * 行の折り返しまで動く (kawaz r259m4「押した瞬間に画面が崩れる」)。
       * ボタンが読み上げる内容は aria-label 側が持っているので、視覚要素の
       * 出し入れは AT には影響しない。 */}
      <span class="status-meta-copy-label">{copyButtonLabel(compact)}</span>
      <span class="status-meta-copy-mark" aria-hidden="true">
        ✓
      </span>
    </button>
  );
}
