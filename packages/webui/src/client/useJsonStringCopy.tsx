/** @jsxImportSource preact */
// Shiki トークン (`.shiki-tok`) のうち JSON 文字列リテラルのものに、
// 「parse 後の生文字列をコピーする」ボタンを重ねる hook。
// FileViewer (JSON プレビュー) と CodeBlock (markdown fence) の両方が使う。
//
// トークンは 1 ファイルで数万個描画されうるので、**トークンごとにボタン要素を
// 作らない**。ホスト要素 1 つに mouseover / click を委譲し、単一のボタンを
// 対象トークンの位置へ動かす (DOM サイズと mount コストを一定に保つ)。
//
// 配置は CSS Anchor Positioning ではなく getBoundingClientRect + absolute。
// anchor positioning は anchor 側 (= トークン) に `anchor-name` を持たせる
// 必要があり、単一ボタン方式だと結局ホバーの度にトークンへ inline style を
// 書き込むことになる (= DOM 変更コストは rect 方式と変わらず、Safari の
// 対応状況というリスクだけ増える)。ボタンは position: relative なホストの
// 内側に置くので、スクロールしてもトークンと一緒に動く (再計算不要)。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { parseJsonStringToken } from "./json-string-token.ts";

type Anchor = {
  value: string;
  left: number;
  top: number;
  /** クランプ済み (= 実測サイズでの再配置を 1 度だけ行うためのフラグ)。 */
  placed: boolean;
};

/** イベント発生元から、コピー対象になる `.shiki-tok` を探す。 */
function closestStringToken(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const tok = target.closest(".shiki-tok");
  if (!(tok instanceof HTMLElement)) return null;
  return parseJsonStringToken(tok.textContent) === null ? null : tok;
}

/**
 * ホスト要素に spread する props と、その中に描画するボタンを返す。
 *
 * ```tsx
 * const { hostProps, overlay } = useJsonStringCopy();
 * return <pre class="md-code" {...hostProps}>{...}{overlay}</pre>;
 * ```
 */
export function useJsonStringCopy(): {
  hostProps: JSX.HTMLAttributes<HTMLPreElement>;
  overlay: JSX.Element | null;
} {
  const hostRef = useRef<HTMLPreElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const showFor = useCallback((tok: HTMLElement, value: string) => {
    const host = hostRef.current;
    if (!host) return;
    const tokRect = tok.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    // ホストの padding box 基準へ変換 (clientLeft/Top = border 幅)。
    // scrollLeft/Top を足すことで「内容に対する座標」になり、以後の
    // スクロールでもボタンがトークンに追従する。
    setAnchor({
      value,
      left: tokRect.right - hostRect.left - host.clientLeft + host.scrollLeft,
      top: tokRect.top - hostRect.top - host.clientTop + host.scrollTop,
      placed: false,
    });
    setCopied(false);
  }, []);

  // 1 行目 / 左端のトークンでは、右上へ寄せたボタンがホストの内容領域から
  // はみ出してクリップされる (実測: 最上行のトークンでボタンが見えず押せない)。
  // 実測サイズが要るのでマウント後に一度だけ内側へ押し戻す。
  useLayoutEffect(() => {
    const btn = buttonRef.current;
    if (!btn || !anchor || anchor.placed) return;
    const width = btn.offsetWidth;
    const height = btn.offsetHeight;
    const left = Math.max(anchor.left, width);
    const top = Math.max(anchor.top, height);
    if (left === anchor.left && top === anchor.top) {
      setAnchor({ ...anchor, placed: true });
      return;
    }
    setAnchor({ ...anchor, left, top, placed: true });
  }, [anchor]);

  const onMouseOver = useCallback(
    (e: JSX.TargetedMouseEvent<HTMLPreElement>) => {
      // ボタン自身の上に来た時に消さない (クリックできなくなるため)。
      if (buttonRef.current && e.target instanceof Node && buttonRef.current.contains(e.target)) {
        return;
      }
      const tok = closestStringToken(e.target);
      if (!tok) {
        setAnchor(null);
        return;
      }
      showFor(tok, parseJsonStringToken(tok.textContent) as string);
    },
    [showFor],
  );

  // ホストから出たら畳む。トークン以外へ移った場合は onMouseOver 側が消す。
  const onMouseLeave = useCallback(() => setAnchor(null), []);

  // ポインタを持たない環境 / タップ操作向け。クリックでも同じボタンを出す。
  const onClick = useCallback(
    (e: JSX.TargetedMouseEvent<HTMLPreElement>) => {
      if (buttonRef.current && e.target instanceof Node && buttonRef.current.contains(e.target)) {
        return;
      }
      const tok = closestStringToken(e.target);
      if (tok) showFor(tok, parseJsonStringToken(tok.textContent) as string);
    },
    [showFor],
  );

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard 不可 (非セキュアコンテキスト / 権限拒否) — 成功表示を
      // 出さないことで失敗を伝える (SessionList.tsx と同じ流儀)。
      setCopied(false);
    }
  }

  const overlay = anchor ? (
    <button
      type="button"
      ref={buttonRef}
      class={"json-copy-btn" + (copied ? " copied" : "")}
      style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
      title="文字列の値をコピー (JSON エスケープを解除)"
      aria-label="文字列の値をコピー"
      onClick={(e) => {
        e.stopPropagation();
        void copy(anchor.value);
      }}
    >
      {copied ? "✓" : "コピー"}
    </button>
  ) : null;

  return {
    hostProps: { ref: hostRef, onMouseOver, onMouseLeave, onClick },
    overlay,
  };
}
