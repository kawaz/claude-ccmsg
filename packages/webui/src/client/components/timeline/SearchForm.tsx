// 🔍 のフィルタの画面の上に置く検索のフォーム (DR-0022 §2)。TL のツールバーには
// 🔍 のアイコンだけを置き、検索語の入力・照合のモード・検索対象・検索語の札・
// 一致の数はここで見せる。検索語と照合のモードは store の timelineSearch
// (Session Search から引き継がれ、TL のハイライトにも効く) で、ここは描くだけ。
import type { SearchWord } from "../../in-view-search.ts";
import { SearchModeToggles, SearchTargetToggles, type SearchBarTargets } from "../SearchBar.tsx";

export function SearchForm({
  hidden,
  words,
  queryText,
  onQueryChange,
  caseSensitive,
  onToggleCaseSensitive,
  regexMode,
  onToggleRegex,
  hasError,
  targets,
  hitCount,
  olderButton,
}: {
  /** 🔍 のフィルタの無い間は同じ要素を隠す (フィルタの切り替えで作り直さない)。 */
  hidden: boolean;
  words: readonly SearchWord[];
  queryText: string;
  onQueryChange: (text: string) => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  regexMode: boolean;
  onToggleRegex: () => void;
  hasError: boolean;
  targets: SearchBarTargets;
  /** 一致した項目の数 (読み込み済みの範囲)。 */
  hitCount: number;
  /** 「過去分を読む」(読み込み済みの範囲が transcript の先頭からなら無い)。 */
  olderButton: { label: string; disabled: boolean; onPress: () => void } | null;
}) {
  return (
    <div class="tl-search-form" hidden={hidden}>
      <textarea
        class="search-bar-query tl-search-form-query"
        aria-label={
          regexMode
            ? "検索正規表現 (1 行 1 パターン、改行区切り OR)"
            : "検索ワード (空白区切り AND、改行区切り OR)"
        }
        placeholder={
          regexMode
            ? "正規表現\n1 行 1 パターン・改行で OR"
            : '検索ワード\n空白で AND・改行で OR・"引用句"'
        }
        value={queryText}
        onInput={(e) => onQueryChange(e.currentTarget.value)}
      />
      <div class="tl-search-form-row">
        <SearchModeToggles
          caseSensitive={caseSensitive}
          onToggleCaseSensitive={onToggleCaseSensitive}
          regexMode={regexMode}
          onToggleRegex={onToggleRegex}
        />
        <SearchTargetToggles
          user={targets.user}
          onToggleUser={targets.onToggleUser}
          ai={targets.ai}
          onToggleAI={targets.onToggleAI}
          ccmsg={targets.ccmsg}
          onToggleCcmsg={targets.onToggleCcmsg}
        />
        {hasError ? <span class="search-bar-error">正規表現エラー</span> : null}
        <span class="tl-search-form-count">
          {words.length === 0 ? "" : `一致 ${hitCount} 項目 (読み込み済みの範囲)`}
        </span>
      </div>
      {words.length === 0 ? null : (
        <div class="search-bar-chips tl-search-form-chips">
          {words.map((w, i) => (
            <span
              key={i}
              class={"search-bar-chip" + (w.error ? " search-bar-chip-error" : "")}
              style={
                w.error ? undefined : { "--chip-color": `var(--search-color-${w.colorIndex + 1})` }
              }
              title={w.error ?? undefined}
            >
              {w.text}
            </span>
          ))}
        </div>
      )}
      {olderButton === null ? null : (
        <button
          type="button"
          class="tl-wide-button tl-search-older"
          disabled={olderButton.disabled}
          onClick={olderButton.onPress}
        >
          {olderButton.label}
        </button>
      )}
    </div>
  );
}
