import type { ComponentChildren } from "preact";

/** Recovery offered alongside the failure — a place to go (`href`) or something
 * to undo (`onClick`). Both render as the same control, because to the reader
 * they are the same offer: a way out of here. */
export type ErrorViewAction =
  | { label: string; href: string }
  | { label: string; onClick: () => void };

export type ErrorViewProps = {
  /** The glyph slot, always filled: an HTTP-shaped status when the address is
   * what failed ("404" for one that names nothing, "403" for one this session
   * may not read), "!" when the failure has no status of its own. Keeping the
   * slot occupied is what makes the cases read as one family rather than as
   * several unrelated screens. */
  mark: string;
  /** `danger` for a failure that happened *to* the user — a read that broke, a
   * transcript that would not load. An address that simply names nothing is
   * not an alarm, so navigation failures stay muted. */
  tone?: "muted" | "danger";
  title: string;
  /** Verbatim machine text: the path, the id, the daemon's own words. Set in
   * monospace and allowed to wrap, never truncated — it is usually the one
   * thing the reader needs to compare against what they expected. */
  detail?: string;
  /** Supplemental recovery from the caller (e.g. "did you mean"), placed
   * between the detail and the hint so a concrete alternative is read before
   * the general advice. */
  children?: ComponentChildren;
  hint?: ComponentChildren;
  action?: ErrorViewAction;
  /** Render in place of the whole content area rather than inside a pane. Also
   * decides the element: standing in for the content area makes this the
   * document's main landmark, while a pane-local failure is just part of the
   * pane that failed. */
  fill?: boolean;
};

/** The single presentation for every "you are somewhere that isn't there, or
 * that can't be read" state in the UI (kawaz r76 m76).
 *
 * Before this, each site had grown its own look — a structured 404 in one
 * place, a bare red line for a refused path in another, borrowed 404 classes
 * with an unstyled button in a third. They are all the same event to the
 * reader, so they get the same shape here and differ only in glyph, words and
 * what recovery they can honestly offer.
 *
 * Every instance renders *inside* the content area with the sidebar still
 * mounted. Being off-route has to stay clickable-out-of, which a full-page
 * error screen is not. */
export function ErrorView({
  mark,
  tone = "muted",
  title,
  detail,
  children,
  hint,
  action,
  fill,
}: ErrorViewProps) {
  const classes = ["errorview"];
  if (fill) classes.push("errorview-fill");
  if (tone === "danger") classes.push("errorview-danger");
  const Container = fill ? "main" : "div";
  return (
    <Container class={classes.join(" ")}>
      {/* The glyph repeats what the heading already says, so it is decoration
       * for anyone reading by voice. */}
      <p class="errorview-mark" aria-hidden="true">
        {mark}
      </p>
      <p class="errorview-title">{title}</p>
      {detail !== undefined ? <p class="errorview-detail">{detail}</p> : null}
      {children}
      {hint !== undefined ? <p class="errorview-hint">{hint}</p> : null}
      {action !== undefined ? (
        "href" in action ? (
          <a class="errorview-action" href={action.href}>
            {action.label}
          </a>
        ) : (
          <button class="errorview-action" type="button" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </Container>
  );
}
