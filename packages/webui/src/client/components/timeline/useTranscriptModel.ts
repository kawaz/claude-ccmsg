// 読み込み済みの transcript の行から、Timeline が描くもの (行の parse、byte
// offset、tools folding の group、境界の分類、ccmsg バブルの重複除去、項目
// ごとの元 jsonl) を導く。live tail は行を 1 本ずつ足すので、行ごとの結果と
// 変わらなかった group の identity を前回から引き継ぎ、追記のたびに窓全体を
// 作り直さない。
import { useMemo, useRef } from "preact/hooks";
import { crossLineIncrementally, emptyCrossLineCache } from "../../incremental-cross-line.ts";
import { emptyLineMapCache, mapLinesIncrementally } from "../../incremental-line-map.ts";
import type { TimelineState } from "../../store.ts";
import {
  ccmsgRenderTargets,
  classifyBoundaryLine,
  itemRawSourceOffsets,
  parseTranscriptLine,
  rawTranscriptRowsFrom,
  utf8ByteLength,
  type ParsedLine,
  type RawTranscriptRow,
  type TimelineGroup,
} from "../../transcript-model.ts";

/**
 * Per-item raw JSONL lookup (kawaz r55 m89: 「個別に raw モードトグルが
 * 欲しい。そのアイテムが raw jsonl 用ビューコンポーネントとトグルされる
 * イメージ」). Keyed by the item's byte offset — the same key the rich view
 * already uses — and returning every jsonl line that item was built from
 * (`itemRawSourceOffsets`: normally the item's own line, plus the merged
 * tool_result line for a tool card). Threaded as context rather than as a
 * prop because the toggle sits on items several levels down the
 * FoldGroup/LineView chain, and every one of them would
 * otherwise have to forward it unchanged.
 *
 * The tables are rebuilt on every live-tail append, so the value changes with
 * them. Only `ItemRawRows` reads it, and that is mounted just for the items
 * toggled to jsonl — an append re-renders those, not every timeline item.
 */
export interface ItemRawLookup {
  /** item offset -> offsets of every jsonl line the item was built from */
  sources: ReadonlyMap<number, readonly number[]>;
  rows: ReadonlyMap<number, RawTranscriptRow>;
}

export interface TranscriptModel {
  parsed: readonly ParsedLine[];
  /** 行ごとの絶対 byte offset。"load older" で前に足しても変わらないので
   * Preact の key に使える (transcript-model.ts の lineByteOffsets)。 */
  offsets: readonly number[];
  /** tools folding (kawaz spec): 境界の行 (ユーザの発話 / assistant の最終
   * 応答) は単独の entry、その間はまとめて 1 つの fold group。 */
  groups: readonly TimelineGroup[];
  /** `groups` と同じ index の境界の分類 (entry 以外は null)。 */
  boundaries: ReadonlyArray<ReturnType<typeof classifyBoundaryLine> | null>;
  /** 描画する ccmsg バブルの一覧 (同じ event の重複は除いてある)。 */
  ccmsgTargets: ReturnType<typeof ccmsgRenderTargets>;
  /** `ccmsgTargets` の key 集合。顔ぶれが変わらない間は同じ Set を返す。 */
  visibleCcmsgKeys: ReadonlySet<string>;
  itemRawLookup: ItemRawLookup;
}

