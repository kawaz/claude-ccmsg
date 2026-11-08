// Transcript lines of `permit` calls for the daemon's tests of the requests
// for permission (DR-0040 §4): the call's assistant row and its result's user
// row, as Claude Code writes them, and a session's transcripts laid out where
// the daemon finds its agents' beside it.
import * as fs from "node:fs";
import * as path from "node:path";
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT, type JsonObject } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";

/** What the module answers a subagent's call: no request went out. */
export const PERMIT_REFUSED_TEXT = "permit は subagent からは使えない。";

/** A row's time `secs` seconds into a day before the test ran, apart enough
 * to order by. */
export const at = (secs: number): string =>
  new Date(Date.UTC(2026, 10, 1, 0, 0, secs)).toISOString();

/** The lines of one `permit` call: the call, and, unless `result` is null,
 * its result (PERMIT_REQUESTED_TEXT unless told otherwise). `fields` go on
 * both rows (timestamp, cwd, isSidechain …). */
export function permitLines(
  id: string,
  input: JsonObject,
  { result = PERMIT_REQUESTED_TEXT, ...fields }: { result?: string | null } & JsonObject = {},
): string {
  const call = `${line(assistantContentRow([toolUseBlock(CCMSG_TOOLS.permit, input, id)], fields))}\n`;
  if (result === null) return call;
  const answer = `${line(userContentRow([toolResultBlock(result, { tool_use_id: id })], fields))}\n`;
  return call + answer;
}

/** A session's transcript `<dir>/projects/p/<sid>.jsonl` holding `main`,
 * with `agents` (agent id → its lines) in `<sid>/subagents/agent-<id>.jsonl`. */
export function permitSessionTree(
  dir: string,
  sid: string,
  main: string,
  agents: Record<string, string> = {},
): string {
  const project = path.join(dir, "projects", "p");
  const subagents = path.join(project, sid, "subagents");
  fs.mkdirSync(subagents, { recursive: true });
  const file = path.join(project, `${sid}.jsonl`);
  fs.writeFileSync(file, main);
  for (const [agentId, lines] of Object.entries(agents)) {
    fs.writeFileSync(path.join(subagents, `agent-${agentId}.jsonl`), lines);
  }
  return file;
}
