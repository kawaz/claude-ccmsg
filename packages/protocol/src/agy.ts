// The `agy` tool (DR-0066): an agent's conversations with agy, Antigravity's
// CLI, kept by the daemon. One tool whose `op` names the act (run / status /
// abort, Q10); the model is shown one object of the fields' types (§3), and
// which fields go with which call is the handler's to read here
// (`readAgyCall`), as `launch` keeps its combinations (DR-0018 §3.2).
import * as v from "valibot";
import { JsonValueSchema } from "./json-value.ts";
import { jsonText, type Output, type Parsed, parseWith } from "./parse.ts";

/** agy's `--effort` values (A15). */
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const AgyEffortSchema = v.picklist(AGY_EFFORTS);
export type AgyEffort = Output<typeof AgyEffortSchema>;

/** The longest agyid in bytes (§4). */
export const AGYID_MAX_BYTES = 250;

/** An agyid: agy's own conversation id (K9), taken as a text of no assumed
 * shape. Checked only for what the daemon uses it for, the name of its
 * directory and an argument it compares (§4): not empty, no `/` and no
 * control character, at most AGYID_MAX_BYTES bytes. */
export const AgyIdSchema = v.pipe(
  v.string(),
  v.nonEmpty("agyid は空にできない"),
  v.check((id) => !/[/\p{Cc}]/u.test(id), "agyid に / と制御文字は書けない"),
  v.check(
    (id) => new TextEncoder().encode(id).length <= AGYID_MAX_BYTES,
    `agyid は ${String(AGYID_MAX_BYTES)} bytes まで`,
  ),
);

const AbsolutePathSchema = v.pipe(
  v.string(),
  v.check((p) => p.startsWith("/"), "絶対パスで指定する"),
);

/** "Not given" is the field's absence alone, so an empty text is refused. */
const NonEmptySchema = v.pipe(
  v.string(),
  v.minLength(1, "空にはできない (指定しない時は field ごと書かない)"),
);

/** A directory agy is shown (`--add-dir`). `write` is required so the caller
 * says the directory may be written (§11); the host version takes only
 * `write: true` without `containerpath` (Q4), which the daemon checks. */
export const AgyDirSchema = v.strictObject({
  path: AbsolutePathSchema,
  containerpath: v.optional(AbsolutePathSchema),
  write: v.boolean(),
});
export type AgyDir = Output<typeof AgyDirSchema>;

const SeqSchema = v.pipe(v.number(), v.integer("seq は整数"), v.minValue(1, "seq は 1 から"));

/** The tool's fields, each by its type: what the model is shown (§3). */
export const AgyFieldsSchema = v.object({
  op: v.picklist(["run", "status", "abort"]),
  agyid: v.optional(AgyIdSchema),
  seq: v.optional(SeqSchema),
  prompt: v.optional(NonEmptySchema),
  model: v.optional(NonEmptySchema),
  effort: v.optional(AgyEffortSchema),
  cwd: v.optional(AbsolutePathSchema),
  dirs: v.optional(v.array(AgyDirSchema)),
  verbose: v.optional(v.boolean()),
});

/** A field this call takes none of, named in the refusal. */
const NOT_FOR_THIS_CALL = "この呼び出しには書けない field";

/** run, a new conversation: `prompt` and `model` (K2). */
export const AgyRunNewSchema = v.strictObject(
  {
    prompt: NonEmptySchema,
    model: NonEmptySchema,
    effort: v.optional(AgyEffortSchema),
    cwd: v.optional(AbsolutePathSchema),
    dirs: v.optional(v.array(AgyDirSchema)),
    verbose: v.optional(v.boolean()),
  },
  NOT_FOR_THIS_CALL,
);
export type AgyRunNew = Output<typeof AgyRunNewSchema>;

/** run, the conversation `agyid` goes on: what it started with is the
 * record's (K4), so `model` and the rest are refused rather than dropped
 * (§3). */
export const AgyRunMoreSchema = v.strictObject(
  { agyid: AgyIdSchema, prompt: NonEmptySchema, verbose: v.optional(v.boolean()) },
  NOT_FOR_THIS_CALL,
);
export type AgyRunMore = Output<typeof AgyRunMoreSchema>;

/** status of one conversation, of its request `seq` or its latest result. */
export const AgyStatusOneSchema = v.strictObject(
  { agyid: AgyIdSchema, seq: v.optional(SeqSchema), verbose: v.optional(v.boolean()) },
  NOT_FOR_THIS_CALL,
);
export type AgyStatusOne = Output<typeof AgyStatusOneSchema>;

/** status without an agyid: the asking session's conversations (Q15). */
export const AgyStatusListSchema = v.strictObject({}, NOT_FOR_THIS_CALL);

/** abort of the conversation's running turn. */
export const AgyAbortSchema = v.strictObject({ agyid: AgyIdSchema }, NOT_FOR_THIS_CALL);
export type AgyAbort = Output<typeof AgyAbortSchema>;

/** One call of the tool, by what it asks. */
export type AgyCall =
  | { readonly op: "run"; readonly run: AgyRunNew | AgyRunMore }
  | { readonly op: "status"; readonly status: AgyStatusOne | null }
  | { readonly op: "abort"; readonly abort: AgyAbort };

