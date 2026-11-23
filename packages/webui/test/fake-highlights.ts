// happy-dom has no Highlight / CSS.highlights (the CSS Custom Highlight API):
// a minimal fake that keeps the ranges registered under each name stands in
// for them, so a test reads what would be painted.
import { defined, instanceOf, stubProperty } from "./helpers.ts";

class FakeHighlight {
  readonly ranges: AbstractRange[];
  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }
}

export interface FakeHighlights {
  /** The text of each range registered under `name`, in order (none when
   * the name is not registered). */
  painted: (name: string) => string[];
  /** Puts the window's own Highlight and CSS back. */
  restore: () => void;
}

/** Puts the fake in place on the document's window. */
export function stubHighlights(): FakeHighlights {
  const win = defined(document.defaultView, "the window");
  const registry = new Map<string, FakeHighlight>();
  const css = win.CSS;
  const restores = [
    stubProperty(win, "Highlight", { value: FakeHighlight, configurable: true, writable: true }),
    // happy-dom's window.CSS is a fresh object on every read, so replace it
    // whole, keeping what the page uses of it besides (CSS.escape).
    stubProperty(win, "CSS", {
      value: { escape: (value: string) => css.escape(value), highlights: registry },
      configurable: true,
      writable: true,
    }),
  ];
  return {
    painted: (name) =>
      (registry.get(name)?.ranges ?? []).map((range) =>
        instanceOf(range, Range, `a range of ${name}`).toString(),
      ),
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}
