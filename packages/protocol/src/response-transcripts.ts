// The wire's replies to transcript requests (daemon -> client), as schemas
// (DR-0038): paging a session's transcript, following its tail, and the
// browser's half of the transcript trace. response.ts joins them with the
// other topics' replies, by the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): see response-rooms.ts.
import * as v from "valibot";
import type { Output } from "./parse.ts";

export const TranscriptReadResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** complete raw jsonl lines, oldest first (client parses each as JSON) */
  lines: v.array(v.string()),
  /** byte offset of the first returned line — pass as `before` to page older;
   * 0 means the beginning of the transcript is included */
  start: v.number(),
  /** byte offset just past the last returned line's newline */
  end: v.number(),
  /** current transcript size in bytes (grows while the session runs — pass as
   * `before` later to page content that appeared after this read) */
  size: v.number(),
});
export type TranscriptReadResponse = Output<typeof TranscriptReadResponseSchema>;

export const TranscriptSubscribeResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** current transcript size — tail events start from here */
  size: v.number(),
});
export type TranscriptSubscribeResponse = Output<typeof TranscriptSubscribeResponseSchema>;

export const TranscriptUnsubscribeResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
});
export type TranscriptUnsubscribeResponse = Output<typeof TranscriptUnsubscribeResponseSchema>;

export const ClientTraceResponseSchema = v.object({
  ok: v.literal(true),
  sid: v.string(),
  /** how many of the posted points reached trace.jsonl (the daemon caps the
   * batch, so a client that sends more learns its extras were dropped). */
  written: v.number(),
});
export type ClientTraceResponse = Output<typeof ClientTraceResponseSchema>;