/** A call's fields read for the call they make (§3's table): the row is
 * chosen by `op` and whether `agyid` is written, and the fields are then read
 * by that row's strict schema, so a field the row does not take is refused
 * by name. */
export function readAgyCall(fields: Output<typeof AgyFieldsSchema>): Parsed<AgyCall> {
  const { op, ...rest } = fields;
  const hasId = rest.agyid !== undefined;
  switch (op) {
    case "run": {
      const read = hasId ? parseWith(AgyRunMoreSchema, rest) : parseWith(AgyRunNewSchema, rest);
      return read.ok ? { ok: true, value: { op, run: read.value } } : read;
    }
    case "status": {
      if (!hasId) {
        const read = parseWith(AgyStatusListSchema, rest);
        return read.ok ? { ok: true, value: { op, status: null } } : read;
      }
      const read = parseWith(AgyStatusOneSchema, rest);
      return read.ok ? { ok: true, value: { op, status: read.value } } : read;
    }
    case "abort": {
      const read = parseWith(AgyAbortSchema, rest);
      return read.ok ? { ok: true, value: { op, abort: read.value } } : read;
    }
  }
}

// --- the daemon's ops (session role, §3) ------------------------------------

const AgentIdSchema = v.pipe(v.string(), v.nonEmpty("an agent id is not empty"));

export const AgyRunRequestSchema = v.object({
  op: v.literal("agy_run"),
  run: v.union([AgyRunMoreSchema, AgyRunNewSchema]),
  agent_id: v.optional(AgentIdSchema),
});
export type AgyRunRequest = Output<typeof AgyRunRequestSchema>;

export const AgyStatusRequestSchema = v.object({
  op: v.literal("agy_status"),
  status: v.nullable(AgyStatusOneSchema),
});
export type AgyStatusRequest = Output<typeof AgyStatusRequestSchema>;

export const AgyAbortRequestSchema = v.object({
  op: v.literal("agy_abort"),
  abort: AgyAbortSchema,
});
export type AgyAbortRequest = Output<typeof AgyAbortRequestSchema>;

/** A run taken: the request's number in the conversation, and how many
 * requests written before it have no result yet (§6). */
export const AgyRunResponseSchema = v.object({
  ok: v.literal(true),
  agyid: AgyIdSchema,
  seq: v.number(),
  ahead: v.number(),
});
export type AgyRunResponse = Output<typeof AgyRunResponseSchema>;
export const AgyRunResponseTextSchema = jsonText(AgyRunResponseSchema);

/** agy's token counts as `result.usage` carries them, the fields ccmsg reads
 * and any other agy adds kept as numbers. */
export const AgyUsageSchema = v.record(v.string(), v.number());
export type AgyUsage = Output<typeof AgyUsageSchema>;

/** How a request ended without a `result` (§4, §10). */
export const AgyEndErrorSchema = v.picklist([
  "no_response",
  "unconfirmed_write",
  "aborted_unstarted",
]);
export type AgyEndError = Output<typeof AgyEndErrorSchema>;

/** A request's result as status says it (§8): the minimal fields, and with
 * `verbose` the request's own usage, time and refused tools. */
export const AgyResultViewSchema = v.object({
  seq: v.number(),
  at: v.string(),
  status: v.optional(v.string()),
  finished_reason: v.optional(v.string()),
  response: v.optional(v.string()),
  error: v.optional(v.string()),
  usage: v.optional(AgyUsageSchema),
  duration_seconds: v.optional(v.number()),
  denied_actions: v.optional(v.array(JsonValueSchema)),
});
export type AgyResultView = Output<typeof AgyResultViewSchema>;

/** status of one conversation (§8). */
export const AgyStatusOneResponseSchema = v.object({
  ok: v.literal(true),
  agyid: AgyIdSchema,
  process: v.picklist(["running", "none"]),
  pending: v.number(),
  undelivered: v.array(v.number()),
  result: v.optional(AgyResultViewSchema),
  model: v.optional(v.string()),
  effort: v.optional(AgyEffortSchema),
  cwd: v.optional(v.string()),
  dirs: v.optional(v.array(AgyDirSchema)),
  created_at: v.optional(v.string()),
  usage_total: v.optional(AgyUsageSchema),
  idle_seconds: v.optional(v.number()),
  quota: v.optional(v.object({ text: v.string(), at: v.string() })),
});
export type AgyStatusOneResponse = Output<typeof AgyStatusOneResponseSchema>;

/** The most conversations status without an agyid lists (Q15). */
export const AGY_LIST_MAX = 10;

/** status without an agyid: the asking session's conversations, newest
 * first (§6, Q15). */
export const AgyStatusListResponseSchema = v.object({
  ok: v.literal(true),
  conversations: v.array(
    v.object({ agyid: AgyIdSchema, created_at: v.string(), pending: v.number() }),
  ),
});
export type AgyStatusListResponse = Output<typeof AgyStatusListResponseSchema>;

