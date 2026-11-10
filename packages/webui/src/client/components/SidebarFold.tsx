// One fold of the sidebar's column (SESSIONS / ROOMS / GLOBALS, DR-0043 §3):
// a heading line and a body shown only while open.
//
// Use this rather than `Fold` when the heading carries buttons of its own
// (SESSIONS' +New / search / sort / refresh). `Fold` is a `<details>`, and a
// `<summary>` makes its whole content one button, so a button inside it is an
// interactive element inside another, and one outside a closed `<details>` is
// not drawn at all. Here the heading line holds the toggle and the tools as
// siblings: a tool's click never reaches the toggle, so no tool has to stop
// it (DR-0043 §2), and the DOM order is the order seen.
//
// In WAI-ARIA APG terms each fold is a disclosure: the toggle is a button
// inside the heading, naming the region it opens. Several may be open at once.
//
// Where a fold sits in the column (top, or pushed to the bottom) and whether
// its body shares the height is the sidebar's layout (app.css, by the fold's
// id), not something the fold knows.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { readSessionStorage, writeSessionStorage } from "../storage.ts";
import { useEffectEvent } from "../useEffectEvent.ts";

/** The sessionStorage key a fold's open / closed state is kept under. */
export function sidebarFoldStorageKey(id: string): string {
  return `ccmsg.sidebarFold.${id}`;
}

/** What the window last left the fold as, or `fallback` when it has not
 * been toggled in this window (or holds something else under the key). */
function storedOpen(id: string, fallback: boolean): boolean {
  const stored = readSessionStorage(sidebarFoldStorageKey(id));
  return stored === "open" ? true : stored === "closed" ? false : fallback;
}

export function SidebarFold({
  id,
  title,
  tools,
  defaultOpen = false,
  remembered = false,
  onToggle,
  children,
}: {
  /** The section's id; the toggle and the body take ids derived from it. */
  id: string;
  title: ComponentChildren;
  /** Buttons on the heading line, beside the toggle (never inside it). */
  tools?: ComponentChildren;
  /** Open on first render, where nothing is remembered. */
  defaultOpen?: boolean;
  /** Keep the open / closed state in sessionStorage: the window comes back to
   * what the person left it as across reloads, and each window (a desktop's,
   * a phone's) keeps its own. Without it every page load starts on
   * `defaultOpen`. */
  remembered?: boolean;
  /** Fires on every open/close (the toggle, or find-in-page opening it).
   * ROOMS fetches its list on the first open. */
  onToggle?: (open: boolean) => void;
  children: ComponentChildren;
}) {
  const [open, setOpen] = useState(() => (remembered ? storedOpen(id, defaultOpen) : defaultOpen));
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleId = `${id}-toggle`;
  const bodyId = `${id}-body`;
  const change = (next: boolean): void => {
    setOpen(next);
    if (remembered) writeSessionStorage(sidebarFoldStorageKey(id), next ? "open" : "closed");
    onToggle?.(next);
  };
  // Find-in-page reveals a match inside a closed body by removing its
  // `hidden="until-found"` itself and firing `beforematch` first. The state
  // has to follow, or the next render would not put `hidden` back on closing
  // (the prop would read the same as before) and the fold would read closed
  // while shown. Preact's JSX knows no `beforematch` prop, so the listener is
  // attached to the element here.
  const onBeforeMatch = useEffectEvent(() => change(true));
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const listener = (): void => onBeforeMatch();
    body.addEventListener("beforematch", listener);
    return () => body.removeEventListener("beforematch", listener);
  }, []);
  return (
    <section id={id} class="sidebar-fold">
      <div class="sidebar-fold-head">
        <h2>
          <button
            type="button"
            id={toggleId}
            class="sidebar-fold-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => change(!open)}
          >
            {title}
          </button>
        </h2>
        {tools !== undefined ? <div class="sidebar-fold-tools">{tools}</div> : null}
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        class="sidebar-fold-body"
        role="region"
        aria-labelledby={toggleId}
        hidden={open ? undefined : "until-found"}
      >
        {children}
      </div>
    </section>
  );
}
