// What the model is told of ccmsg before its first turn (DR-0039 §5): once
// per conversation, put in ahead of the prompt so its request carries it,
// and again after a compaction, which summarizes it away.
import * as v from "valibot";
import { errorText, jsonText, type Output, parseWith } from "@ccmsg/protocol/parse";
import { daemonOp } from "./daemon-op.ts";
import type { Engine } from "./engine.ts";
import type { LifecycleState } from "./session-lifecycle.ts";

/** What the model is told of ccmsg before its first turn: where to read how
 * (the plugin's skill), and nothing of the tools' use itself, which is the
 * skill's to say. */
export const GUIDANCE =
  'このセッションでは ccmsg が使える。別のセッションへの送信、届いた <cross-session-message from="ccmsg:…"> への返信、見ている人への知らせ、別のセッションの起動は、先に skill ccmsg-v1:ccmsg を読んでから行う。';

/** The guidance with the URL the webui is opened at, as the line
 * `ccmsg_url: <url>` the agent's own instructions name it by; without the
 * line when the daemon told none. */
export function guidanceText(webuiUrl: string | undefined): string {
  return webuiUrl === undefined ? GUIDANCE : `${GUIDANCE}\nccmsg_url: ${webuiUrl}`;
}

/** How long the prompt waits for the daemon's `ping`, once per
 * conversation. */
export const PING_TIMEOUT_MS = 3_000;

/** The part of `ping`'s reply the guidance reads: the daemon's `webui_url`,
 * absent when it knows none. */
const PongTextSchema = jsonText(
  v.object({ ok: v.literal(true), webui_url: v.optional(v.string()) }),
);

/** The URL the webui is opened at, as the running daemon says, or undefined
 * when it says none, none runs, or it cannot be asked. Never rejects. */
async function webuiUrl($: Engine): Promise<string | undefined> {
  const asked = await daemonOp($, { op: "ping" }, { timeoutMs: PING_TIMEOUT_MS });
  if (asked.kind === "no_daemon") return undefined;
  if (asked.kind !== "answered") {
    const why = asked.kind === "outdated" ? "the daemon is older than this plugin" : asked.reason;
    $.ui.log(`ccmsg: ping not answered: ${why}`, { to: "debug" });
    return undefined;
  }
  const read = parseWith(PongTextSchema, asked.text);
  if (read.ok) return read.value.webui_url;
  $.ui.log(`ccmsg: ping not read: ${read.failure.summary}`, { to: "debug" });
  return undefined;
}

/** Whether a session's conversation holds the guidance, by session id in
 * `$.store`: a conversation's id outlives its process (`--resume`, an in-
 * session `/resume`), so a resumed one is not told again, and `/clear`
 * starts one under a new id, which is. `at` is when it was last set or
 * found, which the sweep goes by. */
const GuidedRecordSchema = v.object({ guided: v.boolean(), at: v.number() });
const GUIDED_PREFIX = "guided:";
function guidedKey(sid: string): string {
  return `${GUIDED_PREFIX}${sid}`;
}
/** How long a session's record outlives its last use: as long as ccmsg keeps
 * a session's state file. A conversation resumed after that is told again. */
export const GUIDED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How stale a record may get before a prompt that finds it in place sets
 * its time again: a write a day rather than one per prompt. */
const GUIDED_TOUCH_MS = 24 * 60 * 60 * 1000;

/** The session's record, or undefined when there is none (or one this
 * module does not read, which the next write replaces). */
async function guidedRecord(
  $: Engine,
  key: string,
): Promise<Output<typeof GuidedRecordSchema> | undefined> {
  const read = parseWith(GuidedRecordSchema, await $.store.get(key));
  return read.ok ? read.value : undefined;
}

/** Put the guidance into the conversation unless it holds it: once per
 * conversation, and again after a compaction, which summarizes it away. Not
 * for a session with no composer (`-p`, the SDK), which the tools are not
 * registered for either. Never rejects: without it the session runs as
 * before. */
export async function guide($: Engine, state: Pick<LifecycleState, "interactive">): Promise<void> {
  if (state.interactive !== true) return;
  try {
    const key = guidedKey(await $.session.id());
    const now = Math.floor(await $.clock.now());
    const held = await guidedRecord($, key);
    if (held?.guided === true) {
      if (now - held.at > GUIDED_TOUCH_MS) await $.store.set(key, { guided: true, at: now });
      return;
    }
    const text = guidanceText(await webuiUrl($));
    await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
    await $.store.set(key, { guided: true, at: now });
  } catch (e) {
    $.ui.log(`ccmsg: guidance not added: ${errorText(e)}`, { to: "debug" });
  }
}

/** A compaction summarized the guidance away: the next prompt adds it back
 * (appended during the compaction it would land before the boundary and be
 * dropped, DR-0039 §5). Never rejects. */
export async function unguide($: Engine): Promise<void> {
  try {
    const key = guidedKey(await $.session.id());
    await $.store.set(key, { guided: false, at: Math.floor(await $.clock.now()) });
  } catch (e) {
    $.ui.log(`ccmsg: could not mark the guidance for after the compaction: ${errorText(e)}`, {
      to: "debug",
    });
  }
}

/** Remove the records of sessions not used for GUIDED_TTL_MS, and those this
 * module does not read. Never rejects. */
export async function sweepGuided($: Engine): Promise<void> {
  try {
    const now = Math.floor(await $.clock.now());
    for (const key of await $.store.keys()) {
      if (!key.startsWith(GUIDED_PREFIX)) continue;
      const held = await guidedRecord($, key);
      if (held === undefined || now - held.at > GUIDED_TTL_MS) await $.store.delete(key);
    }
  } catch (e) {
    $.ui.log(`ccmsg: guidance records not swept: ${errorText(e)}`, { to: "debug" });
  }
}
