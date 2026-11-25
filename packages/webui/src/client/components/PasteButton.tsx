/** @jsxImportSource preact */
// 本文を書く欄の貼り付けのボタン (📋、DR-0065 §8、kawaz 2026-11-25)。押すと
// クリップボードを読み、中身に合う入れ方の並びを、ボタンの上に重ねて広げる。
// 選んだ入れ方でカーソルの位置 (選択があれば置き換え) に入れる。中身が文字で
// ない (画像・ファイル) なら選ばせずに添付にする。読めない・空・失敗は何もしない。
//
// ボタンも並びも、押して textarea のフォーカス・カーソル・ソフトウェアキーボードを
// 動かさない (compose-focus.ts)。読んだ中身は並びを開いている間だけ持つ。
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { insertAtSelection } from "../paste-html-as-markdown.ts";
import { attachmentSizeLabel, pastedText, type PasteWay } from "../paste-ways.ts";
import { hasMarkdownStructure, parsePastedHtml } from "../pasted-html.ts";
import { keepsFocusOf } from "./compose-focus.ts";
import type { ComposeView } from "./ComposePreview.tsx";

/** 並びを開いている間に持つ、読んだクリップボードの文字。 */
type Offer =
  | { readonly kind: "html"; readonly html: string; readonly plain: string }
  | { readonly kind: "plain"; readonly plain: string };

type ClipboardRead = Offer | { readonly kind: "files"; readonly files: readonly File[] };

type Way = PasteWay | "attachment";

const HTML_WAYS: readonly Way[] = ["plain", "markdown", "attachment"];
const PLAIN_WAYS: readonly Way[] = ["plain", "markdown", "quote", "block", "attachment"];

/** 添付にする文字のファイルの名前。 */
const PASTED_TEXT_NAME = "pasted.txt";

export function PasteButton({
  view,
  onFiles,
  disabled,
}: {
  /** 欄の md | source (md の間は押せない)。textarea はその入れ物の中のもの。 */
  view: ComposeView;
  /** 添付を持つ欄の、ファイルを添付にして `[FILE<N>]` を入れる口。無い欄は添付の
   * 入れ方を出さず、文字でない中身は入れない。 */
  onFiles?: (files: readonly File[]) => void;
  disabled: boolean;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  // 読んでいる間に押し直す・閉じる操作があったら、前の読みの結果は使わない。
  const readCount = useRef(0);
  const { frameRef } = view;
  const field = {
    get current(): HTMLTextAreaElement | null {
      return textareaIn(frameRef.current);
    },
  };
  const keepFocus = keepsFocusOf(field);

  // 並びの外を押す・Esc・欄への入力で、何もせずに閉じる。並びが出た時から
  // 受けるよう、描いた直後 (layout effect) に付ける (描いた後の effect では、
  // 出た直後の Esc がダイアログに届いてダイアログごと閉じる)。
  useLayoutEffect(() => {
    if (offer === null) return;
    const doc = wrapRef.current?.ownerDocument;
    const textarea = textareaIn(frameRef.current);
    if (doc === undefined) return;
    const close = () => setOffer(null);
    const onPointerDown = (event: PointerEvent) => {
      const wrap = wrapRef.current;
      if (wrap === null || !(event.target instanceof Node) || !wrap.contains(event.target)) {
        close();
      }
    };
    // 欄の Esc (コメントのフォームやダイアログを閉じる) より先に受け、並びだけを閉じる。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    textarea?.addEventListener("input", close);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      textarea?.removeEventListener("input", close);
    };
  }, [offer, frameRef]);

  const press = () => {
    const count = ++readCount.current;
    if (offer !== null) {
      setOffer(null);
      return;
    }
    void readClipboard().then((read) => {
      if (count !== readCount.current || read === null) return;
      if (read.kind === "files") onFiles?.(read.files);
      else setOffer(read);
    });
  };

  const choose = (way: Way, chosen: Offer) => {
    readCount.current++;
    setOffer(null);
    if (way === "attachment") {
      onFiles?.([new File([chosen.plain], PASTED_TEXT_NAME, { type: "text/plain" })]);
      return;
    }
    if (way === "markdown" && chosen.kind === "html") {
      // 部品の読み込みや変換に失敗したら、何も入れず何も出さない。
      void import("../html-to-markdown.ts")
        .then(({ htmlToMarkdown }) => {
          const markdown = htmlToMarkdown(chosen.html);
          if (markdown !== null) insertInto(field.current, way, markdown);
        })
        .catch(() => undefined);
      return;
    }
    insertInto(field.current, way, chosen.plain);
  };

  const ways = offer === null ? [] : offer.kind === "html" ? HTML_WAYS : PLAIN_WAYS;
  return (
    <span class="compose-paste" ref={wrapRef}>
      <button
        type="button"
        class="composer-attach-btn compose-paste-btn"
        aria-label="貼り付け方を選ぶ"
        title="貼り付け方を選ぶ"
        aria-expanded={offer !== null}
        disabled={disabled || !view.source}
        onPointerDown={keepFocus}
        onClick={press}
      >
        <span aria-hidden="true">📋</span>
      </button>
      {offer !== null ? (
        <span class="compose-paste-ways" role="group" aria-label="貼り付け方">
          {ways
            .filter((way) => way !== "attachment" || onFiles !== undefined)
            .map((way) => (
              <button
                key={way}
                type="button"
                class="compose-paste-way"
                onPointerDown={keepFocus}
                onClick={() => choose(way, offer)}
              >
                {way === "attachment" ? `attachment (${attachmentSizeLabel(offer.plain)})` : way}
              </button>
            ))}
        </span>
      ) : null}
    </span>
  );
}

/** 欄の入れ物 (md | source の箱) の中の textarea。 */
function textareaIn(frame: HTMLElement | null): HTMLTextAreaElement | null {
  return frame?.querySelector("textarea") ?? null;
}

/** `text` を `way` の形で `el` の今の選択の位置に入れる。書けない欄には入れない。 */
function insertInto(el: HTMLTextAreaElement | null, way: PasteWay, text: string): void {
  if (el === null || !el.isConnected || el.readOnly || el.disabled) return;
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
  insertAtSelection(el, pastedText(way, text, el.value.slice(0, el.selectionStart)));
}

/** クリップボードの中身。markdown に直す HTML (DR-0065 §2) があれば html、無くて
 * text/plain があれば plain、文字でないものだけなら files。読めない (拒否・未対応・
 * 失敗) か空なら null。 */
async function readClipboard(): Promise<ClipboardRead | null> {
  try {
    let html = "";
    let plain = "";
    const files: File[] = [];
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        if (type === "text/html") html ||= await (await item.getType(type)).text();
        else if (type === "text/plain") plain ||= await (await item.getType(type)).text();
        else if (!type.startsWith("text/")) {
          files.push(new File([await item.getType(type)], pastedName(type), { type }));
        }
      }
    }
    if (html !== "" && hasMarkdownStructure(parsePastedHtml(html))) {
      return { kind: "html", html, plain };
    }
    if (plain !== "") return { kind: "plain", plain };
    return files.length > 0 ? { kind: "files", files } : null;
  } catch {
    return null;
  }
}

/** 文字でない中身を添付にする時のファイルの名前 (`image/png` → `pasted.png`)。
 * 添付の拡張子は名前から取られる。 */
function pastedName(type: string): string {
  const subtype = /^[^/]+\/([a-z0-9.-]+)/i.exec(type)?.[1];
  return subtype === undefined ? "pasted" : `pasted.${subtype}`;
}
