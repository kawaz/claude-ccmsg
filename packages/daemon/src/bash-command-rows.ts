// The bash mode commands (the person's `! <command>`, or a request for
// permission's 「! で実行」, DR-0040 §11) that finished in a session, read
// off the rows its hooks module pushes (DR-0045 §2). Claude Code puts a bash
// mode command in the conversation as a user row whose text is
// `<bash-input>{command}</bash-input>` only once the command has ended, then
// its output as `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`.
// Neither row says how the command exited (2.1.319, findings
// 2026-11-06-permit-bang-run.md), so a row here says that the command ended,
// and nothing of how.
import * as v from "valibot";
import { parseWith, TextBlockSchema, type TranscriptPushRow } from "@ccmsg/protocol";

/** A pushed row read for its text: a person's row has its content as a
 * string or as text blocks. */
const RowTextSchema = v.looseObject({
  content: v.union([v.string(), v.array(TextBlockSchema)]),
});

const OPEN = "<bash-input>";
const CLOSE = "</bash-input>";

/** The command of a `<bash-input>` row, as Claude Code wrote it (the
 * command's trailing blanks dropped, nothing escaped); null for any other
 * row. */
export function bashInputOf(row: TranscriptPushRow): string | null {
  const read = parseWith(RowTextSchema, row.message);
  if (!read.ok) return null;
  const { content } = read.value;
  const text = typeof content === "string" ? content : content.map((block) => block.text).join("");
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return null;
  return text.slice(OPEN.length, text.length - CLOSE.length);
}

/** The bash mode commands that ended in the session's main thread, in the
 * order of `rows`. A subagent's or teammate's conversation has no bash mode. */
export function bashCommandsEnded(rows: readonly TranscriptPushRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.agent_id !== undefined) return [];
    const command = bashInputOf(row);
    return command !== null ? [command] : [];
  });
}
