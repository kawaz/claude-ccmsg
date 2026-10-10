// What Claude Code records about an agent it spawned, as a schema (DR-0038
// §3): `subagents/agent-<agentId>.meta.json` beside a session's transcript
// (and `subagents/workflows/<runId>/` for a workflow's members).
//
// The file is Claude Code's, written once when the agent spawns. The schema
// lists the fields ccmsg reads and lets the rest through. Which fields a file
// carries depends on how the agent was spawned (an agent-teams teammate has a
// name, a team and a colour; a subagent has the id of the Agent call that
// spawned it), so every field is optional: a file that does not read fails
// alone, and the agent it describes is left out.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

export const AgentMetaSchema = v.looseObject({
  /** The agent's role (`general-purpose`, `Explore`, a custom agent's name). */
  agentType: v.optional(v.string()),
  /** The description of the call that spawned it. */
  description: v.optional(v.string()),
  /** How deep below the session it was spawned: 0 for the session's own
   * agents, which a file that does not say is one of. */
  spawnDepth: v.optional(v.number(), 0),
  model: v.optional(v.string()),
  /** `in_process_teammate` for an agent-teams teammate. */
  taskKind: v.optional(v.string()),
  /** A teammate's name, its address. */
  name: v.optional(v.string()),
  teamName: v.optional(v.string()),
  color: v.optional(v.string()),
  /** The id of the Agent tool call that spawned a subagent, in its parent's
   * transcript. */
  toolUseId: v.optional(v.string()),
});
export type AgentMeta = Output<typeof AgentMetaSchema>;

/** A meta.json file's text, read as the agent's record. */
export const AgentMetaTextSchema = jsonText(AgentMetaSchema);