export const AgyStatusResponseSchema = v.union([
  AgyStatusOneResponseSchema,
  AgyStatusListResponseSchema,
]);
export type AgyStatusResponse = Output<typeof AgyStatusResponseSchema>;
export const AgyStatusResponseTextSchema = jsonText(AgyStatusResponseSchema);

/** What an abort came to (§9). */
export const AgyAbortResponseSchema = v.object({
  ok: v.literal(true),
  outcome: v.picklist(["aborted", "no_turn", "unconfirmed"]),
  detail: v.optional(v.string()),
});
export type AgyAbortResponse = Output<typeof AgyAbortResponseSchema>;
export const AgyAbortResponseTextSchema = jsonText(AgyAbortResponseSchema);

// --- what is delivered (§7) ---------------------------------------------------

/** The mark line above a response appended into the asking conversation
 * (K11). */
export function agyMark(agyid: string): string {
  return `agyid:${agyid} から:`;
}

/** The sender of the wake that follows every append (K14, K16): a notice of
 * no content, not answered. Not a session id's shape, like the daemon's own. */
export const AGY_WAKEUP_SENDER = "wakeup";

/** The wake's whole text (K14). */
export const AGY_WAKEUP_TEXT = ".";

/** A response at or above this many bytes is kept in a file and delivered as
 * its path (§7, Q7), as `launch` keeps its output (DR-0018 §3.6). */
export const AGY_RESPONSE_INLINE_MAX_BYTES = 4096;

/** How long the daemon waits for `init` before it stops a start (§6). */
export const AGY_INIT_WAIT_MS = 15_000;

/** How long an abort waits for the turn to end (§9). */
export const AGY_ABORT_WAIT_MS = 5_000;

// --- refusals, in words (§6's table) -------------------------------------------

/** The error codes of the agy ops, beside the protocol's general ones. */
export const AgyErrorCode = {
  /** No `agy` section in the daemon config. */
  agy_not_configured: "agy_not_configured",
  /** An agyid the daemon has no record of (Q12). */
  agy_unknown_conversation: "agy_unknown_conversation",
  /** A `dirs` entry the host version cannot keep (Q4). */
  agy_dirs_unsupported: "agy_dirs_unsupported",
  /** agy did not start, gave no `init` in time, or ended before it. */
  agy_not_started: "agy_not_started",
  /** A resumed conversation's `init` names another id (A1). */
  agy_conversation_mismatch: "agy_conversation_mismatch",
  /** A process the daemon cannot write to has the conversation open (Q6). */
  agy_conversation_busy: "agy_conversation_busy",
  /** Two processes opened it and the daemon's own was the later (K13). */
  agy_duplicate_stopped: "agy_duplicate_stopped",
  /** The daemon is shutting down (§10). */
  agy_shutting_down: "agy_shutting_down",
} as const;

/** What the tool says of a refused agy op: the daemon's reason, and what to
 * do next (§6). */
export function agyRefusalText(code: string, msg: string): string {
  switch (code) {
    case AgyErrorCode.agy_not_configured:
      return `agy は設定されていない (${msg})。人が daemon の config に agy の節を足す`;
    case AgyErrorCode.agy_unknown_conversation:
      return `この daemon が発行した agyid ではない (${msg})。agyid を確かめる (分からなければ agyid を付けない status)。新しい会話なら agyid を付けずに model (要れば effort も) を書く`;
    case AgyErrorCode.agy_dirs_unsupported:
      return `ホストで動く版では守れない dirs があるので何もしていない: ${msg}。書かれてよいなら write: true にし containerpath を外す。困るなら写しを作って渡す`;
    case AgyErrorCode.agy_not_started:
      return `会話は始まっていない: ${msg}。利用枠なら時間を置いて短い依頼で確かめるか別の系統のモデルで始める (agy の言う戻りの時間は当てにならない)。authentication failed or timed out なら人が端末で agy を 1 回起こしてサインインする。invalid model selection 等なら model と effort の組み合わせを書き直す`;
    case AgyErrorCode.agy_conversation_mismatch:
      return `agy がこの会話を見つけられなかった (${msg})。新しい会話として run し直す`;
    case AgyErrorCode.agy_conversation_busy:
      return `daemon が依頼を書けないプロセスがこの会話を開いているので何もしていない: ${msg}。前の daemon が起こしたものなら応答が届くのを待って run し直す (急ぐなら abort)。ccmsg の外のものなら、それを終えてから run し直す`;
    case AgyErrorCode.agy_duplicate_stopped:
      return `同じ会話のプロセスが 2 つ起き、後から起きたこちらを止めたので依頼は書いていない (${msg})。run し直す`;
    case AgyErrorCode.agy_shutting_down:
      return `ccmsg の daemon が終わりかけているので何もしていない。少し待って呼び直す`;
    case "invalid_args":
      return `agy の入力が形に合わないので何もしていない: ${msg}`;
    case "internal":
      return `受け付けたか確かめられなかった: ${msg}。同じ依頼を投げ直さず、status で確かめる`;
    default:
      return `ccmsg の daemon が断ったので何もしていない (${code}): ${msg}`;
  }
}
