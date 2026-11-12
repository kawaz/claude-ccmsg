// A count laid over what it is about (DR-0050 §3): the content (an emoji, an
// icon) in a box with no padding, as wide as the content written as text, and
// the count in a small red counter over the bottom right of the drawn
// picture, never past its right or bottom edge (app.css sets the counter in
// from the box by the emoji's spare advance). The counter is absolute, so
// whether it shows changes neither the box's size nor where anything around
// it sits. What the content is, and what pressing it does,
// is the caller's: wrap it (a link, a button) without giving the wrapper room
// of its own.
import type { ComponentChildren } from "preact";

/** What the counter says: none for 0, the number from 1, and `99+` past 99 so
 * the counter keeps its width. */
export function countBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export function CountBadge({ count, children }: { count: number; children: ComponentChildren }) {
  const counter = countBadgeText(count);
  return (
    <span class="count-badge">
      {children}
      {counter !== null ? (
        <span class="count-badge-counter" aria-hidden="true">
          {counter}
        </span>
      ) : null}
    </span>
  );
}
