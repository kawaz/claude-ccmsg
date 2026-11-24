// A filter box with the words the person keeps for it (DR-0043 §9, kawaz
// 2026-11-24): the SESSIONS quick filter and the Files pane's name search.
// Typing narrows as it goes, as before. ⌘Enter (Ctrl+Enter), or the save pill
// inside the box, keeps the word; the kept words sit under the box as pills,
// and pressing one puts it in the box (the box's own way in, so it narrows at
// once) while its × takes it off the list and leaves the box as it is. A
// pill shows the word's first characters (savedFilterLabel); its title and
// its buttons' names carry the whole word.
//
// The box draws its own × rather than the browser's: the save pill sits left
// of the ×, and nothing outside an input can be placed against the browser's
// × (it is drawn inside the input, at a width each engine picks).
//
// The box's controls leave the input's focus where it is (compose-focus.ts),
// so pressing one while typing does not put a phone's keyboard away. A press
// from the keyboard on a control that goes away with it (the save pill, the
// ×s) gives the focus to the input, rather than to nothing.
import { useCallback, useRef } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
import { keepsFocusOf } from "./compose-focus.ts";
import {
  canSaveFilter,
  removeSavedFilter,
  saveFilter,
  savedFilters,
  savedFilterLabel,
  savedFilterWord,
  type SavedFiltersId,
  subscribeSavedFilters,
} from "../saved-filters.ts";

const NO_WORDS: readonly string[] = [];
const UNSUBSCRIBE_NOTHING = (): void => {};

export function FilterField({
  value,
  onChange,
  savedId,
  inputClass,
  placeholder,
  label,
  verb,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Which list of kept words the box has; null for none (no save, no kept
   * words), as for a Files pane whose session has no repository or cwd. */
  savedId: SavedFiltersId | null;
  inputClass: string;
  placeholder: string;
  /** The input's accessible name. */
  label: string;
  /** What pressing a kept word does to it, for the word's accessible name
   * (`<word> で絞り込む`). */
  verb: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const keepFocus = keepsFocusOf(inputRef);
  const subscribe = useCallback(
    (listener: () => void) =>
      savedId === null ? UNSUBSCRIBE_NOTHING : subscribeSavedFilters(savedId, listener),
    [savedId],
  );
  const saved = useSyncExternalStore(subscribe, () =>
    savedId === null ? NO_WORDS : savedFilters(savedId),
  );
  // The list the box's word would go to: none when the box has no list, or
  // its word is empty or kept already.
  const saveTo = savedId !== null && canSaveFilter(saved, value) ? savedId : null;
  const current = savedFilterWord(value);

  /** After a press from the keyboard on a control that the press takes away,
   * the focus goes to the input. A press from a pointer has `detail` ≥ 1. */
  const refocusAfterKeyPress = (event: MouseEvent) => {
    if (event.detail === 0) inputRef.current?.focus();
  };

  return (
    <>
      <div class="filter-field">
        <input
          ref={inputRef}
          type="search"
          class={`filter-field-input ${inputClass}`}
          placeholder={placeholder}
          aria-label={label}
          value={value}
          onInput={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Esc empties rather than only blurring: the text is what is
            // narrowing, so "get me out of the filter" and "empty the box"
            // are one intent.
            if (e.key === "Escape") {
              e.preventDefault();
              onChange("");
            } else if (shouldSendOnKeyDown(e)) {
              e.preventDefault();
              if (saveTo !== null) saveFilter(saveTo, value);
            }
          }}
        />
        {saveTo !== null ? (
          <button
            type="button"
            class="session-input-pill filter-field-save"
            aria-label={`${current} を保存`}
            onPointerDown={keepFocus}
            onClick={(e) => {
              saveFilter(saveTo, value);
              refocusAfterKeyPress(e);
            }}
          >
            save
          </button>
        ) : null}
        {value !== "" ? (
          <button
            type="button"
            class="filter-field-clear"
            aria-label="入力を消す"
            onPointerDown={keepFocus}
            onClick={(e) => {
              onChange("");
              refocusAfterKeyPress(e);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {saved.length > 0 ? (
        <ul class="saved-filters" aria-label="保存した語">
          {saved.map((word) => (
            <li key={word} class="saved-filter">
              <button
                type="button"
                class="saved-filter-word"
                title={word}
                aria-label={`${word} ${verb}`}
                aria-current={word === current ? "true" : undefined}
                onPointerDown={keepFocus}
                // The word in the input already (the pill pressed a second
                // time) takes it out again.
                onClick={() => onChange(word === current ? "" : word)}
              >
                {savedFilterLabel(word)}
              </button>
              <button
                type="button"
                class="saved-filter-remove"
                aria-label={`${word} を保存から消す`}
                onPointerDown={keepFocus}
                onClick={(e) => {
                  if (savedId !== null) removeSavedFilter(savedId, word);
                  refocusAfterKeyPress(e);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
