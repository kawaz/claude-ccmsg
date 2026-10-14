// The sidecar's requests and replies (DR-0035 §3), as schemas (DR-0038).
//
// The daemon writes one request per line to a session run's sidecar socket;
// the sidecar copies the line to the session's hooks module unread. The module
// answers every request it can name (one with an `id`) with one reply, which
// `ccmsg sidecar reply` carries to the daemon as a SidecarReplyRequest. A
// request names an operation (`op`), so what the module can be asked grows by
// adding ops, not by changing the line.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// parse.ts.
import * as v from "valibot";
import { jsonText, type Parsed, parseWith, type Output } from "./parse.ts";

/** The version of the request line. A module reads a line of this version
 * only. */
export const SIDECAR_REQUEST_VERSION = 1;

/** What a request and its reply are matched by: unique per request. */
export const SidecarRequestIdSchema = v.pipe(v.string(), v.nonEmpty("an id is not empty"));

// --- the run ---------------------------------------------------------------

/** What tells one run of a session from another (two harness processes of one
 * session, a resume started twice). The hooks module draws it when it is
 * loaded, which is when the run starts, and keeps it for the run's life: a
 * sidecar started again and a sidecar under a new session id (/clear,
 * /resume) name the same run. The sidecar's socket is named after it
 * (`<sid>.<run id>.sock`), and the sidecar names it to the daemon
 * (sidecar_hello). Lowercase letters and digits, so it can sit in a file name,
 * and at most 16 of them, which keeps the widest socket name inside `sun_path`
 * under the usual state dir (resolveSidecarDir). */
export const SIDECAR_RUN_ID_MAX = 16;
export const SidecarRunIdSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-z]+$/, "a run id is lowercase letters and digits"),
  v.maxLength(SIDECAR_RUN_ID_MAX, `a run id is at most ${String(SIDECAR_RUN_ID_MAX)} characters`),
);

/** A run id for a run started at `startedAt` (epoch ms): the start in base 36,
 * then digits of `random` (in [0, 1)), so two runs of a session loaded in the
 * same millisecond still differ. */
export function sidecarRunId(startedAt: number, random: number): string {
  const digits = Math.floor(random * 36 ** 8)
    .toString(36)
    .padStart(8, "0");
  return `${Math.floor(startedAt).toString(36)}${digits}`.slice(0, SIDECAR_RUN_ID_MAX);
}

// --- prompt.send -----------------------------------------------------------

/** `prompt.send`: put `text` into the session as the person's own prompt —
 * fill the composer, press Enter on the session's terminal, and keep the
 * person's half-typed draft (DR-0035 §1, §5). The text is taken verbatim and
 * must hold something other than whitespace. Fields beside `text` are left
 * out rather than refused. */
export const PromptSendArgsSchema = v.object({
  text: v.pipe(
    v.string(),
    v.check((text) => text.trim() !== "", "text holds something other than whitespace"),
  ),
});
export type PromptSendArgs = Output<typeof PromptSendArgsSchema>;

/** The reasons a session's hooks module gives for a prompt.send it could not
 * put in (the wire's SessionInputReason, but for `no_module`, which is the
 * daemon's own conclusion).
 *
 * - `dialog`: a dialog holds the keys, so the composer refused the text
 * - `no_composer`: the session draws no composer (headless)
 * - `refused`: another plugin's hook kept the text out of the composer
 * - `no_terminal`: the session was not started under hyoui, so there is no
 *   terminal to send Enter to
 * - `not_submitted`: Enter did not submit the text; the composer was put back
 *   to what the person had typed
 * - `enter_failed`: sending Enter to the terminal failed, and the text never
 *   left the composer; the composer was put back as for `not_submitted`
 * - `session_changed`: the run moved to another session id (/clear, /resume)
 *   before Enter, so the text was not put in */
export const SessionInputModuleReasonSchema = v.picklist([
  "dialog",
  "no_composer",
  "refused",
  "no_terminal",
  "not_submitted",
  "enter_failed",
  "session_changed",
]);
export type SessionInputModuleReason = Output<typeof SessionInputModuleReasonSchema>;

/** What a `prompt.send` that ran says. `accepted` means the harness raised
 * `UserPromptSubmit` for the filled text: the prompt is in the session, idle
 * or busy. `unconfirmed` is the module not knowing: Enter went out but no
 * `UserPromptSubmit` came and the composer no longer holds the text, or the
 * session changed its id (/clear, /resume) after Enter, or after the fill with
 * the composer no longer holding the text. */
export const PromptSendResultSchema = v.variant("outcome", [
  v.object({ outcome: v.literal("accepted") }),
  v.object({ outcome: v.literal("not_delivered"), reason: SessionInputModuleReasonSchema }),
  v.object({ outcome: v.literal("unconfirmed") }),
]);
export type PromptSendResult = Output<typeof PromptSendResultSchema>;

// --- describe --------------------------------------------------------------

