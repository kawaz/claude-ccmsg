import {
  agentCommunicationCount,
  ccmsgMessageCount,
  isUserNavTurn,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "./transcript-model.ts";

export type TimelineOpenCategory = "U" | "R" | "C" | "T" | "A";

export interface TimelineAutoOpenSettings {
  thinking: boolean;
  ccmsg: boolean;
  agent: boolean;
  items: boolean;
}

/** TL (親) は自セッション主体の会話 + 他セッション ccmsg も主要文脈なので
 * C=true。thinking も自セッションの思考過程として T=true。agent 通信は自身の
 * subagent 呼出の詳細なので既定は畳む。agent TL (drilldown) では逆に peer/
 * agent 通信軸を主にするため T/C を閉じ、A/items を開く (agent 通信の詳細を
 * 一目で追える方が用途に合う)。 */
export function defaultTimelineAutoOpen(agentTimeline: boolean): TimelineAutoOpenSettings {
  return agentTimeline
    ? { thinking: false, ccmsg: false, agent: true, items: true }
    : { thinking: true, ccmsg: true, agent: false, items: false };
}

export function toggleTimelineAutoOpen(
  settings: TimelineAutoOpenSettings,
  key: keyof TimelineAutoOpenSettings,
): TimelineAutoOpenSettings {
  return { ...settings, [key]: !settings[key] };
}

/** localStorage key for a Timeline's auto-open toggle state, namespaced per
 * session and (for a subagent drilldown) per agent — mirrors
 * `favoritesStorageKey` / `ccmsg.1on1.<sid>` in utils.ts/OneOnOneComposer.tsx
 * (`ccmsg.<feature>.<scope>` convention). The parent Timeline passes
 * `agentKey: undefined`; a drilldown Timeline passes the agent's
 * `agentId ?? runId ?? teammate` so each subagent remembers its own toggle
 * state independent of the parent session and of sibling agents. */
export function timelineAutoOpenStorageKey(sid: string, agentKey: string | undefined): string {
  return agentKey ? `ccmsg.tl.autoOpen.${sid}/${agentKey}` : `ccmsg.tl.autoOpen.${sid}`;
}

/** Parses a raw `localStorage.getItem(timelineAutoOpenStorageKey(...))`
 * result, tolerating anything a prior schema version / manual edit / storage
 * corruption could have left behind: absent key, non-JSON, non-object JSON,
 * or an object missing/mistyping any of the four boolean fields all fall
 * back to `fallback` (the timeline's default settings) rather than throwing
 * or partially applying a corrupt value — same posture as `parseFavorites`
 * in utils.ts. */
export function parseTimelineAutoOpenSettings(
  raw: string | null,
  fallback: TimelineAutoOpenSettings,
): TimelineAutoOpenSettings {
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const candidate = parsed as Record<string, unknown>;
  const keys: (keyof TimelineAutoOpenSettings)[] = ["thinking", "ccmsg", "agent", "items"];
  if (!keys.every((key) => typeof candidate[key] === "boolean")) return fallback;
  return {
    thinking: candidate.thinking as boolean,
    ccmsg: candidate.ccmsg as boolean,
    agent: candidate.agent as boolean,
    items: candidate.items as boolean,
  };
}

export function segmentAutoOpenCategory(segment: Segment): "T" | "A" | null {
  switch (segment.kind) {
    case "thinking":
    case "thinking-hidden":
      return "T";
    case "agent-send":
    case "agent-spawn":
      return "A";
    default:
      return null;
  }
}

export function autoOpenCategoriesForLine(line: ParsedLine): ReadonlySet<TimelineOpenCategory> {
  const categories = new Set<TimelineOpenCategory>();
  if (line.kind !== "turn") return categories;
  if (isUserNavTurn(line)) categories.add("U");
  if (line.role === "assistant" && line.segments.some((segment) => segment.kind === "text")) {
    categories.add("R");
  }
  if (line.segments.some((segment) => segmentAutoOpenCategory(segment) === "T")) {
    categories.add("T");
  }
  // ccmsg boundary は通常 fold group の外側 (boundary entry) に出るが、
  // fold group 側の auto-open 判定にも同じ粒度で参加させるため、line 単位で
  // ccmsg 由来と判定できるようにしておく (kawaz r55 m11)。
  if (ccmsgMessageCount({ offset: 0, line }) > 0) categories.add("C");
  if (agentCommunicationCount({ offset: 0, line }) > 0) categories.add("A");
  return categories;
}

export function foldGroupShouldAutoOpen(
  entries: TimelineEntry[],
  settings: TimelineAutoOpenSettings,
): boolean {
  if (!settings.items) return false;
  return entries.some(({ line }) => {
    const categories = autoOpenCategoriesForLine(line);
    return (
      (settings.thinking && categories.has("T")) ||
      (settings.ccmsg && categories.has("C")) ||
      (settings.agent && categories.has("A"))
    );
  });
}
