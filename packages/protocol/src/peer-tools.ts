// The ccmsg tools an agent uses (DR-0039 §3) — send, say, peers — as
// schemas (DR-0038): what the model writes into each tool, what the hooks
// module hands `ccmsg sidecar send-message` / `peer-list` on standard input, and
// what those print, which is the daemon's send_message / peer_list reply.
//
// The hooks module bundles this file, so it imports nothing but valibot,
// parse.ts and response-error.ts.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";
import { ErrorResponseSchema } from "./response-error.ts";

/** The tools, as the model calls them: `mcp__<plugin>__<tool>`, the plugin's
 * name (plugin.json) the prefix. `launch` starts a session (DR-0018 §3.7);
 * its input is launch.ts's. `permit` asks the person for permission
 * (DR-0040); its input is permit-request.ts's. */
export const CCMSG_TOOLS = {
  send: "mcp__ccmsg-v1__send",
  say: "mcp__ccmsg-v1__say",
  peers: "mcp__ccmsg-v1__peers",
  launch: "mcp__ccmsg-v1__launch",
  permit: "mcp__ccmsg-v1__permit",
} as const;
export type CcmsgToolName = (typeof CCMSG_TOOLS)[keyof typeof CCMSG_TOOLS];

// --- which sessions -----------------------------------------------------------

/** The name a session was given (`--name`, a rename), matched whole. */
const PeerNameSchema = v.optional(v.pipe(v.string(), v.nonEmpty("a name is not empty")));

/** The fields that pick a send's recipients out, by their spelling in the
 * session's own record (`<config dir>/sessions/<pid>.json`): the session id,
 * the directory it works in (compared as a realpath), its name and a process
 * of it. Each is matched whole, so one send reaches only the sessions it
 * names; a field given must match, a field left out matches any session. */
const PeerTargetEntries = {
  session_id: v.optional(v.pipe(v.string(), v.nonEmpty("a session id is not empty"))),
  cwd: v.optional(v.pipe(v.string(), v.nonEmpty("a cwd is not empty"))),
  name: PeerNameSchema,
  pid: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
};

/** Whether a target names anybody: a send to every session is not one. */
function namesSomebody(to: {
  session_id?: string;
  cwd?: string;
  name?: string;
  pid?: number;
}): boolean {
  return (
    to.session_id !== undefined ||
    to.cwd !== undefined ||
    to.name !== undefined ||
    to.pid !== undefined
  );
}
const NAMES_SOMEBODY = "name the recipient by at least one of session_id, cwd, name, pid";

/** Who a send goes to: at least one field, every session that matches all of
 * the fields given. */
export const PeerTargetSchema = v.pipe(
  v.object(PeerTargetEntries),
  v.check(namesSomebody, NAMES_SOMEBODY),
);
export type PeerTarget = Output<typeof PeerTargetSchema>;

/** A message's body: delivered exactly as written, and not only whitespace. */
const PeerTextSchema = v.pipe(
  v.string(),
  v.check((text) => text.trim() !== "", "the text holds something other than whitespace"),
);

/** A running subagent of a session, by its agent id: a send that names one
 * adds the text to that subagent's conversation instead of the session's
 * (DR-0039 §3). */
const AgentIdSchema = v.optional(v.pipe(v.string(), v.nonEmpty("an agent id is not empty")));

/** What `ccmsg sidecar send-message` takes on standard input. */
export const SendMessageInputSchema = v.object({
  to: PeerTargetSchema,
  agent_id: AgentIdSchema,
  text: PeerTextSchema,
});
export type SendMessageInput = Output<typeof SendMessageInputSchema>;
export const SendMessageInputTextSchema = jsonText(SendMessageInputSchema);

/** The fields that pick the sessions `peers` lists: a prefix of the directory
 * a session works in (both compared as realpaths, so a whole repository's
 * worktrees or a whole tree come at once; the directory itself is included),
 * and its name, matched whole. */
const PeerListEntries = {
  cwd_prefix: v.optional(v.pipe(v.string(), v.nonEmpty("a cwd prefix is not empty"))),
  name: PeerNameSchema,
};

/** What `ccmsg sidecar peer-list` takes on standard input: the sessions to
 * list, all of them when neither field is given. Strict: a field it does not
 * take (a whole `cwd`, which is send's) is refused rather than dropped, which
 * would list every session. */
export const PeerListInputSchema = v.strictObject(PeerListEntries);
export type PeerListInput = Output<typeof PeerListInputSchema>;
export const PeerListInputTextSchema = jsonText(PeerListInputSchema);

// --- what came of it ------------------------------------------------------------

