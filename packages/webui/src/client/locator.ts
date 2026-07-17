// URL fragment locator. Three independent forms share the fragment,
// disambiguated by a leading `r` / `s` / `t` (DR-0008, DR-0009):
//   - room (DR-0004 §5, unchanged): `#rXXXX` selects a room, `#rXXXX-mNN`
//     selects a room and a message within it. Room ids are opaque
//     server-issued tokens ("r1", "r2", ...); splitting on the trailing
//     `-m<digits>` suffix keeps this independent of the id's own shape.
//   - session (DR-0008): `#s<sid>` selects a session's file-browsing view,
//     `#s<sid>:<relpath>` additionally selects a file within it. Unlike room
//     ids, `sid` has no reserved shape of its own (it comes from
//     `CCMSG_SID`/`CLAUDE_CODE_SESSION_ID`, DR-0006), so the leading literal `s` is
//     a real syntax marker here, not a character baked into the id — that's
//     also why the file path uses a distinct `:` separator rather than
//     reusing room's `-m`, since a raw sid could plausibly contain `-`.
//   - timeline (DR-0009): `#t<sid>` selects a session's transcript Timeline
//     view. This is a distinct leading-marker form (not a third `session`
//     sub-case behind `:`) because the Timeline pane carries no client-chosen
//     path — the byte-offset paging state lives in the store's per-sid cache,
//     not the URL — so there's nothing to put after a separator. A dedicated
//     marker char also sidesteps the encoding trap a `!timeline`-style suffix
//     would have: encodeURIComponent leaves `!` unescaped, so a raw sid
//     containing it could collide with such a suffix; a *leading* marker
//     can't collide because the sid segment is always what's decoded, never
//     what's matched against.
// The path segment (and, symmetrically, the sid segment) is
// `encodeURIComponent`-ed so `/` in a relpath — or `:` in a raw sid — survives
// the fragment round-trip unambiguously.

/** DR-0025 Phase 2: agent-transcript sub-selection inside a timeline
 * locator. Encoded as `#t<sid>:<segment>` where segment is one of:
 *   - `wf_XXX/a...` (workflow-owned agent — runId + `/` + agentId, both encoded)
 *   - `a...`       (direct subagent under `<sid>/subagents/`)
 *   - `tm/<name>`  (teammate resolved via `agent-*.meta.json` scan)
 * All fields are absent when the locator selects the session's own transcript. */
export interface AgentRef {
  agentId?: string;
  runId?: string;
  teammate?: string;
}

export type Locator =
  | { view: "room"; room: string | null; mid: number | null }
  | { view: "session"; sid: string; path: string | null }
  | { view: "timeline"; sid: string; agent?: AgentRef };

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
  if (raw.startsWith("t")) {
    const rest = raw.slice(1);
    const colon = rest.indexOf(":");
    const sidRaw = colon === -1 ? rest : rest.slice(0, colon);
    // fall back to the raw (still-encoded) sid rather than losing it entirely,
    // same policy as the session form below.
    const sid = tryDecode(sidRaw, sidRaw);
    if (colon === -1) return { view: "timeline", sid };
    const segment = rest.slice(colon + 1);
    const agent = parseAgentSegment(segment);
    return agent ? { view: "timeline", sid, agent } : { view: "timeline", sid };
  }
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

export function timelineHref(sid: string): string {
  return `#t${encodeURIComponent(sid)}`;
}

/** DR-0025 Phase 2: link to an agent / teammate timeline inside `sid`. The
 * three shapes below are decoded by `parseAgentSegment` on the receiving
 * side. Nothing is trusted to be regex-clean here — the daemon-side resolver
 * (`AGENT_ID_RE` / `RUN_ID_RE` / `TEAMMATE_NAME_RE`) is the security boundary
 * and will refuse anything shaped wrong even if a hand-edited URL sneaks a
 * pathological value through. */
export function agentTimelineHref(sid: string, ref: AgentRef): string {
  const sidEnc = encodeURIComponent(sid);
  if (ref.teammate !== undefined) {
    return `#t${sidEnc}:tm/${encodeURIComponent(ref.teammate)}`;
  }
  if (ref.agentId !== undefined) {
    const agentEnc = encodeURIComponent(ref.agentId);
    if (ref.runId !== undefined) {
      return `#t${sidEnc}:${encodeURIComponent(ref.runId)}/${agentEnc}`;
    }
    return `#t${sidEnc}:${agentEnc}`;
  }
  return `#t${sidEnc}`;
}

function parseAgentSegment(segment: string): AgentRef | undefined {
  if (segment.length === 0) return undefined;
  const slash = segment.indexOf("/");
  if (slash === -1) {
    const agentId = tryDecode(segment, "");
    return agentId ? { agentId } : undefined;
  }
  const left = segment.slice(0, slash);
  const right = segment.slice(slash + 1);
  if (left === "tm") {
    const teammate = tryDecode(right, "");
    return teammate ? { teammate } : undefined;
  }
  const runId = tryDecode(left, "");
  const agentId = tryDecode(right, "");
  if (!runId || !agentId) return undefined;
  return { runId, agentId };
}
