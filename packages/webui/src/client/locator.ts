import { LLM_STATS_DAYS_MAX, LLM_STATS_DAYS_MIN } from "@ccmsg/protocol";

export interface AgentRef {
  agentId?: string;
  runId?: string;
  teammate?: string;
}

export type SessionTab = "files" | "timeline" | "terminal" | "status" | "rooms";

export type Locator =
  | { view: "room"; room: string | null; mid: number | null }
  /** Host-wide LLM credentials: quota and spend — the one screen that belongs
   * to no session and no room, so it sits at the URL root next to /r and /s.
   * `days` is the spend window, null when the URL names none (the daemon's
   * gateway then picks). It rides the URL so a reload, a bookmark, and the
   * back button all land on the window that was being read. */
  | { view: "usage"; days: number | null }
  | {
      view: "session";
      tab?: Exclude<SessionTab, "timeline">;
      sid: string;
      path: string | null;
      lineRange?: { start: number; end: number };
      from?: string;
    }
  | { view: "timeline"; tab?: "timeline"; sid: string; position?: string; agent?: AgentRef }
  | { view: "session-root"; sid: string }
  | { view: "unknown"; pathname: string };

function tryDecode(segment: string, fallback: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return fallback;
  }
}

function decodeNonEmpty(segment: string): string | null {
  const value = tryDecode(segment, "");
  return value === "" ? null : value;
}

function sessionLocator(
  sid: string,
  tab: Exclude<SessionTab, "timeline">,
  extra: Partial<Extract<Locator, { view: "session" }>> = {},
): Extract<Locator, { view: "session" }> {
  return { view: "session", tab, sid, path: null, ...extra };
}

export function parseUrl(pathname: string, search = ""): Locator {
  if (pathname === "/" || pathname === "/index.html") {
    return { view: "room", room: null, mid: null };
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "usage") {
    if (segments.length !== 1) return { view: "unknown", pathname };
    return { view: "usage", days: parseUsageDays(search) };
  }
  if (segments[0] === "r" && segments.length >= 2) {
    const room = decodeNonEmpty(segments[1] ?? "");
    if (!room || segments.length > 3) return { view: "unknown", pathname };
    if (segments.length === 2) return { view: "room", room, mid: null };
    const match = segments[2]?.match(/^m(\d+)$/);
    return match ? { view: "room", room, mid: Number(match[1]) } : { view: "unknown", pathname };
  }

  if (segments[0] !== "s" || segments.length < 2) {
    return { view: "unknown", pathname };
  }
  const sid = decodeNonEmpty(segments[1] ?? "");
  if (!sid) return { view: "unknown", pathname };
  if (segments.length === 2) return { view: "session-root", sid };

  const tab = segments[2];
  if (tab === "files" && segments.length === 3) {
    if (/%(?![0-9a-fA-F]{2})/.test(search)) return { view: "unknown", pathname };
    const params = new URLSearchParams(search);
    const path = params.get("path") || null;
    const range = params.get("lines")?.match(/^(\d+)-(\d+)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : 0;
    const lineRange = start > 0 && end >= start ? { start, end } : undefined;
    const from = params.get("from") || undefined;
    return sessionLocator(sid, "files", {
      path,
      ...(lineRange ? { lineRange } : {}),
      ...(from ? { from } : {}),
    });
  }
  if ((tab === "terminal" || tab === "status" || tab === "rooms") && segments.length === 3) {
    return sessionLocator(sid, tab);
  }
  if (tab !== "timeline" || segments.length < 4) {
    return { view: "unknown", pathname };
  }

  if (segments[3] === "agent") {
    const kind = segments[4];
    if (kind === "tm" && segments.length === 6) {
      const teammate = decodeNonEmpty(segments[5] ?? "");
      return teammate
        ? { view: "timeline", tab: "timeline", sid, position: "head", agent: { teammate } }
        : { view: "unknown", pathname };
    }
    if (kind === "sub" && segments.length === 6) {
      const agentId = decodeNonEmpty(segments[5] ?? "");
      return agentId
        ? { view: "timeline", tab: "timeline", sid, position: "head", agent: { agentId } }
        : { view: "unknown", pathname };
    }
    if (kind === "wf" && segments.length === 7) {
      const runId = decodeNonEmpty(segments[5] ?? "");
      const agentId = decodeNonEmpty(segments[6] ?? "");
      return runId && agentId
        ? {
            view: "timeline",
            tab: "timeline",
            sid,
            position: "head",
            agent: { runId, agentId },
          }
        : { view: "unknown", pathname };
    }
    return { view: "unknown", pathname };
  }

  if (segments.length === 4) {
    const position = decodeNonEmpty(segments[3] ?? "");
    if (position) return { view: "timeline", tab: "timeline", sid, position };
  }
  return { view: "unknown", pathname };
}

/** `?days=N` off the usage URL. Out-of-range and non-numeric both degrade to
 * null rather than to an unknown path: the screen is still perfectly readable
 * on the default window, and 404-ing a hand-edited number would throw away a
 * page the user can otherwise use. */
function parseUsageDays(search: string): number | null {
  if (/%(?![0-9a-fA-F]{2})/.test(search)) return null;
  const raw = new URLSearchParams(search).get("days");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= LLM_STATS_DAYS_MIN && days <= LLM_STATS_DAYS_MAX ? days : null;
}

function sidBase(sid: string): string {
  return `/s/${encodeURIComponent(sid)}`;
}

export function anchorId(roomId: string, mid: number): string {
  return `msg-${roomId}-${mid}`;
}

export function messageHref(roomId: string, mid: number): string {
  return `${roomHref(roomId)}/m${mid}`;
}

export function roomHref(roomId: string): string {
  return `/r/${encodeURIComponent(roomId)}`;
}

export function usageHref(days?: number | null): string {
  return days === undefined || days === null ? "/usage" : `/usage?days=${days}`;
}

export function sessionHref(sid: string): string {
  return sidBase(sid);
}

export function filesHref(sid: string): string {
  return `${sidBase(sid)}/files`;
}

export function fileHref(
  sid: string,
  path: string,
  lineRange?: { start: number; end: number },
  from?: string,
): string {
  const params = new URLSearchParams();
  params.set("path", path);
  if (lineRange) params.set("lines", `${lineRange.start}-${lineRange.end}`);
  if (from) params.set("from", from);
  return `${filesHref(sid)}?${params.toString()}`;
}

export function timelineHref(sid: string, position = "head"): string {
  return `${sidBase(sid)}/timeline/${encodeURIComponent(position)}`;
}

export function terminalHref(sid: string): string {
  return `${sidBase(sid)}/terminal`;
}

export function statusHref(sid: string): string {
  return `${sidBase(sid)}/status`;
}

export function sessionRoomsHref(sid: string): string {
  return `${sidBase(sid)}/rooms`;
}

export function agentTimelineHref(sid: string, ref: AgentRef): string {
  const base = `${sidBase(sid)}/timeline/agent`;
  if (ref.teammate !== undefined) return `${base}/tm/${encodeURIComponent(ref.teammate)}`;
  if (ref.agentId !== undefined) {
    const agent = encodeURIComponent(ref.agentId);
    return ref.runId !== undefined
      ? `${base}/wf/${encodeURIComponent(ref.runId)}/${agent}`
      : `${base}/sub/${agent}`;
  }
  return timelineHref(sid);
}
