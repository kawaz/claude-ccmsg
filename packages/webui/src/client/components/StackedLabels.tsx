// Labels that take turns in one place without the place changing size: every
// candidate is laid in the same grid cell, and the ones not shown are hidden
// with `visibility`, so the box is as large as the largest candidate whichever
// shows (DR-0058 §3). Which one shows is the box's own attribute
// (`data-shown`, the candidate's index), switched by app.css
// (`.stacked-labels`); no script measures anything. Used where a label
// changes in place and the things around it must not move: the ☆ / ⭐ of a
// bookmark (StarMark), and the SESSIONS sort button's mode. The same way as
// the 許可する / 許可済み / コピーしました of a request's button (DR-0040 §7,
// `.permit-grant`).
//
// The candidates are hidden from assistive technology with them (visibility),
// so a control whose name is its label names itself (aria-label) with the
// candidate shown.
import type { ComponentChildren } from "preact";

/** As many candidates as app.css has rules for (`.stacked-labels[data-shown]`). */
export const STACKED_LABELS_MAX = 6;

export function StackedLabels({
  labels,
  shown,
  class: className,
}: {
  /** The candidates, at most STACKED_LABELS_MAX. */
  labels: readonly ComponentChildren[];
  /** The index of the one to show. */
  shown: number;
  class?: string;
}) {
  return (
    <span
      class={className === undefined ? "stacked-labels" : `stacked-labels ${className}`}
      data-shown={String(shown)}
    >
      {labels.map((label, i) => (
        <span key={i}>{label}</span>
      ))}
    </span>
  );
}
