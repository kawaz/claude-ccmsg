// The top edge of the composer's textarea as a second resize handle (the
// browser's own is the bottom-right corner). The FAB's panel sits at the
// bottom of the screen, so a person reaches for its top to make room.

/** Move the top edge of `textarea` to `top` (a viewport y), its bottom edge
 * where it is, no higher than the panel's top can go and stay in view. The
 * CSS min-height still has its say. Returns how much taller the textarea got
 * (negative: shorter): a panel placed by its top moves up by that much so the
 * bottom edge stays.
 *
 * Design rationale: the height is written to the textarea's inline style,
 * where the browser's own resize writes it, so the two handles move one
 * height; a state of the component would be a second copy that the
 * bottom-right corner does not update. */
export function resizeFromTop(textarea: HTMLElement, panel: HTMLElement, top: number): number {
  const box = textarea.getBoundingClientRect();
  const room = Math.max(0, panel.getBoundingClientRect().top);
  const height = Math.min(box.bottom - top, box.height + room);
  // Past the bottom edge it is 0, which the min-height raises: a negative
  // height would be dropped and leave the last one.
  textarea.style.height = `${Math.max(0, height)}px`;
  return textarea.getBoundingClientRect().height - box.height;
}
