// The webui's paths that a link from outside the webui is written with
// (docs/design/webui-url-grammar.md): the webui writes them when it moves to
// a place, and the daemon writes them into what it hands the say command
// (docs/design/say-command.md), so that a link opens the place the webui
// itself goes to. Reading a path back is the webui's (locator.ts).

/** Which kind of bubble a session's own Timeline shows alone (DR-0050 §4):
 * the say bubbles (🔔) or the permission requests (🔐). The page query
 * `filter` on `/s/<sid>/timeline/<position>`. */
export type TimelineFilter = "say" | "permit";

/** The path of session `sid`, which goes on to the place last seen in it. */
export function sessionHref(sid: string): string {
  return `/s/${encodeURIComponent(sid)}`;
}

/** The session's own Timeline at `position` (`head`, or the uuid of the row
 * to land on), showing only `filter`'s bubbles when one is given. Every
 * write of the position passes the filter it is under, so moving the
 * position never drops it (DR-0050 §4). */
export function timelineHref(
  sid: string,
  position = "head",
  filter: TimelineFilter | null = null,
): string {
  const path = `${sessionHref(sid)}/timeline/${encodeURIComponent(position)}`;
  return filter === null ? path : `${path}?filter=${filter}`;
}
