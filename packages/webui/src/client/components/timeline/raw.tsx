// 項目ごとの jsonl トグルと、元の JSONL 行の表示 (raw / pretty)。
import { type ComponentChildren } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { truncateRawLine, type RawTranscriptRow } from "../../transcript-model.ts";
import {
  canPrettyRawLine,
  prettyRawLine,
  setRawViewPretty,
  useRawViewPretty,
  RAW_PRETTY_MAX_CHARS,
} from "../../raw-view-mode.ts";
import { CodeBlock } from "../CodeBlock.tsx";
import { CopyablePreText } from "../CodeCopyFrame.tsx";
import { ItemRawContext, ItemRawToggleContext, type ItemRawToggleState } from "./context.ts";
import type { TimelineFilter } from "../../locator.ts";
import { BookmarkStar, useBookmarked } from "./bookmark.tsx";

/** raw / pretty の切替タブ (kawaz r76 m91)。raw 展開のすぐ上に出す (全体 raw
 * ビューの先頭、項目トグルなら展開した行の直前)。設定は raw-view-mode.ts の
 * グローバル store — 全体ビューと項目トグル、複数ペインの Timeline が同じ
 * 1 つの値を見る。`disabled` は「この場に整形できる行が 1 つも無い」場合 —
 * 押しても何も変わらないボタンを生かしておかない。 */
function RawModeTabs({
  disabled = false,
  disabledReason,
  children,
}: {
  disabled?: boolean;
  disabledReason?: string;
  /** Put after the tabs on their row (where the item's lines sit in the file). */
  children?: ComponentChildren;
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
      {children}
    </div>
  );
}

/** A click on an item selects its position, unless it landed on something
 * that acts on its own (a link, a button, a field, a fold's summary). */
function selectPositionOnClick(
  uuid: string | undefined,
  onSelectPosition: ((uuid: string) => void) | undefined,
): (event: MouseEvent) => void {
  return (event) => {
    if (!uuid || !onSelectPosition) return;
    const { target } = event;
    if (!(target instanceof Element)) return;
    if (target.closest("a, button, input, textarea, select, summary")) return;
    onSelectPosition(uuid);
  };
}

/** The `jsonl` toggle of one item. The label is "jsonl" rather than "raw"
 * because a ccmsg bubble and a system message carry a msg|raw tab of their
 * own: theirs is the body text without the rich parse, this is the JSONL line
 * the item was made from. */
export function ItemRawToggleButton({
  raw,
  onToggle,
  class: className,
}: {
  raw: boolean;
  onToggle: () => void;
  /** Classes beside `tl-item-raw-toggle` (the bubble footer's tab look). */
  class?: string;
}) {
  return (
    <button
      type="button"
      class={className === undefined ? "tl-item-raw-toggle" : `tl-item-raw-toggle ${className}`}
      aria-pressed={raw}
      title={raw ? "この項目をリッチ表示に戻す" : "この項目の元 JSONL 行を表示"}
      onClick={onToggle}
    >
      jsonl
    </button>
  );
}

/** The jsonl lines of the item at `offset`, as the toggle shows them. */
export function ItemRawView({ offset }: { offset: number }) {
  return (
    <div class="tl-raw-view">
      <ItemRawRows offset={offset} />
    </div>
  );
}

/**
 * Wraps one rendered timeline item with a `jsonl` toggle that swaps its body
 * for the verbatim jsonl line(s) it came from. The item stays mounted while
 * the toggle is on: its fold's summary (`▼ mode`) keeps its place and only
 * what is under it changes (app.css hides the rest), and turning the toggle
 * off brings back the item as it was, open folds included. An item with no
 * summary (a tool card, a say) is hidden whole. Layout-neutral by
 * construction: the wrapper is a column flex box that spans the width of the
 * container the item lives in (`.tl-lines`, a one-column grid, or
 * `.tl-guided-content`, a column flex box), so a bubble's own `align-self`
 * decides which side it sits on.
 *
 * A bubble-shaped item (`bubble`: a `.tl-bubble` with a BubbleFooter) keeps
 * the toggle in the bubble's footer row instead of over the item's top right
 * corner, where it covered the bubble (a user's bubble sits at the right): the
 * item hands the state down (ItemRawToggleContext) and the bubble's footer
 * draws the toggle and the lines, which take the place of the bubble's body.
 *
 * Every item carries the ☆ / ⭐ of its bookmark (DR-0058, BookmarkStar), after
 * the item's content: the star of a bubble stands over the bubble's top right
 * corner by anchor positioning, which takes the last bubble before it in the
 * document. An item with a uuid (a position) can be bookmarked; one without
 * (a fold's rows) shows the star disabled.
 */
