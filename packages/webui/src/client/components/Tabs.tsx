/** @jsxImportSource preact */
// One row of mutually exclusive views. Before this component the UI had three
// spellings of the same thing — some with `role="tablist"`, some with
// `aria-selected`, some with neither — so a screen reader announced the same
// control differently depending on which pane it was in. The markup is settled
// here; the class names stay with the call sites, which is what keeps the
// three rows looking like themselves.
//
// A tab is an `<a>` when selecting it means going somewhere (the session tabs
// live in the URL, so they must stay navigable/middle-clickable), a `<button>`
// when it only flips local state, and a non-interactive `<span>` when the view
// behind it does not exist for this subject. All three still answer to
// `role="tab"`, so the row reads as one set either way.
import type { ComponentChildren } from "preact";

export interface TabItem<Id extends string = string> {
  id: Id;
  label: ComponentChildren;
  /** Present for tabs that are a location. Renders an `<a>` and ignores `onSelect`. */
  href?: string;
  /** Native tooltip; also the place to say *why* a disabled tab is disabled. */
  title?: string;
  /** The view behind this tab is unavailable for this subject. Not clickable. */
  disabled?: boolean;
}

export function Tabs<Id extends string>({
  items,
  selected,
  onSelect,
  class: className,
  tabClass,
  label,
}: {
  items: TabItem<Id>[];
  selected: Id;
  /** Omitted by href-driven rows, where navigation does the selecting. */
  onSelect?: (id: Id) => void;
  /** Class of the row. */
  class?: string;
  /** Class of every tab in it; the selected one also gets `active`. */
  tabClass: string;
  /** Names the row for screen readers when the surrounding text does not. */
  label?: string;
}) {
  return (
    <div class={className} role="tablist" aria-label={label}>
      {items.map((item) => {
        // A disabled tab is never drawn as the selected one, even when it is
        // the one the locator names (a session with no transcript sitting on
        // its Timeline tab): the row would be pointing at a view that is not
        // there. It reads as unavailable, and the pane below says the rest.
        const isSelected = item.id === selected && !item.disabled;
        const classes = tabClass + (isSelected ? " active" : "");
        if (item.disabled) {
          return (
            <span
              key={item.id}
              class={tabClass + " disabled"}
              role="tab"
              aria-disabled="true"
              title={item.title}
            >
              {item.label}
            </span>
          );
        }
        if (item.href !== undefined) {
          return (
            <a
              key={item.id}
              class={classes}
              role="tab"
              aria-selected={isSelected}
              href={item.href}
              title={item.title}
            >
              {item.label}
            </a>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            class={classes}
            role="tab"
            aria-selected={isSelected}
            title={item.title}
            onClick={() => onSelect?.(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
