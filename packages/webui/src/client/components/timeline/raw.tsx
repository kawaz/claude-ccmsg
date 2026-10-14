// 項目ごとの jsonl トグルと、元の JSONL 行の表示 (raw / pretty)。
import { type ComponentChildren } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import { truncateRawLine, type RawTranscriptRow } from "../../transcript-model.ts";
import {
  canPrettyRawLine,
  prettyRawLine,
  setRawViewPretty,
  useRawViewPretty,
  RAW_PRETTY_MAX_CHARS,
} from "../../raw-view-mode.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { ItemRawContext } from "./context.ts";

/** raw / pretty の切替タブ (kawaz r76 m91)。raw 展開のすぐ上に出す (全体 raw
 * ビューの先頭、項目トグルなら展開した行の直前)。設定は raw-view-mode.ts の
 * グローバル store — 全体ビューと項目トグル、複数ペインの Timeline が同じ
 * 1 つの値を見る。`disabled` は「この場に整形できる行が 1 つも無い」場合 —
 * 押しても何も変わらないボタンを生かしておかない。 */
function RawModeTabs({
  disabled = false,
  disabledReason,
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const pretty = useRawViewPretty();
  const setPretty = setRawViewPretty;
  return (
    <div class="tl-raw-mode">
      <button
        type="button"
        class={"tl-thinking-tab" + (pretty ? "" : " active")}
        aria-pressed={!pretty}
        onClick={() => setPretty(false)}
        title="JSONL の行をそのまま表示"
      >
        raw
      </button>
      <button
        type="button"
        class={"tl-thinking-tab" + (pretty ? " active" : "")}
        aria-pressed={pretty}
        disabled={disabled}
        onClick={() => setPretty(true)}
        title={disabled ? disabledReason : "JSON として整形して表示"}
      >
        pretty
      </button>
    </div>
  );
}

/**
 * Wraps one rendered timeline item with a `raw` toggle that swaps it for the
 * verbatim jsonl line(s) it came from. Layout-neutral by construction: the
 * wrapper is a column flex box just like the two containers items live in
 * (`.tl-lines` and `.tl-guided-content`), so a bubble's own `align-self`
 * still decides which side it sits on.
 */
export function ItemRawToggle({
  offset,
  uuid,
  selectedPosition = false,
  onSelectPosition,
  children,
}: {
  offset: number;
  uuid?: string;
  selectedPosition?: boolean;
  onSelectPosition?: (uuid: string) => void;
  children: ComponentChildren;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <div
      class={`tl-item${raw ? " tl-item-raw-on" : ""}${selectedPosition ? " tl-position-selected" : ""}`}
      data-timeline-uuid={uuid}
      onClick={(event) => {
        if (!uuid || !onSelectPosition) return;
        const { target } = event;
        if (!(target instanceof Element)) return;
        if (target.closest("a, button, input, textarea, select, summary")) return;
        onSelectPosition(uuid);
      }}
    >
      {/* ラベルが "raw" ではなく "jsonl" なのは、ccmsg 吹き出し / システム
       * メッセージが本文内に持つ msg|raw タブとの衝突を避けるため — あちらの
       * "raw" は「rich パースを通さない本文テキスト」、こちらは「この項目の
       * 元になった JSONL 行そのもの」で別物。 */}
      <button
        type="button"
        class="tl-item-raw-toggle"
        aria-pressed={raw}
        title={raw ? "この項目をリッチ表示に戻す" : "この項目の元 JSONL 行を表示"}
        onClick={() => setRaw((v) => !v)}
      >
        jsonl
      </button>
      {raw ? <ItemRawRows offset={offset} /> : children}
    </div>
  );
}

/** The jsonl lines one item was built from, shown in place of the item while
 * its `jsonl` toggle is on. */
function ItemRawRows({ offset }: { offset: number }) {
  const lookup = useContext(ItemRawContext);
  const rows = (lookup?.sources.get(offset) ?? [])
    .map((o) => lookup?.rows.get(o))
    .filter((row): row is RawTranscriptRow => row !== undefined);
  // 対応する行が引けない = 表示の元になった行がキャッシュ外 (load older 前)
  // — rich 表示に戻す以外にできることがないのでその旨だけ出す。
  if (rows.length === 0) return <p class="tl-empty">(この項目の元 JSONL 行は読み込み範囲外)</p>;
  // この項目の行が 1 つも整形できないなら pretty を選ばせない (押しても
  // 全行が raw に落ちるだけ)。項目あたり数行なので毎 render の判定で足りる。
  const anyPretty = rows.some((row) => canPrettyRawLine(row.text));
  return (
    <>
      <RawModeTabs
        disabled={!anyPretty}
        disabledReason="この項目の JSONL 行は JSON として整形できません"
      />
      {rows.map((row) => (
        <RawLineRow key={row.offset} row={row} />
      ))}
    </>
  );
}

/** One line of the raw view: its cache position and absolute byte offset in
 * the gutter, the verbatim jsonl text beside it. Long lines (pasted images,
 * big tool results) render truncated behind a per-row expander so switching
 * into the raw view never has to lay out megabytes at once. */
function RawLineRow({ row }: { row: RawTranscriptRow }) {
  const [expanded, setExpanded] = useState(false);
  const pretty = useRawViewPretty();
  // 整形は選択中のときだけ (巨大行の JSON.parse を raw 表示のたびに走らせ
  // ない)。失敗しても表示を止めず raw に落として理由だけ添える — 壊れた行を
  // そのまま読めることが raw ビューの存在理由なので、整形不能は例外ではなく
  // 通常の分岐。
  const prettied = useMemo(() => (pretty ? prettyRawLine(row.text) : null), [pretty, row.text]);
  const text = prettied?.ok ? prettied.text : row.text;
  const preview = useMemo(() => truncateRawLine(text), [text]);
  const shown = expanded ? text : preview.text;
  return (
    <div class="tl-raw-row">
      <div class="tl-raw-gutter">
        <span class="tl-raw-index">{row.index}</span>
        {/* 生 JSONL の各行を rich 表示側のバブルと突き合わせるための座標 —
         * rich 側の Preact key と同じ絶対 byte offset (lineByteOffsets)。 */}
        <span class="tl-raw-offset" title={`byte offset ${row.offset} / ${row.bytes} bytes`}>
          @{row.offset}
        </span>
      </div>
      <div class="tl-raw-line">
        {prettied && !prettied.ok ? (
          <p class="tl-raw-note">
            {prettied.reason === "too-large"
              ? `(${row.text.length.toLocaleString()} 文字 — 整形の上限 ${RAW_PRETTY_MAX_CHARS.toLocaleString()} 文字を超えるため raw 表示)`
              : "(JSON として解釈できない行 — raw 表示)"}
          </p>
        ) : null}
        {prettied?.ok ? (
          // 装飾は FileViewer / markdown の fence と同じ Shiki パイプライン
          // (CodeBlock -> highlight.ts) をそのまま使う。json 文法は既に
          // バンドル済みで、トークナイズ失敗時の plain fallback も込み。
          <CodeBlock code={shown} lang="json" />
        ) : (
          <pre class="tl-fold-body tl-raw-text">{shown}</pre>
        )}
        {preview.truncated ? (
          <button type="button" class="tl-raw-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "省略表示に戻す" : `… 残り ${text.length - preview.text.length} 文字を表示`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
