import {
  agentCommunicationCount,
  isUserNavTurn,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "./transcript-model.ts";

export type TimelineOpenCategory = "U" | "R" | "T" | "A";

export interface TimelineAutoOpenSettings {
  thinking: boolean;
  agent: boolean;
  items: boolean;
}

export function defaultTimelineAutoOpen(agentTimeline: boolean): TimelineAutoOpenSettings {
  return agentTimeline
    ? { thinking: false, agent: true, items: true }
    : { thinking: true, agent: false, items: false };
}

export function toggleTimelineAutoOpen(
  settings: TimelineAutoOpenSettings,
  key: keyof TimelineAutoOpenSettings,
): TimelineAutoOpenSettings {
  return { ...settings, [key]: !settings[key] };
}

export function segmentAutoOpenCategory(segment: Segment): "T" | "A" | null {
  switch (segment.kind) {
    case "thinking":
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
    return (settings.thinking && categories.has("T")) || (settings.agent && categories.has("A"));
  });
}
