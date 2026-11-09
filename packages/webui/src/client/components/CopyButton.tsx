/** @jsxImportSource preact */
// クリップボードへの「コピー」ボタン (StatusPanel のメタ情報 TITLE / CWD /
// SESSION_ID / PID / ...)。成功時の見え方 (1.5 秒だけ ✓ が出る) は、コードに
// 添えるコピー (CodeCopyFrame) とも揃えたいので、その部分は useClipboardCopy
// として共有する。
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/** 成功マークが出ている時間。値そのものは押した場所に見えたままなので、
 * 「押した」ことが伝わればよく、居座らせる意味はない。 */
const COPIED_MARK_MS = 1500;

/** クリップボードへ書き、成功した時だけ `copied` を COPIED_MARK_MS の間 true
 * にする。コピーを提供するボタン (このファイルの CopyButton と、コードの
 * コードに添える CodeCopyFrame) が成功の見え方を揃えるための共通部分。 */
export function useClipboardCopy(): {
  copied: boolean;
  /** 書けたかを返す (押した場所側の印を出すかの判断に使う)。 */
  copy: (value: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = useCallback(async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 失敗を成功と見分けられない印は出さない (安全でない文脈・権限拒否)。
      setCopied(false);
      return false;
    }
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_MARK_MS);
    return true;
  }, []);

  return { copied, copy };
}

export function CopyButton({
  value,
  label,
}: {
  value: string;
  /** aria-label / title に入る対象名 ("CWD" 等)。ボタン自身の文字ではない。 */
  label: string;
}) {
  const { copied, copy } = useClipboardCopy();

  return (
    <button
      type="button"
      class={"status-meta-copy" + (copied ? " copied" : "")}
      title={`${label} をコピー`}
      aria-label={`${label} をコピー`}
      onClick={() => {
        void copy(value);
      }}
    >
      {/* ラベルは成功時も置いたまま (見えなくするだけ) で、✓ はその上に重ねる
       * — 文字を差し替えると「コピー」と「✓」の幅差でボタンが縮み、隣の値や
       * 行の折り返しまで動く (kawaz r259m4「押した瞬間に画面が崩れる」)。
       * ボタンが読み上げる内容は aria-label 側が持っているので、視覚要素の
       * 出し入れは AT には影響しない。 */}
      <span class="status-meta-copy-label">コピー</span>
      <span class="status-meta-copy-mark" aria-hidden="true">
        ✓
      </span>
    </button>
  );
}
