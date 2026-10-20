import { jsonText, type Output, parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import {
  agentCommunicationCount,
  ccmsgMessageCount,
  isUserNavTurn,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "./transcript-model.ts";

export type TimelineOpenCategory = "U" | "R" | "C" | "T" | "A" | "E";

/** The toggles of a Timeline. A stored value without `edit` keeps its other
 * toggles and reads `edit` as the Timeline's default. */
function timelineAutoOpenSettingsSchema(editDefault: boolean) {
  return v.object({
    thinking: v.boolean(),
    ccmsg: v.boolean(),
    agent: v.boolean(),
    edit: v.optional(v.boolean(), editDefault),
    items: v.boolean(),
  });
}
export type TimelineAutoOpenSettings = Output<ReturnType<typeof timelineAutoOpenSettingsSchema>>;

/** TL (親) は自セッション主体の会話 + 他セッション ccmsg も主要文脈なので
 * C=true。thinking も自セッションの思考過程として T=true。agent 通信は自身の
 * subagent 呼出の詳細なので既定は畳む。agent TL (drilldown) では逆に peer/
 * agent 通信軸を主にするため T/C を閉じ、A/items を開く (agent 通信の詳細を
 * 一目で追える方が用途に合う)。ファイルの書き換え (Edit / Write) はどちらの
 * TL でも何を変えたかを読みたいので E=true。 */
export function defaultTimelineAutoOpen(agentTimeline: boolean): TimelineAutoOpenSettings {
  return agentTimeline
    ? { thinking: false, ccmsg: false, agent: true, edit: true, items: true }
    : { thinking: true, ccmsg: true, agent: false, edit: true, items: false };
}

export function toggleTimelineAutoOpen(
  settings: TimelineAutoOpenSettings,
  key: keyof TimelineAutoOpenSettings,
): TimelineAutoOpenSettings {
  return { ...settings, [key]: !settings[key] };
}

/** localStorage key for a Timeline's auto-open toggle state, namespaced per
 * session and (for a subagent drilldown) per agent — mirrors
 * `favoritesStorageKey` / `ccmsg.1on1.<sid>` in utils.ts/session-input-store.ts
 * (`ccmsg.<feature>.<scope>` convention). The parent Timeline passes
 * `agentKey: undefined`; a drilldown Timeline passes the agent's
 * `agentId ?? runId ?? teammate` so each subagent remembers its own toggle
 * state independent of the parent session and of sibling agents. */
export function timelineAutoOpenStorageKey(sid: string, agentKey: string | undefined): string {
  return agentKey ? `ccmsg.tl.autoOpen.${sid}/${agentKey}` : `ccmsg.tl.autoOpen.${sid}`;
}

/** The stored settings of a Timeline (`localStorage` at
 * `timelineAutoOpenStorageKey`), that Timeline's defaults when nothing is
 * stored. */
function storedSettings(defaults: TimelineAutoOpenSettings) {
  const schema = v.optional(timelineAutoOpenSettingsSchema(defaults.edit), defaults);
  return { schema, text: jsonText(schema) };
}

const MAIN_SETTINGS = storedSettings(defaultTimelineAutoOpen(false));
const AGENT_SETTINGS = storedSettings(defaultTimelineAutoOpen(true));

/** Reads a raw `localStorage.getItem(timelineAutoOpenStorageKey(...))`
 * result. Nothing stored, or a value that does not read as the toggles
 * (one a prior version / a manual edit / storage corruption left behind), is
 * the Timeline's defaults: the stored value is ignored, never partially
 * applied. */
export function parseTimelineAutoOpenSettings(
  raw: string | null,
  agentTimeline: boolean,
): TimelineAutoOpenSettings {
  const stored = agentTimeline ? AGENT_SETTINGS : MAIN_SETTINGS;
  const read = raw === null ? null : parseWith(stored.text, raw);
  return read?.ok ? read.value : v.getDefault(stored.schema);
}

export function segmentAutoOpenCategory(segment: Segment): "T" | "A" | "E" | null {
  switch (segment.kind) {
    case "thinking":
    case "thinking-hidden":
      return "T";
    case "agent-send":
    case "agent-spawn":
      return "A";
    // Edit / Write の呼び出し (transcript-model.ts の toolUseSegment がカードに
    // する形)。input が読めず汎用の tool_use になった呼び出しは書き換えて
    // いないので含めない。
    case "file-edit":
    case "file-write":
      return "E";
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
  if (line.segments.some((segment) => segmentAutoOpenCategory(segment) === "E")) {
    categories.add("E");
  }
  // ccmsg boundary は通常 fold group の外側 (boundary entry) に出るが、
  // fold group 側の auto-open 判定にも同じ粒度で参加させるため、line 単位で
  // ccmsg 由来と判定できるようにしておく (kawaz r55 m11)。
  if (ccmsgMessageCount({ offset: 0, line }) > 0) categories.add("C");
  if (agentCommunicationCount({ offset: 0, line }) > 0) categories.add("A");
  return categories;
}

export function foldGroupShouldAutoOpen(
  entries: readonly TimelineEntry[],
  settings: TimelineAutoOpenSettings,
): boolean {
  if (!settings.items) return false;
  return entries.some(({ line }) => {
    const categories = autoOpenCategoriesForLine(line);
    return (
      (settings.thinking && categories.has("T")) ||
      (settings.ccmsg && categories.has("C")) ||
      (settings.agent && categories.has("A")) ||
      (settings.edit && categories.has("E"))
    );
  });
}
