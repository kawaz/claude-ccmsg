// The ccmsg tools an agent uses (DR-0039 §3) — send, say, peers — as
// schemas (DR-0038): what the model writes into each tool, what the hooks
// module asks the daemon with them (send_message / peer_list over `POST /op`,
// DR-0046), and the daemon's reply.
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

/** A send's recipient: one session, by its id. A send reaches the session it
 * names and no other; to reach several, send to each id `peers` lists. */
const PeerTargetEntries = {
  session_id: v.pipe(v.string(), v.nonEmpty("a session id is not empty")),
};

/** Who a send goes to. Strict: a field it does not take (a `cwd`, a `name`)
 * is refused rather than dropped, which would send by the id alone what was
 * meant for others. */
export const PeerTargetSchema = v.strictObject(PeerTargetEntries);
export type PeerTarget = Output<typeof PeerTargetSchema>;

/** A message's body: delivered exactly as written, and not only whitespace. */
const PeerTextSchema = v.pipe(
  v.string(),
  v.check((text) => text.trim() !== "", "the text holds something other than whitespace"),
);

/** A subagent or teammate of a session, by its agent id: a send that names
 * one goes to that agent instead of the session's own conversation, whether
 * it runs, waits or has ended (DR-0039 §3). */
const AgentIdSchema = v.optional(v.pipe(v.string(), v.nonEmpty("an agent id is not empty")));

/** send_message's fields: who to, the agent of theirs when one is named, and
 * the text. */
export const SendMessageInputSchema = v.object({
  to: PeerTargetSchema,
  agent_id: AgentIdSchema,
  text: PeerTextSchema,
});
export type SendMessageInput = Output<typeof SendMessageInputSchema>;

/** The field that picks the sessions `peers` lists: a prefix of the directory
 * a session works in (both compared as realpaths, so a whole repository's
 * worktrees or a whole tree come at once; the directory itself is included). */
const PeerListEntries = {
  cwd_prefix: v.optional(v.pipe(v.string(), v.nonEmpty("a cwd prefix is not empty"))),
};

/** peer_list's fields: the sessions to list, all of them when no prefix is
 * given. Strict: a field it does not take (a whole `cwd`, a `name`) is
 * refused rather than dropped, which would list every session. */
export const PeerListInputSchema = v.strictObject(PeerListEntries);
export type PeerListInput = Output<typeof PeerListInputSchema>;

// --- what came of it ------------------------------------------------------------

/** Why the session a send named did not get it. The message is kept nowhere.
 *
 * - `self`: the send named the sending session
 * - `no_module`: the session runs with no hooks module (DR-0039 §7)
 * - `session_changed`: the process the named session ran in now serves
 *   another session id (/clear, /resume)
 * - `ended`: the named session is no longer running
 * - `no_agent`: the send named an agent id, and the session has no subagent
 *   or teammate of that id (the id is wrong, or another session's agent)
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
 * (DR-0036 §3); a send to an agent says `refused` when Claude Code did not
 * deliver it to the agent for another reason than there being none. */
export const SendMessageReasonSchema = v.picklist([
  "self",
  "no_module",
  "session_changed",
  "ended",
  "no_agent",
  "no_peer_socket",
  "no_status_socket",
  "unreachable",
  "refused",
]);
export type SendMessageReason = Output<typeof SendMessageReasonSchema>;

/** A session: its id, which a send is addressed by, and the name it was given
 * and the directory it works in (a realpath), which tell sessions apart. */
const PeerEntries = {
  sid: v.string(),
  name: v.optional(v.string()),
  cwd: v.optional(v.string()),
};

/** What came of a send for the session it named: `delivered` (a process of
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

/** send_message's reply: the result for the session the send named, or none
 * when it named the sending session and no live run of it was read. */
export const SendMessageResponseSchema = v.object({
  ok: v.literal(true),
  results: v.array(SendMessageResultSchema),
});
export type SendMessageResponse = Output<typeof SendMessageResponseSchema>;
export const SendMessageResponseTextSchema = jsonText(SendMessageResponseSchema);

/** One session a send could go to: whether it has a hooks module (one
 * without is not sent to), and whether it is the asking session. */
export const PeerListEntrySchema = v.object({
  ...PeerEntries,
  module: v.boolean(),
  self: v.boolean(),
});
export type PeerListEntry = Output<typeof PeerListEntrySchema>;

/** peer_list's reply. */
export const PeerListResponseSchema = v.object({
  ok: v.literal(true),
  peers: v.array(PeerListEntrySchema),
});
export type PeerListResponse = Output<typeof PeerListResponseSchema>;
export const PeerListResponseTextSchema = jsonText(PeerListResponseSchema);

/** The daemon's refusal of a request, as `POST /op` answers it and as `ccmsg
 * sidecar launch` / `permit` print it on standard error, exiting 1: its `msg`
 * says why in words a reader can act on. */
export const RefusalTextSchema = jsonText(ErrorResponseSchema);

// --- the tools ------------------------------------------------------------------

/** A check that the call holds none of `refused`: the fields a model may write
 * that pick sessions out other than the way `tool` does, and the other tool's.
 *
 * Design rationale: not a strict object. The engine puts its own fields
 * beside a tool's input (the tool's name, the call's id, a subagent's agent
 * id, whatever it adds later), so a strict schema would refuse every call.
 * What a model gets wrong is a field that picks sessions out some other way
 * (`cwd` / `name` / `pid` to `send`, which the object drops and sends by the
 * id alone; `cwd` / `name` to `peers`, which it drops and lists every
 * session) or the sibling tool's field, and those are named here. */
function refusesFieldsOf(tool: string, takes: readonly string[], refused: readonly string[]) {
  return v.rawCheck<Record<string, unknown>>(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const field = refused.find((name) => name in dataset.value);
    if (field !== undefined) {
      addIssue({ message: `${tool} takes ${takes.join(", ")}; ${field} is not its field` });
    }
  });
}

/** `send`'s input: the session to send to, the agent of theirs to send it to
 * when `agent_id` is given, and the text. */
export const SendToolInputSchema = v.pipe(
  v.looseObject({}),
  refusesFieldsOf("send", ["session_id", "agent_id", "text"], ["cwd", "name", "pid", "cwd_prefix"]),
  v.object({ ...PeerTargetEntries, agent_id: AgentIdSchema, text: PeerTextSchema }),
);
export type SendToolInput = Output<typeof SendToolInputSchema>;

/** `say`'s input: what to say to the person. */
export const SayToolInputSchema = v.object({ text: PeerTextSchema });
export type SayToolInput = Output<typeof SayToolInputSchema>;

/** The `peers` tool's input: peer-list's field, picked out of the call (the
 * engine puts its own fields beside it), and none of send's. */
export const PeersToolInputSchema = v.pipe(
  v.looseObject({}),
  refusesFieldsOf(
    "peers",
    ["cwd_prefix"],
    ["session_id", "cwd", "name", "pid", "agent_id", "text"],
  ),
  v.object(PeerListEntries),
);
export type PeersToolInput = Output<typeof PeersToolInputSchema>;
