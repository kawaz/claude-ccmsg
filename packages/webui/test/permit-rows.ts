// The transcript lines of a `permit` call for the Timeline's tests of the
// requests for permission (DR-0040 §4): the call's assistant row and its
// result's user row, as Claude Code writes them.
import { CCMSG_TOOLS, PERMIT_REQUESTED_TEXT, type JsonObject } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line as jsonl,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { uuidOf } from "./timeline-harness.ts";

/** The transcript lines of the `n`th (0-9) `permit` call `id`, made in `cwd`
 * at 00:00:0n: the call, and its result unless `result` is null
 * (PERMIT_REQUESTED_TEXT unless told). */
export function permitRows(
  n: number,
  id: string,
  input: JsonObject,
  {
    result = PERMIT_REQUESTED_TEXT,
    cwd = "/w",
    day = "2026-10-25",
  }: {
    result?: string | null;
    cwd?: string;
    day?: string;
  } = {},
): string[] {
  const ts = `${day}T00:00:0${String(n)}.000Z`;
  const call = jsonl(
    assistantContentRow([{ type: "tool_use", id, name: CCMSG_TOOLS.permit, input }], {
      uuid: uuidOf("a", 500 + n),
      timestamp: ts,
      cwd,
    }),
  );
  if (result === null) return [call];
  return [
    call,
    jsonl(
      userContentRow([{ type: "tool_result", tool_use_id: id, content: result }], {
        uuid: uuidOf("u", 500 + n),
        timestamp: ts,
      }),
    ),
  ];
}