/** The args of an op that takes none: `{}`, and a key in it or an array is
 * refused, so a caller that means more learns that this module does not do
 * it. An object schema takes an array for an object with no keys, so the
 * array is refused before it. */
const NoArgsSchema = v.pipe(
  v.unknown(),
  v.check((args) => !Array.isArray(args), "args is an object, not an array"),
  v.strictObject({}),
);

/** `describe`: what the module can be asked. It takes no arguments. */
export const DescribeArgsSchema = NoArgsSchema;
export type DescribeArgs = Output<typeof DescribeArgsSchema>;

export const DescribeResultSchema = v.object({
  /** The request versions (`v`) the module reads. */
  v: v.array(v.number()),
  /** The ops the module runs, `describe` included. */
  ops: v.array(v.string()),
  /** The ccmsg version of the plugin the module was loaded from; absent when
   * the module could not tell. */
  version: v.optional(v.string()),
});
export type DescribeResult = Output<typeof DescribeResultSchema>;

// --- session.facts ---------------------------------------------------------

/** A moment, in epoch milliseconds as the module's clock (`$.clock.now()`)
 * reads it. */
const EpochMsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** The session's context window as Claude Code itself uses it
 * (`$.session.usage().context`): `window` is the window of the model the
 * session runs now, environment overrides included. `at` is when the module
 * read it. */
export const SessionFactsContextSchema = v.object({
  window: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  at: EpochMsSchema,
});
export type SessionFactsContext = Output<typeof SessionFactsContextSchema>;

/** The API error that ended the session's latest main-thread turn, as Claude
 * Code classified it (StopFailure's `error`: `rate_limit`, `overloaded`,
 * `server_error`, `authentication_failed`, ...; `unknown` when the turn ended
 * on an error with no StopFailure before it). An open set: Claude Code names
 * the kinds. `text` is what the harness showed for it, when it said; `at` is
 * when the module saw it. */
export const SessionFactsApiErrorSchema = v.object({
  kind: v.pipe(v.string(), v.nonEmpty()),
  text: v.optional(v.string()),
  at: EpochMsSchema,
});
export type SessionFactsApiError = Output<typeof SessionFactsApiErrorSchema>;

/** What a session's hooks module knows of its session through Claude Code
 * itself (DR-0035 §3), and the transcript cannot tell, or tells late: the
 * model as the session names it (`$.session.model()`, a launch-time `[1m]`
 * kept), the context window, and whether the latest main-thread turn ended on
 * an API error (absent when it did not). The module sends the whole of it each time a part moves, so
 * the facts the daemon holds are replaced, never merged; `at` is when the
 * module put them together, and facts older than the ones held are dropped.
 * A part the module does not know yet is absent. */
export const SessionFactsSchema = v.object({
  at: EpochMsSchema,
  model: v.optional(v.pipe(v.string(), v.nonEmpty())),
  context: v.optional(SessionFactsContextSchema),
  api_error: v.optional(SessionFactsApiErrorSchema),
});
export type SessionFacts = Output<typeof SessionFactsSchema>;

/** The facts as `ccmsg sidecar facts` takes them on standard input: JSON
 * text. */
export const SessionFactsTextSchema = jsonText(SessionFactsSchema);

/** `session.facts`: the module's facts as they are now. The daemon asks it
 * when a run's sidecar names the run, which is when a daemon that started
 * after the module has none of what the module sent before. It takes no
 * arguments. */
export const SessionFactsArgsSchema = NoArgsSchema;

// --- the ops ---------------------------------------------------------------

/** Each op's arguments and result. */
export const SIDECAR_OPS = {
  describe: { args: DescribeArgsSchema, result: DescribeResultSchema },
  "prompt.send": { args: PromptSendArgsSchema, result: PromptSendResultSchema },
  "session.facts": { args: SessionFactsArgsSchema, result: SessionFactsSchema },
} as const;
export type SidecarOp = keyof typeof SIDECAR_OPS;
export type SidecarArgs<Op extends SidecarOp> = Output<(typeof SIDECAR_OPS)[Op]["args"]>;
export type SidecarResult<Op extends SidecarOp> = Output<(typeof SIDECAR_OPS)[Op]["result"]>;

/** The ops, in the order describe lists them. */
export const SIDECAR_OP_NAMES = [
  "describe",
  "prompt.send",
  "session.facts",
] as const satisfies readonly SidecarOp[];

/** The schema of a request of `op` with args read by `args`. */
type RequestSchema<
  Op extends SidecarOp,
  A extends (typeof SIDECAR_OPS)[Op]["args"],
> = v.ObjectSchema<
  {
    readonly v: v.LiteralSchema<typeof SIDECAR_REQUEST_VERSION, undefined>;
    readonly op: v.LiteralSchema<Op, undefined>;
    readonly id: typeof SidecarRequestIdSchema;
    readonly args: A;
  },
  undefined
