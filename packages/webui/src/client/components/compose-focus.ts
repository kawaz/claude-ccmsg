// The input box's textarea keeps the person's focus across the box's own
// controls (DR-0062 §3, §15, kawaz 2026-11-24): the btw / 後で pill, the
// attachments' ×, the 📎 and its file choice. On a phone, a focus that leaves
// the textarea puts the keyboard away and moves the screen, and the person is
// in the middle of writing.
//
// The controls do not take the focus at all, rather than taking it and giving
// it back (which puts the keyboard away and brings it out again): a press
// that starts on one while the textarea has the focus takes no default, so no
// focus moves (as the selection toolbar's buttons do, comment-quotes.tsx).
// A press from the keyboard (Tab to it, Enter / Space) or from assistive
// technology starts no pointer, and goes as before; a press while the
// textarea did not have the focus moves it as before, and not to the
// textarea. A filter box keeps its input's focus across its own controls (the
// save pill, the ×, the saved words) the same way (DR-0043 §9).
//
// The file choice is the system's own screen, which the focus leaves for
// whatever the page does. When it closes (a choice, or none), the textarea
// gets the focus and the caret it had back, if it had them when the choice
// opened.
import { createContext } from "preact";
import { useContext, useRef } from "preact/hooks";

/** The textarea of the input box a control is in (provided by the box). */
export type ComposeTextarea = { readonly current: HTMLTextAreaElement | null };

export const ComposeTextareaContext = createContext<ComposeTextarea | null>(null);

function focused(element: HTMLElement | null): boolean {
  return element !== null && element.ownerDocument.activeElement === element;
}

/** The `onPointerDown` of a control beside a field that leaves the field's
 * focus where it is: while the field has it, the press takes no default. The
 * same holds for a filter box's own controls (FilterField.tsx). */
export function keepsFocusOf(field: {
  readonly current: HTMLElement | null;
}): (event: PointerEvent) => void {
  return (event) => {
    if (focused(field.current)) event.preventDefault();
  };
}

const NO_TEXTAREA: ComposeTextarea = { current: null };

/** The `onPointerDown` of a control of the box that leaves the textarea's
 * focus where it is: while the textarea has it, the press takes no default. */
export function useKeepsComposeFocus(): (event: PointerEvent) => void {
  return keepsFocusOf(useContext(ComposeTextareaContext) ?? NO_TEXTAREA);
}

/** Around the system's file choice: `opening` notes whether the textarea had
 * the focus and where its caret was, `closed` (a choice made, or none) gives
 * them back. Called in that order for each choice. */
export function useComposeFocusAcrossChoice(): { opening: () => void; closed: () => void } {
  const textarea = useContext(ComposeTextareaContext);
  const held = useRef<{ start: number; end: number } | null>(null);
  return {
    opening: () => {
      const el = textarea?.current ?? null;
      held.current =
        el !== null && focused(el) ? { start: el.selectionStart, end: el.selectionEnd } : null;
    },
    closed: () => {
      const el = textarea?.current ?? null;
      const was = held.current;
      held.current = null;
      if (el === null || was === null) return;
      if (!focused(el)) el.focus({ preventScroll: true });
      el.setSelectionRange(was.start, was.end);
    },
  };
}
