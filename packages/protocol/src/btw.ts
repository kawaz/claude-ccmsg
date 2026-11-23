// A btw (DR-0060): a side question or request a person puts to a session from
// the webui, answered by a fork of the session (`claude -p --resume <sid>
// --fork-session --no-session-persistence`) the daemon starts as a print
// launch of the launch command (DR-0064), and kept out of the session's own
// conversation. As schemas (DR-0038): the record of one btw, the two ops and
// the two pushes; what the launch command is handed is launch.ts'
// LaunchCommandInputSchema.
//
// Imports nothing but valibot and the schema files beside it, as the other
// schema files.
import * as v from "valibot";
import { LaunchEffortSchema } from "./launch.ts";
import { jsonText, type Output } from "./parse.ts";
import { ForkUsageSchema } from "./sidecar.ts";

/** How many btws may run at once, across the daemon (DR-0060 §6): one more is
 * refused with `btw_busy`. Each is a claude process with a model request. */
export const BTW_MAX_CONCURRENCY = 4;

/** What goes before the person's text in the btw's prompt (DR-0060 §3). The
 * fork is a subagent that starts from the session's conversation with this
 * prompt as its task, and holds the session's tools. */
export const BTW_PROMPT_PREFIX = [
  "<btw>",
  "これは btw (本体の会話の横道) です。ここまでの会話の文脈を踏まえて、下の質問・依頼に答えてください。このやりとりは本体の会話には残らず、答えは人が webui で直接読みます。",
  "- 下の質問・依頼に頼まれたことだけをする。依頼に無い本体の作業の続きはしない",
  "- 答えは親のエージェントへの報告でなく、質問した人が直接読む答えとして、質問した人の言語で書く (課題の言い直しの行や報告の見出しを付けない)",
  "- 本体は止まっていない。本体は独立に作業を続けていて、turn の途中ならまだ作業している (書きかけの分はここに見えない)",
  "- 既定では say / PushNotification / ccmsg の send・comment_reply 等で人や他のセッションに知らせず、結果は答えの本文に書く (依頼に知らせ方の指示があればそれに従う)",
  "</btw>",
].join("\n");

/** The whole prompt of a btw: the prefix, then the person's text as written. */
export function btwPrompt(text: string): string {
  return `${BTW_PROMPT_PREFIX}\n\n${text}`;
}

/** Where a btw stands: its fork runs, answered, failed, or was stopped. */
export const BtwStatusSchema = v.picklist(["running", "done", "failed", "canceled"]);
export type BtwStatus = Output<typeof BtwStatusSchema>;

/** One btw (DR-0060 §4). The daemon keeps it in the session's
 * `<stateDir>/sessions/<sid>.btw.jsonl`, pushes it to the tabs that follow the
 * session, and the webui draws it after the row its anchor names. */
export const BtwRecordSchema = v.object({
  /** A UUIDv4 the daemon gave it. */
  id: v.string(),
  /** The session it was asked of. */
  session_id: v.string(),
  /** When the daemon took the ask, ISO. */
  ts: v.string(),
  /** The anchor: the uuid of the last row (not a sidechain's) the session's
   * transcript held when the daemon took the ask. Absent when it held none. */
  after_uuid: v.optional(v.string()),
  /** What the person wrote, without the prefix. */
  prompt: v.string(),
  /** The fork's answer: the text blocks of its main conversation, in order. */
  response: v.string(),
  status: BtwStatusSchema,
  /** The model and the effort the fork was started with (the print launch's
   * `model` / `effort`); absent for one it was not. */
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  /** The tool the fork runs now, while it runs. Not kept on disk. */
  tool: v.optional(v.string()),
  /** When it stopped running, ISO. */
  ended_at: v.optional(v.string()),
  /** Why it failed or was stopped. */
  error: v.optional(v.string()),
  /** What the fork cost, as the session's module said (its turn's requests
   * summed); absent until it ended, and for one that said none. */
  usage: v.optional(ForkUsageSchema),
});
export type BtwRecord = Output<typeof BtwRecordSchema>;

/** A line of `<sid>.btw.jsonl`. */
export const BtwRecordLineSchema = jsonText(BtwRecordSchema);

/** Put a btw to session `session_id` (user role only, DR-0060 §6). The daemon
 * starts the fork and answers with the btw's record as it starts; the
 * answer comes by ev:"btw". `effort` is the one the person chose for it,
 * absent for the one the session runs as. */
export const BtwAskRequestSchema = v.object({
  op: v.literal("btw_ask"),
  session_id: v.pipe(v.string(), v.nonEmpty("Expected a session id, not an empty string")),
  prompt: v.pipe(
    v.string(),
    v.check((text) => text.trim() !== "", "Expected a question or a request, not an empty text"),
  ),
  effort: v.optional(LaunchEffortSchema),
});
export type BtwAskRequest = Output<typeof BtwAskRequestSchema>;

/** Stop the btw `id` (user role only, DR-0060 §6). One that already ended is
 * left as it is; an id with no record is `not_found`. */
export const BtwCancelRequestSchema = v.object({
  op: v.literal("btw_cancel"),
  id: v.pipe(v.string(), v.nonEmpty("Expected a btw id, not an empty string")),
});
export type BtwCancelRequest = Output<typeof BtwCancelRequestSchema>;

export const BtwAskResponseSchema = v.object({
  ok: v.literal(true),
  btw: BtwRecordSchema,
});
export type BtwAskResponse = Output<typeof BtwAskResponseSchema>;

export const BtwCancelResponseSchema = v.object({ ok: v.literal(true) });
export type BtwCancelResponse = Output<typeof BtwCancelResponseSchema>;

/** Every btw of session `session_id` the daemon holds, oldest first (DR-0060
 * §5): sent to a tab when it begins to follow the session's Timeline
 * (transcript_subscribe), even when there are none. */
export const BtwsStreamEventSchema = v.object({
  ev: v.literal("btws"),
  session_id: v.string(),
  btws: v.array(BtwRecordSchema),
});
export type BtwsStreamEvent = Output<typeof BtwsStreamEventSchema>;

/** One btw as it is now, sent to the tabs that follow its session whenever it
 * changes (DR-0060 §5): a tab replaces what it held of that id. */
export const BtwStreamEventSchema = v.object({
  ev: v.literal("btw"),
  btw: BtwRecordSchema,
});
export type BtwStreamEvent = Output<typeof BtwStreamEventSchema>;

/** The `entrypoint`s of Claude Code's `sessions/<pid>.json` that name a
 * session no person types into: `claude -p` (`sdk-cli`, a btw's fork among
 * them) and the SDKs. The webui puts their rows apart (DR-0060 §11). */
export const SDK_ENTRYPOINTS: ReadonlySet<string> = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

/** Whether a session started from `entrypoint` is one a person types into.
 * A session whose record names none is taken as one. */
export function isInteractiveEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint === undefined || !SDK_ENTRYPOINTS.has(entrypoint);
}
