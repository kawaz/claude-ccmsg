// TL の吹き出しの足元の 1 行 (DR-0049 §8)。どの吹き出しもこの部品で組み、
// 並びは左から「時刻 → 翻訳タブ → 吹き出しごとの付随ボタン」で揃える。
import { type ComponentChildren, type Ref } from "preact";
import { formatMsgTime } from "../../utils.ts";
import { Tabs } from "../Tabs.tsx";
import { type ItemRawToggleState } from "./context.ts";
import { ItemRawToggleButton, ItemRawView } from "./raw.tsx";
import {
  type TranslationAvailability,
  type TranslationTab,
  hasTranslationTabs,
  translationTabItems,
} from "./translation.ts";

/** 足元に出す翻訳タブの材料。タブは使える経路がある時だけ出る。 */
export interface BubbleFooterTranslation {
  availability: TranslationAvailability;
  tab: TranslationTab;
  onSelect: (tab: TranslationTab) => void;
}

/** 吹き出しの形の項目 (ItemRawToggle の `bubble`) は jsonl のトグルを付随ボタンの
 * 右 (ツールバーの最後) に置き、jsonl を出している間は元の行を本文の代わりに
 * 足元の行の上へ出す (本文は app.css が隠す)。
 *
 * タブと付随ボタンは 1 つの hover ツールバー (`tl-msg-toolbar`): 通常は
 * 不可視で、足元を直接持つ要素 (吹き出し / thinking の枠) の hover・focus で
 * 出る。opacity だけで隠すので場所は常に確保され、hover しても行の高さも
 * 時刻の位置も動かない。時刻は常に見える。
 *
 * 中の操作のクリックは吹き出しへ伝えない: 吹き出しのクリックは選択位置に
 * 使われていて、タブを押しただけでそれが動くのは意図と違う。 */
export function BubbleFooter({
  translation,
  ts,
  now,
  timeAtEnd = false,
  open = false,
  footerRef,
  raw,
  children,
}: {
  translation?: BubbleFooterTranslation | undefined;
  /** 省略 (または null) で時刻を出さない — 時刻を別の行 (fold の summary)
   * が持つ吹き出し用。 */
  ts?: string | null | undefined;
  /** 相対時刻の基準 (useNow の tick)。省略時は描画した時点。 */
  now?: number | undefined;
  /** 時刻をツールバーの右 (行の右端) に置く。右寄せの吹き出し用: 行ごと右に
   * 寄るので、時刻が吹き出しの右端に揃う (kawaz: 「ユーザメッセージは右に
   * あるのに時刻が左」)。 */
  timeAtEnd?: boolean;
  /** true の間はツールバーを出したままにする (付随ボタンのメニューを開いて
   * いる間など)。 */
  open?: boolean;
  /** 足元の行全体 (時刻・タブ・付随ボタン) の要素。外側のクリックで閉じる
   * 判定などに使う。 */
  footerRef?: Ref<HTMLDivElement> | undefined;
  /** この吹き出しの項目の jsonl トグル (ItemRawToggleContext)。吹き出しの形の
   * 項目の中でなければ null / 省略。 */
  raw?: ItemRawToggleState | null | undefined;
  /** 翻訳タブの右に並べる、吹き出し種別ごとのボタン。 */
  children?: ComponentChildren;
}) {
  const tabs =
    translation !== undefined && hasTranslationTabs(translation.availability) ? translation : null;
  const hasActions = children !== undefined && children !== null && children !== false;
  const rawToggle = raw ?? null;
  // 何も載らない足元は行ごと出さない (空の行が本文の下に隙間を作る)。
  if (tabs === null && !ts && !hasActions && rawToggle === null) return null;
  const time = ts ? <span class="tl-bubble-time">{formatMsgTime(ts, now)}</span> : null;
  const toolbar =
    tabs === null && !hasActions && rawToggle === null ? null : (
      <div
        class={`tl-msg-toolbar${open || rawToggle?.raw === true ? " tl-msg-toolbar-open" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {tabs === null ? null : (
          <Tabs
            class="tl-thinking-tabs"
            tabClass="tl-thinking-tab"
            label="本文の言語"
            selected={tabs.tab}
            onSelect={tabs.onSelect}
            items={translationTabItems(tabs.availability)}
          />
        )}
        {hasActions ? children : null}
        {rawToggle === null ? null : (
          <ItemRawToggleButton
            raw={rawToggle.raw}
            onToggle={rawToggle.toggle}
            class="tl-thinking-tab"
          />
        )}
      </div>
    );
  return (
    <>
      {rawToggle?.raw === true ? <ItemRawView offset={rawToggle.offset} /> : null}
      <div class="tl-bubble-footer" ref={footerRef}>
        {timeAtEnd ? toolbar : time}
        {timeAtEnd ? time : toolbar}
      </div>
    </>
  );
}
