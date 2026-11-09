/** @jsxImportSource preact */
// クリップボードへのコピーのボタン (StatusPanel のメタ情報 TITLE / CWD /
// SESSION_ID / PID / ...、値の左に置く小さな四角)。成功時の見え方 (1.5 秒だけ ✓ が出る) は、コードに
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
      {/* 2 枚の紙の絵は成功時も置いたまま (見えなくするだけ) で、✓ はその上に
       * 重ねる — 中身を差し替えるとボタンの寸法が動き、隣の値や行まで動く
       * (kawaz r259m4「押した瞬間に画面が崩れる」)。ボタンが読み上げる内容は
       * aria-label 側が持っているので、絵の出し入れは AT には影響しない。 */}
      <svg
        class="status-meta-copy-icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        aria-hidden="true"
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
      </svg>
      <span class="status-meta-copy-mark" aria-hidden="true">
        ✓
      </span>
    </button>
  );
}
