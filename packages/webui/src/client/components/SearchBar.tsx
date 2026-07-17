// In-view search bar (DR-0022 §2.1) — shared UI shell for both Timeline's
// toolbar and FileViewer's header. Owns only the editor-open/closed local
// state; the query text/toggle values, parsed words, and match count/index
// are all owned by the host component (Timeline.tsx / FileViewer.tsx) since
// each has a different notion of "what counts as a match" (segments vs
// lines) — this component just renders whatever it's handed.
import { useRef, useState } from "preact/hooks";
import { useDismissOnOutsidePointer } from "../useDismissOnOutsidePointer.ts";
import type { SearchWord } from "../in-view-search.ts";

export function SearchModeToggles({
  caseSensitive,
  onToggleCaseSensitive,
  regexMode,
  onToggleRegex,
}: {
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  regexMode: boolean;
  onToggleRegex: () => void;
}) {
  return (
    <div class="search-bar-toggles">
      <button
        type="button"
        class={"search-bar-toggle-btn" + (caseSensitive ? " active" : "")}
        title="Case sensitive"
        aria-pressed={caseSensitive}
        onClick={onToggleCaseSensitive}
      >
        Aa
      </button>
      <button
        type="button"
        class={"search-bar-toggle-btn" + (regexMode ? " active" : "")}
        title="正規表現"
        aria-pressed={regexMode}
        onClick={onToggleRegex}
      >
        .*
      </button>
    </div>
  );
}

export function SearchBar({
  words,
  queryText,
  onQueryChange,
  caseSensitive,
  onToggleCaseSensitive,
  regexMode,
  onToggleRegex,
  matchCount,
  currentIndex,
  onPrev,
  onNext,
  hasError,
}: {
  words: SearchWord[];
  queryText: string;
  onQueryChange: (text: string) => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  regexMode: boolean;
  onToggleRegex: () => void;
  matchCount: number;
  /** 1-based, 0 when matchCount is 0 (DR-0022 §2.2 index space). */
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  hasError: boolean;
}) {
  // Closed by default: DR-0022 §2.1 "入力欄外クリックで入力欄を閉じ、各ワード
  // を別チップで一列表示" — the multiline textarea is only shown while
  // actively editing, collapsing to the chip row the rest of the time.
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsidePointer(containerRef, editing, () => setEditing(false));

  const hasQuery = words.length > 0;

  return (
    <div class="search-bar" ref={containerRef}>
      <button
        type="button"
        class="search-bar-toggle"
        aria-label="検索"
        title="検索"
        aria-pressed={editing}
        onClick={() => setEditing((v) => !v)}
      >
        🔍
      </button>
      {editing ? (
        <div class="search-bar-editor">
          <textarea
            class="search-bar-query"
            aria-label="検索ワード (改行区切りで複数ワード AND)"
            placeholder={"検索ワード\n改行区切りで AND"}
            value={queryText}
            onInput={(e) => onQueryChange((e.target as HTMLTextAreaElement).value)}
          />
          <SearchModeToggles
            caseSensitive={caseSensitive}
            onToggleCaseSensitive={onToggleCaseSensitive}
            regexMode={regexMode}
            onToggleRegex={onToggleRegex}
          />
          {hasError ? <span class="search-bar-error">正規表現エラー</span> : null}
        </div>
      ) : hasQuery ? (
        // "🔍 foo bar [1/20]↑↓" (DR-0022 §2.1 表示イメージ) — chips carry the
        // same per-word color the highlight <mark>s use, via --chip-color,
        // so a chip visually points at "which color to look for".
        <div class="search-bar-chips">
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
          <span class="search-bar-count">
            {matchCount > 0 ? `${currentIndex}/${matchCount}` : "0/0"}
          </span>
          <button type="button" disabled={matchCount === 0} onClick={onPrev} title="前のマッチへ">
            ↑
          </button>
          <button type="button" disabled={matchCount === 0} onClick={onNext} title="次のマッチへ">
            ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}
