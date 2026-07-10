// URL fragment locator. Two independent forms share the fragment, disambiguated
// by a leading `s` (DR-0008):
//   - room (DR-0004 §5, unchanged): `#rXXXX` selects a room, `#rXXXX-mNN`
//     selects a room and a message within it. Room ids are opaque
//     server-issued tokens ("r1", "r2", ...); splitting on the trailing
//     `-m<digits>` suffix keeps this independent of the id's own shape.
//   - session (DR-0008): `#s<sid>` selects a session's file-browsing view,
//     `#s<sid>:<relpath>` additionally selects a file within it. Unlike room
//     ids, `sid` has no reserved shape of its own (it comes from
//     `CCMSG_SID`/`CLAUDE_SESSION_ID`, DR-0006), so the leading literal `s` is
//     a real syntax marker here, not a character baked into the id — that's
//     also why the file path uses a distinct `:` separator rather than
//     reusing room's `-m`, since a raw sid could plausibly contain `-`.
// The path segment (and, symmetrically, the sid segment) is
// `encodeURIComponent`-ed so `/` in a relpath — or `:` in a raw sid — survives
// the fragment round-trip unambiguously.

export type Locator =
  | { view: "room"; room: string | null; mid: number | null }
  | { view: "session"; sid: string; path: string | null };

/** `decodeURIComponent` throws on malformed percent-encoding (e.g. a lone
 *  `%zz`) instead of returning some best-effort value. A hand-edited or
 *  corrupted `location.hash` must not be able to crash the whole app at
 *  startup (main.tsx calls parseHash() at module load, uncaught) — so a
 *  segment that fails to decode falls back to `fallback` rather than
 *  propagating the exception. */
function tryDecode(segment: string, fallback: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return fallback;
  }
}

export function parseHash(hash: string): Locator {
  const raw = hash.replace(/^#/, "");
  if (!raw) return { view: "room", room: null, mid: null };
  if (raw.startsWith("s")) {
    const rest = raw.slice(1);
    const colon = rest.indexOf(":");
    const sidRaw = colon === -1 ? rest : rest.slice(0, colon);
    // fall back to the raw (still-encoded) sid rather than losing it entirely
    const sid = tryDecode(sidRaw, sidRaw);
    if (colon === -1) return { view: "session", sid, path: null };
    // an undecodable path segment means "no file selected" rather than a
    // garbled/mojibake path — same session, empty FileViewer.
    const pathRaw = rest.slice(colon + 1);
    let path: string | null;
    try {
      path = decodeURIComponent(pathRaw);
    } catch {
      path = null;
    }
    return { view: "session", sid, path };
  }
  const m = raw.match(/^(.+)-m(\d+)$/);
  if (m) return { view: "room", room: m[1] ?? null, mid: Number(m[2]) };
  return { view: "room", room: raw, mid: null };
}

export function anchorId(roomId: string, mid: number): string {
  return `msg-${roomId}-${mid}`;
}

export function messageHref(roomId: string, mid: number): string {
  return `#${roomId}-m${mid}`;
}

export function roomHref(roomId: string): string {
  return `#${roomId}`;
}

export function sessionHref(sid: string): string {
  return `#s${encodeURIComponent(sid)}`;
}

export function fileHref(sid: string, path: string): string {
  return `#s${encodeURIComponent(sid)}:${encodeURIComponent(path)}`;
}
