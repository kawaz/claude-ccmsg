/** @jsxImportSource preact */
// A titled section the reader can collapse. `<details>` rather than component
// state so the browser owns the disclosure — keyboard, find-in-page and the
// open set surviving a re-render come free (the reasoning UsageStats'
// BucketRow arrived at independently, now shared by every collapsible section
// in the UI).
//
// The wrapper carries no styling of its own: each call site keeps the class it
// had, so this is a structural union (one `<details>`/`<summary>` shape) and
// not a visual one. `summary` takes children rather than a string because the
// usage rows put a bar and two numbers in theirs.
import type { ComponentChildren } from "preact";

export function Fold({
  id,
  class: className,
  summary,
  summaryClass,
  open,
  children,
}: {
  id?: string;
  class?: string;
  summary: ComponentChildren;
  summaryClass?: string;
  /** Open on first render. The browser owns it from then on. */
  open?: boolean;
  children: ComponentChildren;
}) {
  return (
    <details id={id} class={className} open={open}>
      <summary class={summaryClass}>{summary}</summary>
      {children}
    </details>
  );
}
