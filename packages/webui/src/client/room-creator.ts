// Pure derivations for RoomCreator.tsx (sidebar ROOMS "+ 新規"). Kept out of
// utils.ts as a standalone module, same convention as session-creator.ts —
// the form model and its wire-request projection are exercised in isolation
// by room-creator.test.ts, and neither reads AppState nor does I/O (that's
// RoomCreator.tsx's job, per DR-0005 §1).
//
// Unlike SessionRooms.tsx's NewRoomForm (which runs inside a specific
// session's Rooms tab and so has an implicit sole member — the viewed
// session, see its doc comment), the sidebar-level creator has no session
// context to imply a member from: the webui always hello()s as role "user"
// (u1, see ws.ts's doc comment), and create_room's `include_self` is a no-op
// for user-role callers. So this form must let the caller pick members
// explicitly from the connected-sessions list, which NewRoomForm's title-only
// form doesn't need.

export interface RoomCreatorForm {
  title: string;
  memberSids: string[];
  /** kawaz r26 mid=118: broadcast rooms had no webui creation path (CLI-only
   * `--kind broadcast`). "1on1" is deliberately absent — that kind is
   * auto-created by the session-view composer (DR-0014 §2.2), not this form. */
  kind: "normal" | "broadcast";
}

export function initialRoomCreatorForm(): RoomCreatorForm {
  return { title: "", memberSids: [], kind: "normal" };
}

/** Create button gate: a normal room requires at least one member (an empty
 * `members` array with a user-role caller would create a room with only the
 * implicit User in it, which isn't a useful room — see CreateRoomRequest's
 * doc comment on why `include_self` doesn't help here). A broadcast room
 * needs none: the daemon auto-populates members from the live registry
 * (DR-0013) and ignores `members` entirely. */
export function roomCreatorFormValid(form: RoomCreatorForm): boolean {
  return form.kind === "broadcast" || form.memberSids.length > 0;
}

export function toggleRoomCreatorMember(form: RoomCreatorForm, sid: string): RoomCreatorForm {
  const has = form.memberSids.includes(sid);
  return {
    ...form,
    memberSids: has ? form.memberSids.filter((s) => s !== sid) : [...form.memberSids, sid],
  };
}

/** Builds the wire `create_room` request body (op excluded — ws.ts's
 * createRoom adds it, same convention as SessionCreator's
 * buildSessionLaunchRequest). Returns null when the form isn't submittable
 * yet (mirrors roomCreatorFormValid) so callers can't accidentally fire a
 * request with zero members. */
export function buildCreateRoomRequest(
  form: RoomCreatorForm,
): { members: string[]; title?: string; kind?: "broadcast" } | null {
  if (!roomCreatorFormValid(form)) return null;
  const title = form.title.trim();
  // broadcast: members is ignored by the daemon (auto-populated, DR-0013
  // §2.9) — send [] so the request doesn't imply a selection that has no
  // effect. kind is omitted for "normal" (the daemon default).
  if (form.kind === "broadcast") {
    return { members: [], ...(title ? { title } : {}), kind: "broadcast" };
  }
  return { members: form.memberSids, ...(title ? { title } : {}) };
}
