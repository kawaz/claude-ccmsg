// The wire's transcript requests (client -> daemon), as schemas (DR-0038):
// reading and following a session's transcript, and the browser's half of
// the transcript trace. request.ts joins them into one request and reads a
// line with them.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/**
 * Session transcript access (DR-0009 / DR-0021): read a slice of a connected
 * session's hello-validated transcript, or a historical UUID resolved by the
 * daemon below detected config dirs. There is NO client-supplied path, so no
 * traversal surface exists. Paging is by byte offset, aligned to line
 * boundaries, so a multi-hundred-MB transcript never needs a full scan or a
 * line index: the viewer starts from the tail (`before` absent) and pages older
 * by passing the previous reply's `start`, and catches up with what was
 * appended since by passing the previous reply's `end` as `after`.
 */
export const TranscriptReadRequestSchema = v.object({
  op: v.literal("transcript_read"),
  sid: v.string(),
  /** read lines that END at or before this byte offset (exclusive); absent = file end */
  before: v.optional(v.number()),
  /** read lines that START at or after this byte offset — the `end` of a
   * previous reply (or of a live-tail push) — up to the cap, oldest first.
   * The reply's `start` is `after` when the file continues from there; any
   * other `start` means it does not (the offset is past the file's end, is
   * not at a line's start, or starts a line too long to return), and the
   * reply holds no lines. An `end` short of
   * `size` means more follows: pass it as the next `after`. Not with
   * `before`. */
  after: v.optional(v.number()),
  /** cap on returned line bytes; absent = the clamp itself, which is
   * TRANSCRIPT_READ_OLDER_MAX_BYTES with `before` and TRANSCRIPT_READ_MAX_BYTES
   * otherwise */
  max_bytes: v.optional(v.number()),
  /** DR-0025 Phase 1: read a subagent / workflow-agent / teammate transcript
   * that lives under `<sid>`'s sibling directory instead of `<sid>`'s own
   * transcript. User role only; strictly validated by the daemon-side
   * resolver (`AGENT_ID_RE` / `RUN_ID_RE` / `TEAMMATE_NAME_RE` reject any
   * character that could form a traversal). Mutually exclusive with
   * `teammate`; `run_id` only makes sense with `agent_id`. */
  agent_id: v.optional(v.string()),
  /** DR-0025 Phase 1: workflow run id (`wf_XXXXXXXX-XXX`) that owns the
   * `agent_id`. Absent = the agent is a direct child of `<sid>` (bare
   * `subagents/agent-*.jsonl`). Ignored when `agent_id` is absent. */
  run_id: v.optional(v.string()),
  /** DR-0025 Phase 1: teammate name whose transcript should be resolved via
   * `subagents/agent-*.meta.json` scan (the transcript-side `teammate_id` is
   * `name@team`, so it cannot be reused as a filename hash). Mutually
   * exclusive with `agent_id`. */
  teammate: v.optional(v.string()),
});
export type TranscriptReadRequest = Output<typeof TranscriptReadRequestSchema>;

/** Follow a connected session's transcript live (user role only): after this,
 * appended complete lines arrive as `ev:"transcript"` events on this
 * connection's subscribe stream until transcript_unsubscribe / disconnect.
 * Same no-traversal property as transcript_read — the daemon only ever tails
 * the hello-validated transcript of `sid`. */
export const TranscriptSubscribeRequestSchema = v.object({
  op: v.literal("transcript_subscribe"),
  sid: v.string(),
});
export type TranscriptSubscribeRequest = Output<typeof TranscriptSubscribeRequestSchema>;

export const TranscriptUnsubscribeRequestSchema = v.object({
  op: v.literal("transcript_unsubscribe"),
  sid: v.string(),
});
export type TranscriptUnsubscribeRequest = Output<typeof TranscriptUnsubscribeRequestSchema>;

/** One boundary the browser timed: when a transcript delivery reached the
 * socket (`ws_receive`), the store (`store_dispatch`) and the DOM
 * (`dom_commit`), on the browser's own clock. */
export const ClientTracePointSchema = v.object({
  ts: v.string(),
  comp: v.literal("webui"),
  edge: v.picklist(["in", "out"]),
  kind: v.picklist(["ws_receive", "store_dispatch", "dom_commit"]),
});
export type ClientTracePoint = Output<typeof ClientTracePointSchema>;

/** Browser-side transcript boundary timestamps returned to the daemon so one
 * trace.jsonl contains the complete file-to-DOM path. User role only. */
export const ClientTraceRequestSchema = v.object({
  op: v.literal("client_trace"),
  sid: v.string(),
  start: v.number(),
  end: v.number(),
  size: v.number(),
  sampled: v.boolean(),
  elapsed_ms: v.number(),
  points: v.array(ClientTracePointSchema),
});
export type ClientTraceRequest = Output<typeof ClientTraceRequestSchema>;
