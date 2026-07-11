// Drag payload for the "drag a Sessions-list row onto a room's chat area to
// invite it" gesture (DR-0011 §1-4). A dedicated MIME type lets the drop zone
// tell "one of our session rows" apart from any other drag (a link, a file, a
// text selection) without guessing from content; text/plain is carried too as
// a fallback since some browsers (notably Safari, via the OS pasteboard) can
// drop custom MIME types across a drag while text/plain survives. Kept as its
// own module (not utils.ts) so SessionList.tsx/RoomView.tsx can share it
// without both editing a file the other doesn't own.
export const SID_DRAG_MIME = "application/x-ccmsg-sid";

/** Minimal surface of DataTransfer this module writes to (drag start). */
export interface DragPayloadWriter {
  setData(format: string, data: string): void;
}

/** Sets both the custom-MIME payload and its text/plain fallback to `sid`. */
export function setSidDragPayload(dt: DragPayloadWriter, sid: string): void {
  dt.setData(SID_DRAG_MIME, sid);
  dt.setData("text/plain", sid);
}

/** Minimal surface of DataTransfer this module reads from (dragover/drop). */
export interface DragPayloadReader {
  types: ArrayLike<string>;
  getData(format: string): string;
}

/** True when the in-flight drag carries a session sid — usable from
 * `dragover` (where `types` is readable but `getData` is not, per the HTML
 * drag-and-drop spec) to decide whether to show the drop-zone as accepting. */
export function hasSidDragPayload(dt: DragPayloadReader): boolean {
  return Array.prototype.includes.call(dt.types, SID_DRAG_MIME);
}

/** Extracts the dragged sid on `drop` (where `getData` is reliable). Tries
 * the custom MIME first, falling back to text/plain for the Safari
 * custom-MIME-stripping case described above. Returns null for a drag that
 * never carried a session sid. */
export function parseSidDragPayload(dt: DragPayloadReader): string | null {
  const fromCustom = dt.getData(SID_DRAG_MIME);
  if (fromCustom) return fromCustom;
  const fromPlain = dt.getData("text/plain");
  return fromPlain || null;
}