export function useTranscriptModel(
  timeline: Pick<TimelineState, "lines" | "start">,
): TranscriptModel {
  // Per-line derivations (JSON parse, UTF-8 size) are memoized per *line*,
  // not per lines-array: the store hands us a new array for every live-tail
  // push, and re-deriving the whole window meant re-parsing the entire
  // transcript once per appended line. See incremental-line-map.ts.
  const parseCacheRef = useRef(emptyLineMapCache<ParsedLine>());
  const byteLengthCacheRef = useRef(emptyLineMapCache<number>());
  const perLine = useMemo(() => {
    parseCacheRef.current = mapLinesIncrementally(
      parseCacheRef.current,
      timeline.lines,
      parseTranscriptLine,
    );
    return parseCacheRef.current.values;
  }, [timeline.lines]);
  const byteLengths = useMemo(() => {
    byteLengthCacheRef.current = mapLinesIncrementally(
      byteLengthCacheRef.current,
      timeline.lines,
      utf8ByteLength,
    );
    return byteLengthCacheRef.current.values;
  }, [timeline.lines]);
  // The passes that need the whole window (queue-operation pairing,
  // tool_use/tool_result joining, tools folding) run over the per-line results
  // — they read neighbouring lines, so they can't be folded into the per-line
  // cache. They stay whole-window here too; what is incremental is the
  // *identity* of their output, so a live-tail append leaves the FoldGroup of
  // every untouched group holding the same `entries` array as before and
  // Preact can skip it. See incremental-cross-line.ts.
  const crossLineCacheRef = useRef(emptyCrossLineCache());
  const { parsed, offsets, groups } = useMemo(() => {
    crossLineCacheRef.current = crossLineIncrementally(crossLineCacheRef.current, {
      start: timeline.start,
      raws: timeline.lines,
      perLine,
      byteLengths,
    });
    return crossLineCacheRef.current;
  }, [timeline.start, timeline.lines, perLine, byteLengths]);
  // groups.map (render 本体) が毎レンダー classifyBoundaryLine を呼び直すのを
  // 避けるため、groups が変わった時だけ計算しメモ化する (index を groups と
  // 揃え、entry 以外は使わないので null のまま)。
  const boundaries = useMemo(
    () =>
      groups.map((g) =>
        g.kind === "entry" && g.line.kind === "turn" ? classifyBoundaryLine(g.line) : null,
      ),
    [groups],
  );

  // 同一 ccmsg event (room + ts + from、DR-0027 以降は room + mid) が transcript
  // の複数箇所から抽出される場合 (queue-operation enqueue と task-notification
  // 経由の Monitor tool_result 両方に載っているケース、kawaz r15 mid=21) の
  // 二重表示を避ける。**どれを描画するかは分類フェーズで確定**させ、render は
  // key の在否を読むだけにする — boundary 側と fold-group 側
  // (CcmsgRenderContext 経由の PeerCcmsgLineView) は別コンポーネントなので、
  // render 中に共有 Set を mutate すると fold の開閉のような子局所 re-render で
  // 判定が変わってしまう。
  const ccmsgTargets = useMemo(() => ccmsgRenderTargets(groups), [groups]);
  // Carried over whenever the set of visible bubbles is unchanged: this rides
  // in a context value, so a fresh Set per appended line would re-render every
  // ccmsg bubble on the page even though nothing about them moved.
  const visibleCcmsgKeysRef = useRef<ReadonlySet<string>>(new Set());
  const visibleCcmsgKeys = useMemo(() => {
    const next = new Set(ccmsgTargets.map((target) => target.key));
    const previous = visibleCcmsgKeysRef.current;
    if (previous.size === next.size && [...next].every((key) => previous.has(key))) return previous;
    visibleCcmsgKeysRef.current = next;
    return next;
  }, [ccmsgTargets]);

  // 生 JSONL の行 + その絶対 byte offset。rich 側の Preact key と同じ offset
  // 由来なので、raw の行と rich のバブルを突き合わせられる。項目ごとの
  // jsonl トグル (kawaz r55 m89) が「どの項目が展開されるか事前に判らない」
  // ため常に必要。行テキストは `timeline.lines` を指すだけなのでコピーは
  // 発生しない。データは rich と同じ `timeline.lines` — daemon への追加取得
  // なし。
  const rawRows = useMemo(
    () => rawTranscriptRowsFrom(timeline.lines, offsets, byteLengths),
    [timeline.lines, offsets, byteLengths],
  );
  const rawRowByOffset = useMemo(() => {
    const map = new Map<number, RawTranscriptRow>();
    for (const row of rawRows) map.set(row.offset, row);
    return map;
  }, [rawRows]);
  const itemRawSources = useMemo(() => itemRawSourceOffsets(parsed, offsets), [parsed, offsets]);
  const itemRawLookup = useMemo<ItemRawLookup>(
    () => ({ sources: itemRawSources, rows: rawRowByOffset }),
    [itemRawSources, rawRowByOffset],
  );

  return { parsed, offsets, groups, boundaries, ccmsgTargets, visibleCcmsgKeys, itemRawLookup };
}
