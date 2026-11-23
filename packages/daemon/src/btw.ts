// btw (DR-0060): a side question or request put to a session from the webui
// as a btw comment (DR-0062 §14, comments.ts), answered by a fork of the
// session's main conversation that the session's hooks module starts
// (btw-fork.ts). This module holds what a btw's answer is made of apart from
// the comments: what the fork runs as, the anchor (the transcript's last row
// when it is asked), how its end becomes the answer's last record, and the
// words daemon.log gives its cost.
import * as fs from "node:fs";
import * as v from "valibot";
import {
  jsonText,
  launchModelFromTranscript,
  parseWith,
  spelledRunsAs,
  type ForkUsage,
  type SessionFacts,
} from "@ccmsg/protocol";
import type { BtwForkEnd } from "./btw-fork.ts";
import type { SessionLaunchContext } from "./session-search.ts";
/** The token counts of a fork's usage, in the order daemon.log names them. */
const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

/** The counts of `usage` as `name=<n>` words for a log line; none for a
 * fork that said no usage. */
export function usageLogFields(usage: ForkUsage | undefined): string[] {
  if (usage === undefined) return [];
  return USAGE_FIELDS.map((name) => `${name}=${String(usage[name])}`);
}

/** Whether a fork wrote more of the prompt cache than it read: it did not
 * start from the session's cached conversation and wrote it again, the cost a
 * btw is to avoid (DR-0060 §4). */
export function isCacheMiss(usage: ForkUsage | undefined): boolean {
  return usage !== undefined && usage.cache_creation_input_tokens > usage.cache_read_input_tokens;
}

// --- what the fork runs as (DR-0060 §6) ---

/** The context window of a session that runs on the 1M context, as the
 * module measures it (facts' `context.window`). */
const ONE_M_WINDOW = 1_000_000;

/** A model's family (`sonnet` of `claude-sonnet-5-5` and of `sonnet[1m]`), or
 * undefined for one outside the launch's vocabulary. */
function familyOf(model: string): string | undefined {
  return launchModelFromTranscript(model);
}

/** The model a btw's answer names (a fork runs on the session's own model):
 * the model id the session's main thread last answered as (`answered`, the
 * transcript's `message.model`, e.g. `claude-sonnet-5-5`), with `[1m]` when
 * the session runs on the 1M context (its own spelling, `spelled`, ends with
 * `[1m]`, or the module measured a 1M window). The id is taken from the
 * transcript, not from a table of the names, which change with Claude Code's
 * versions.
 *
 * When the transcript names no answer of the session's family (no answer
 * yet, or the session moved to another model since its last answer), the
 * session's own spelling goes as it is. */
export function btwModelOf(sources: {
  spelled: string | undefined;
  answered: string | undefined;
  window: number | undefined;
}): string | undefined {
  const { spelled, answered, window } = sources;
  const id = answered?.replace(/\[[^\]]*\]$/, "");
  const sameFamily =
    id !== undefined &&
    id.startsWith("claude-") &&
    (spelled === undefined ||
      familyOf(spelled) === undefined ||
      familyOf(spelled) === familyOf(id));
  if (!sameFamily) return spelled;
  const oneM = spelled?.endsWith("[1m]") === true || (window ?? 0) >= ONE_M_WINDOW;
  return oneM ? `${id}[1m]` : id;
}

/** What a btw's answer names as the model and the effort its fork runs at:
 * the model as btwModelOf makes it, and the effort the session's main-thread
 * requests go with now (its session override's, else its own, else its transcript's last
 * answer's; `spelledRunsAs`, the one-shot override left out). */
export function btwRunsAs(
  facts: SessionFacts | undefined,
  answered: SessionLaunchContext,
): { model?: string; effort?: string } {
  const spelled = spelledRunsAs({
    session: facts?.request_override?.session,
    own: facts,
    answered,
  });
  const model = btwModelOf({
    spelled: spelled.model,
    answered: answered.model,
    window: facts?.context?.window,
  });
  return {
    ...(model !== undefined ? { model } : {}),
    ...(spelled.effort !== undefined ? { effort: spelled.effort } : {}),
  };
}

