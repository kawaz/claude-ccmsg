/** @jsxImportSource preact */
// kawaz r26 mid=49: 添付画像プレビューを target="_blank" で新タブに開くと、
// standalone PWA (webui をホーム画面に置いた SPA 起動) では戻る/閉じる/
// アドレスバーが無く画像から脱出できずアプリ強制終了しか無くなる。
// → in-app の lightbox overlay に置き換える。閉じる経路は 3 つ:
//   背景タップ / × ボタン / Esc キー。
import { useEffect } from "preact/hooks";

/** Module-level open function set by the singleton <ImageLightboxHost>.
 * Callers (markdown-view の <img> リンク等) は component 階層に依存せず
 * openImageLightbox(url) するだけでよい — overlay は App 直下の Host が
 * 1 個だけ描画する (多重 mount しても最後の Host が勝つ)。 */
let openFn: ((url: string, alt?: string) => void) | null = null;

export function openImageLightbox(url: string, alt?: string): void {
  openFn?.(url, alt);
}

import { useState } from "preact/hooks";

export function ImageLightboxHost() {
  const [img, setImg] = useState<{ url: string; alt?: string } | null>(null);

  useEffect(() => {
    openFn = (url, alt) => setImg({ url, alt });
    return () => {
      if (openFn !== null) openFn = null;
    };
  }, []);

  // Esc で閉じる (デスクトップ / キーボード接続時)
  useEffect(() => {
    if (!img) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImg(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [img]);

  if (!img) return null;
  return (
    <div
      class="image-lightbox"
      role="dialog"
      aria-label="画像プレビュー"
      onClick={() => setImg(null)}
    >
      <button
        type="button"
        class="image-lightbox-close"
        aria-label="閉じる"
        onClick={() => setImg(null)}
      >
        ×
      </button>
      {/* 画像自体のタップでも閉じる (stopPropagation しない) — 「どこを
       * 押しても戻れる」を最優先。pinch zoom したい場合は長押しから OS の
       * プレビューが使える。 */}
      <img class="image-lightbox-img" src={img.url} alt={img.alt ?? ""} />
    </div>
  );
}
