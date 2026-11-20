// The ☆ / ⭐ of a bookmark or a pin (DR-0058 §3): the two glyphs as
// StackedLabels, so the box is as large as the larger of the two whichever
// shows, and turning it on or off moves nothing around it. ☆ is a text glyph
// and ⭐ an emoji, drawn from different fonts at different sizes, so either
// alone would make the box jump. Its place names itself (aria-label): the
// glyphs say nothing to assistive technology.
//
// `fit`: ⭐ is drawn smaller, in ☆'s box (app.css `.star-mark-fit`), so the box
// is the size ☆ always had and the controls around a pin do not grow when it
// is set (kawaz 2026-11-20: the pins of SESSIONS and of the session header).
import { StackedLabels } from "./StackedLabels.tsx";

const STARS = ["☆", "⭐"] as const;

export function StarMark({ on, fit = false }: { on: boolean; fit?: boolean }) {
  return (
    <StackedLabels
      class={fit ? "star-mark star-mark-fit" : "star-mark"}
      labels={STARS}
      shown={on ? 1 : 0}
    />
  );
}
