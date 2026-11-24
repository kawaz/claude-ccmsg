// A filter box with the words the person keeps for it (DR-0043 §9, kawaz
// 2026-11-24): the SESSIONS quick filter and the Files pane's name search.
// Typing narrows as it goes, as before. ⌘Enter (Ctrl+Enter), or the save pill
// inside the box, keeps the word; the kept words sit under the box as pills,
// and pressing one puts it in the box (the box's own way in, so it narrows at
// once) while its × takes it off the list and leaves the box as it is.
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
  savedFilterWord,
  type SavedFiltersKey,
  subscribeSavedFilters,
} from "../saved-filters.ts";

export function FilterField({
  value,
  onChange,
  savedKey,
  inputClass,
  placeholder,
  label,
  verb,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Which list of kept words the box has. */
  savedKey: SavedFiltersKey;
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
    (listener: () => void) => subscribeSavedFilters(savedKey, listener),
    [savedKey],
  );
  const saved = useSyncExternalStore(subscribe, () => savedFilters(savedKey));
  const canSave = canSaveFilter(saved, value);
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
              if (canSave) saveFilter(savedKey, value);
            }
          }}
        />
        {canSave ? (
          <button
            type="button"
            class="session-input-pill filter-field-save"
            aria-label={`${current} を保存`}
            onPointerDown={keepFocus}
            onClick={(e) => {
              saveFilter(savedKey, value);
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
                onClick={() => onChange(word)}
              >
                {word}
              </button>
              <button
                type="button"
                class="saved-filter-remove"
                aria-label={`${word} を保存から消す`}
                onPointerDown={keepFocus}
                onClick={(e) => {
                  removeSavedFilter(savedKey, word);
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