// --- the anchor (DR-0062 P21) ---

/** Widening windows over the transcript's end: the last row with a uuid is
 * almost always in the first. */
const ANCHOR_WINDOWS = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024] as const;

const AnchorRowSchema = jsonText(
  v.looseObject({ uuid: v.optional(v.string()), isSidechain: v.optional(v.boolean()) }),
);

/** The uuid of the last row of transcript `file` that has one and is not a
 * sidechain's: where in the session a btw asked now stands. Undefined when
 * the file does not read or holds no such row. */
export async function lastRowUuid(file: string): Promise<string | undefined> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return undefined;
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return undefined;
  }
  try {
    for (const window of ANCHOR_WINDOWS) {
      const start = Math.max(0, size - window);
      const length = size - start;
      if (length <= 0) return undefined;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const lines = buffer.toString("utf-8", 0, bytesRead).split("\n");
      // A window that starts mid-file opens inside a row.
      if (start > 0) lines.shift();
      for (const line of lines.toReversed()) {
        if (!line.includes('"uuid"')) continue;
        const row = parseWith(AnchorRowSchema, line);
        if (row.ok && row.value.uuid !== undefined && row.value.isSidechain !== true) {
          return row.value.uuid;
        }
      }
      if (start === 0) return undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** How a btw ended: its fork's end, or stopped from here (`canceled`, why). */
export type BtwEnd = BtwForkEnd | { status: "canceled"; error: string };

/** Wait for `fork`'s end, or for `stopped` (resolved with why the btw was
 * stopped from here), whichever comes first: the fork is stopped in the
 * session too, and what it ends with after the stop is dropped. */
export function btwEndOrStop(fork: Promise<BtwForkEnd>, stopped: Promise<string>): Promise<BtwEnd> {
  return Promise.race([fork, stopped.then((why): BtwEnd => ({ status: "canceled", error: why }))]);
}

/** The fields of a btw's last record its end gives: the answer's text, how
 * it ended, why it did not answer, what it cost, the effort it ran at. */
export function btwEndFields(end: BtwEnd): {
  text: string;
  status: "done" | "failed" | "canceled";
  error?: string;
  usage?: ForkUsage;
  effort?: string;
} {
  if (end.status === "done") {
    return {
      text: end.text,
      status: "done",
      usage: end.usage,
      ...(end.effort !== undefined ? { effort: end.effort } : {}),
    };
  }
  if (end.status === "canceled") return { text: "", status: "canceled", error: end.error };
  return {
    text: "",
    status: "failed",
    error: end.error,
    ...(end.usage !== undefined ? { usage: end.usage } : {}),
    ...(end.effort !== undefined ? { effort: end.effort } : {}),
  };
}

/** The words of a btw's end for its log line: why it failed, and what it
 * cost (whether the fork read the session's prompt cache, DR-0060 §4). */
export function btwEndLogFields(end: BtwEnd, startedAt: number, now: number): string[] {
  return [
    ...(end.status === "failed" ? [`reason=${end.reason}`] : []),
    `elapsed_ms=${String(Math.max(0, now - startedAt))}`,
    ...(end.status !== "canceled" && end.effort !== undefined ? [`ran_effort=${end.effort}`] : []),
    ...usageLogFields(end.status === "canceled" ? undefined : end.usage),
  ];
}

/** What a btw's fork runs as, as its answer names it: the caller found it
 * out. */
export interface BtwTarget {
  /** The id the session answered as, `[1m]` kept (btwModelOf). */
  model: string | undefined;
  /** The effort the session runs at, as it spells it (DR-0060 §6). */
  effort: string | undefined;
}