export function ItemRawToggle({
  offset,
  uuid,
  selectedPosition = false,
  onSelectPosition,
  notif,
  bubble = false,
  children,
}: {
  offset: number;
  uuid?: string;
  selectedPosition?: boolean;
  onSelectPosition?: (uuid: string) => void;
  /** The badge kind this item answers to (DR-0050 §5): it stays shown while
   * the Timeline is filtered to that kind. */
  notif?: TimelineFilter;
  /** The item is a bubble whose footer row carries the toggle. */
  bubble?: boolean;
  children: ComponentChildren;
}) {
  const [raw, setRaw] = useState(false);
  const bookmarked = useBookmarked(uuid);
  const toggle = useCallback(() => setRaw((v) => !v), []);
  // Memoized: a context value is the one prop memo can't intercept, so a new
  // object per Timeline render would re-render every memoized bubble.
  const footerState = useMemo<ItemRawToggleState | null>(
    () => (bubble ? { raw, toggle, offset } : null),
    [bubble, raw, toggle, offset],
  );
  return (
    <div
      class={`tl-item${bubble ? " tl-item-bubble" : ""}${raw ? " tl-item-raw-on" : ""}${selectedPosition ? " tl-position-selected" : ""}`}
      data-timeline-uuid={uuid}
      data-notif={notif}
      data-bookmarked={bookmarked ? "" : undefined}
      data-activatable={uuid !== undefined && onSelectPosition !== undefined ? "" : undefined}
      onClick={selectPositionOnClick(uuid, onSelectPosition)}
    >
      {bubble ? null : <ItemRawToggleButton raw={raw} onToggle={toggle} />}
      <ItemRawToggleContext.Provider value={footerState}>{children}</ItemRawToggleContext.Provider>
      {raw && !bubble ? <ItemRawView offset={offset} /> : null}
      <BookmarkStar uuid={uuid} />
    </div>
  );
}

/** The jsonl lines one item was built from, shown in place of the item's body
 * while its `jsonl` toggle is on. */
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
      {/* 行の位置はすべてタブの横に、ファイル順に並べる (2 行の項目 = tool の
       * 呼び出しと結果を 1 枚にしたカードなら 2 つ)。kawaz: 「[raw] [pretty]
       * L123 @2572835-3540 byte」。 */}
      <RawModeTabs
        disabled={!anyPretty}
        disabledReason="この項目の JSONL 行は JSON として整形できません"
      >
        {rows.map((row) => (
          <RawRowPosition key={row.offset} row={row} />
        ))}
      </RawModeTabs>
      {rows.map((row) => (
        <RawLineRow key={row.offset} row={row} />
      ))}
    </>
  );
}

/** Where a jsonl line sits in the transcript file, as
 * `L<line> @<byte offset>-<bytes> byte`: its 1-based line number (`L?` while
 * it is not known, RawTranscriptRow.line), the byte offset of its first byte
 * — the same number the rich view keys the item by — and its size in bytes.
 * Digits are not grouped, so a number can be pasted as-is into `dd skip=` or
 * `tail -c +`. */
function rawRowPositionText(row: RawTranscriptRow): string {
  return `L${row.line ?? "?"} @${row.offset}-${row.bytes} byte`;
}

function RawRowPosition({ row }: { row: RawTranscriptRow }) {
  return (
    <span
      class="tl-raw-position"
      title={`${row.line !== null ? `${row.line} 行目` : "行番号は不明 (読み込み範囲がファイル先頭から始まっていない)"}、byte offset ${row.offset}、${row.bytes} bytes`}
    >
      {rawRowPositionText(row)}
    </span>
  );
}

/** One line of the raw view: the verbatim jsonl text. Long lines (pasted images,
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
          <CopyablePreText class="tl-fold-body tl-raw-text" text={shown} />
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