/** Why a session a send matched did not get it. The message is kept nowhere.
 *
 * - `self`: the send matched only the sending session
 * - `no_module`: the session runs with no hooks module (DR-0039 §7)
 * - `session_changed`: the process the named session ran in now serves
 *   another session id (/clear, /resume)
 * - `ended`: the named session is no longer running
 * - `not_running`: the send named an agent id, and no subagent of that id
 *   runs in the session now (it ended, or the id is wrong)
 * - `no_peer_socket`: the session has no peer messaging socket the daemon
 *   can write to (no state file for it in its config dir, a harness speaking
 *   another peer protocol, or no token)
 * - `no_status_socket`: the daemon could not open the socket the recipient
 *   would report a refusal to, so it wrote nothing rather than call an
 *   unconfirmable write delivered (a problem on the sending machine's side)
 * - `unreachable`: the socket took nothing (no connection, or not one byte in
 *   time), so nothing arrived
 * - `refused`: the recipient's harness answered that it did not take it
 *
 * The last four are the delivery into the session's peer socket failing
 * (DR-0036 §3); a send to a subagent says `refused` when the session's
 * module refused the append. */
export const SendMessageReasonSchema = v.picklist([
  "self",
  "no_module",
  "session_changed",
  "ended",
  "not_running",
  "no_peer_socket",
  "no_status_socket",
  "unreachable",
  "refused",
]);
export type SendMessageReason = Output<typeof SendMessageReasonSchema>;

/** A session, spelled as the fields of PeerTargetSchema take it: `cwd` is
 * the realpath, so either can be sent to again as written. */
const PeerEntries = {
  sid: v.string(),
  name: v.optional(v.string()),
  cwd: v.optional(v.string()),
};

/** What came of a send for one session it matched: `delivered` (a process of
 * it took the message), `unconfirmed` (none took it for certain, and the
 * write into one was cut off part-way, so it may have arrived), or
 * `not_delivered` and why. */
export const SendMessageResultSchema = v.variant("outcome", [
  v.object({ ...PeerEntries, outcome: v.literal("delivered") }),
  v.object({ ...PeerEntries, outcome: v.literal("unconfirmed") }),
  v.object({
    ...PeerEntries,
    outcome: v.literal("not_delivered"),
    reason: SendMessageReasonSchema,
  }),
]);
export type SendMessageResult = Output<typeof SendMessageResultSchema>;

/** send_message's reply, and what `ccmsg sidecar send-message` prints: one result
 * per session the send matched, none when it matched none. */
export const SendMessageResponseSchema = v.object({
  ok: v.literal(true),
  results: v.array(SendMessageResultSchema),
});
export type SendMessageResponse = Output<typeof SendMessageResponseSchema>;
export const SendMessageResponseTextSchema = jsonText(SendMessageResponseSchema);

/** One session a send could go to: its processes, whether it has a hooks
 * module (one without is not sent to), and whether it is the asking session. */
export const PeerListEntrySchema = v.object({
  ...PeerEntries,
  pids: v.array(v.number()),
  module: v.boolean(),
  self: v.boolean(),
});
export type PeerListEntry = Output<typeof PeerListEntrySchema>;

/** peer_list's reply, and what `ccmsg sidecar peer-list` prints. */
export const PeerListResponseSchema = v.object({
  ok: v.literal(true),
  peers: v.array(PeerListEntrySchema),
});
export type PeerListResponse = Output<typeof PeerListResponseSchema>;
export const PeerListResponseTextSchema = jsonText(PeerListResponseSchema);

/** What `ccmsg sidecar send-message` / `peer-list` and `ccmsg say` print on
 * standard error, exiting 1, when the daemon did not serve the request: its
 * refusal, whose `msg` says why in words a reader can act on. */
export const RefusalTextSchema = jsonText(ErrorResponseSchema);

// --- the tools ------------------------------------------------------------------

/** `send`'s input: who to (PeerTargetSchema's fields, at least one), the
 * running subagent of theirs to add it to when `agent_id` is given, and the
 * text. */
export const SendToolInputSchema = v.pipe(
  v.object({ ...PeerTargetEntries, agent_id: AgentIdSchema, text: PeerTextSchema }),
  v.check((input) => namesSomebody(input), NAMES_SOMEBODY),
);
export type SendToolInput = Output<typeof SendToolInputSchema>;

/** `say`'s input: what to say to the person. */
export const SayToolInputSchema = v.object({ text: PeerTextSchema });
export type SayToolInput = Output<typeof SayToolInputSchema>;

/** The `peers` tool's input: peer-list's fields, picked out of the call (the
 * engine puts its own fields beside them). */
export const PeersToolInputSchema = v.object(PeerListEntries);
export type PeersToolInput = Output<typeof PeersToolInputSchema>;