>;

function requestSchema<const Op extends SidecarOp, A extends (typeof SIDECAR_OPS)[Op]["args"]>(
  op: Op,
  args: A,
): RequestSchema<Op, A> {
  return v.object({
    v: v.literal(SIDECAR_REQUEST_VERSION),
    op: v.literal(op),
    id: SidecarRequestIdSchema,
    args,
  });
}

/** One request to a session's hooks module. `id` is what the reply names;
 * `args` is the op's own object. */
export const SidecarRequestSchema = v.variant("op", [
  requestSchema("describe", SIDECAR_OPS.describe.args),
  requestSchema("prompt.send", SIDECAR_OPS["prompt.send"].args),
  requestSchema("session.facts", SIDECAR_OPS["session.facts"].args),
]);
export type SidecarRequest = Output<typeof SidecarRequestSchema>;
export type SidecarRequestOf<Op extends SidecarOp> = Extract<SidecarRequest, { op: Op }>;

// --- replies ---------------------------------------------------------------

/** Why a module could not finish an op, as opposed to an op that ran and
 * reports how it went inside its `result`: `internal`, the op started and
 * failed, and what it changed is unknown. */
export const SidecarErrorCodeSchema = v.picklist(["internal"]);
export type SidecarErrorCode = Output<typeof SidecarErrorCodeSchema>;

export const SidecarErrorSchema = v.object({
  code: SidecarErrorCodeSchema,
  message: v.string(),
});
export type SidecarError = Output<typeof SidecarErrorSchema>;

const FailedReplySchema = v.object({
  id: SidecarRequestIdSchema,
  ok: v.literal(false),
  error: SidecarErrorSchema,
});
export type FailedSidecarReply = Output<typeof FailedReplySchema>;

/** The schema of a reply whose result `R` reads. */
export type SidecarReplySchemaOf<R extends v.GenericSchema> = v.VariantSchema<
  "ok",
  [
    v.ObjectSchema<
      {
        readonly id: typeof SidecarRequestIdSchema;
        readonly ok: v.LiteralSchema<true, undefined>;
        readonly result: R;
      },
      undefined
    >,
    typeof FailedReplySchema,
  ],
  undefined
>;

/** A reply to one request of an op whose result is read by `result`. */
export function sidecarReplySchema<R extends v.GenericSchema>(result: R): SidecarReplySchemaOf<R> {
  return v.variant("ok", [
    v.object({ id: SidecarRequestIdSchema, ok: v.literal(true), result }),
    FailedReplySchema,
  ]);
}

/** A reply as it travels: from the module, through `ccmsg sidecar reply`, to
 * the daemon. Its `result` is the op's, and which op a reply answers is known
 * only to whoever sent the request, so the result is read there, by the op's
 * schema (`SIDECAR_OPS[op].result`), and not on the way. That keeps a result
 * of a shape one side does not know (another ccmsg version) an answer the
 * asker can act on at once, rather than a reply refused in transit and waited
 * for in vain. */
export const SidecarReplySchema = sidecarReplySchema(v.unknown());
export type SidecarReply = Output<typeof SidecarReplySchema>;

/** A reply as `ccmsg sidecar reply` takes it on standard input: JSON text. */
export const SidecarReplyTextSchema = jsonText(SidecarReplySchema);

/** The reply to a request of `Op`, with its result read. */
export type SidecarReplyOf<Op extends SidecarOp> =
  | { id: string; ok: true; result: SidecarResult<Op> }
  | FailedSidecarReply;

// --- reading a request line -------------------------------------------------

const SidecarRequestLineSchema = jsonText(SidecarRequestSchema);

/** Read one request line, once: a request of this version, of an op the
 * module runs, with that op's args. A line that is not one is a failure, and
 * nothing more is read from it: the module answers it with nothing, and the
 * daemon, getting no reply, takes the request as unconfirmed at its
 * deadline. */
export function readSidecarRequest(line: string): Parsed<SidecarRequest> {
  return parseWith(SidecarRequestLineSchema, line);
}

// --- the module's SendMessage (DR-0037 §2) ----------------------------------

/** What `ccmsg sidecar send` prints, and the hooks module hands the harness as
 * the result of a SendMessage to a `ccmsg:` address it took over (the
 * `session.send` hook's result). The model reads `reason` inside the
 * harness's "Not sent: a plugin hook refused it (<reason>)", so it says what
 * happened and what to do next. */
export const SendMessageResultSchema = v.variant("isDelivered", [
  v.object({ isDelivered: v.literal(true) }),
  v.object({
    isDelivered: v.literal(false),
    reason: v.pipe(v.string(), v.nonEmpty("a reason is not empty")),
  }),
]);
export type SendMessageResult = Output<typeof SendMessageResultSchema>;

/** The result as `ccmsg sidecar send` prints it: JSON text. */
export const SendMessageResultTextSchema = jsonText(SendMessageResultSchema);
