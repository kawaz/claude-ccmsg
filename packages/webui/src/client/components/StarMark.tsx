// The ☆ / ⭐ of a bookmark (DR-0058 §3): both glyphs laid in the same grid
// cell, the one not shown hidden, so the box is as large as the larger of the
// two whichever shows, and turning a bookmark on or off moves nothing around
// it. ☆ is a text glyph and ⭐ an emoji, drawn from different fonts at
// different sizes, so either alone would make the box jump. Which one shows is
// the box's own attribute (`data-on`), switched by app.css (.star-mark); no
// script measures anything. The same way as the 許可する / 許可済み /
// コピーしました of a request's button (DR-0040 §7, `.permit-grant`).

export function StarMark({ on }: { on: boolean }) {
  return (
    <span class="star-mark" data-on={on ? "" : undefined} aria-hidden="true">
      <span class="star-mark-off">☆</span>
      <span class="star-mark-on">⭐</span>
    </span>
  );
}
