// A modal dialog, the one shape every operation the webui separates from its
// screen opens in (webui-structure: an operation goes to a dialog). Mounted
// while it is open: the caller renders it only then, so what is in it starts
// over each time it opens, and unmounting it is the closing.
//
// The browser owns being modal: `showModal()` puts it in the top layer with
// the rest of the page inert, focus kept inside, and Escape arriving as the
// dialog's `cancel` event. That event is taken here and turned into the
// caller's `onClose`, so whether the dialog is open stays the caller's state
// alone, and a dialog that may not close yet (`closable` false: something it
// sent is still out) ignores it.
//
// Wide, it is a box in the middle of the window; narrow, the whole screen with
// a 戻る at the top instead of the ×. The width switch is a media query on the
// viewport (app.css `.modal-dialog`): the top layer has no container to ask.
//
// The caller puts the content in `.modal-dialog-body`, which scrolls. The
// buttons of a form go in the form, right under its fields, not in a bar
// pinned to the dialog's bottom (webui-structure: no bar fixed to the bottom
// of the screen; full-screen narrow, that bar sat a screen away from the
// field it acts on).
import type { ComponentChildren, JSX } from "preact";
import { useId, useLayoutEffect, useRef } from "preact/hooks";

export function ModalDialog({
  title,
  closable,
  onClose,
  class: className,
  children,
}: {
  title: string;
  /** Whether the person can close it now (Escape, ×, 戻る). */
  closable: boolean;
  onClose: () => void;
  class?: string;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Open as it mounts, before paint, so it never shows as a non-modal box.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  function onCancel(e: JSX.TargetedEvent<HTMLDialogElement, Event>): void {
    e.preventDefault();
    if (closable) onClose();
  }

  return (
    <dialog
      ref={ref}
      class={className === undefined ? "modal-dialog" : `modal-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={onCancel}
    >
      <header class="modal-dialog-head">
        <button type="button" class="modal-dialog-back" disabled={!closable} onClick={onClose}>
          ← 戻る
        </button>
        <h2 id={titleId} class="modal-dialog-title">
          {title}
        </h2>
        <button
          type="button"
          class="modal-dialog-close"
          aria-label="閉じる"
          title="閉じる (Esc)"
          disabled={!closable}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
