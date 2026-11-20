// The ☆ / ⭐ of a bookmark (DR-0058 §3): the two glyphs as StackedLabels, so
// the box is as large as the larger of the two whichever shows, and turning a
// bookmark on or off moves nothing around it. ☆ is a text glyph and ⭐ an
// emoji, drawn from different fonts at different sizes, so either alone would
// make the box jump. Its place names itself (aria-label): the glyphs say
// nothing to assistive technology.
import { StackedLabels } from "./StackedLabels.tsx";

const STARS = ["☆", "⭐"] as const;

export function StarMark({ on }: { on: boolean }) {
  return <StackedLabels class="star-mark" labels={STARS} shown={on ? 1 : 0} />;
}
