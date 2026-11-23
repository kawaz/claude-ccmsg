// The copy of a session's `<stateDir>/sessions/<sid>.btw.jsonl` into its
// comments (DR-0062 P25): each btw kept there, one record holding both its
// question and its answer, becomes two comment records, the question (a btw
// comment at a moment of the conversation) and its answer (a reply to it).
// Both hold the btw's id (`btw_id`), so a copy cut short and read again adds
// none twice. The file's lines are read by a schema of their own, here: no
// other part of ccmsg reads or writes that file.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  ForkUsageSchema,
  jsonText,
  parseWith,
  type BtwAnswer,
  type CommentRecord,
  type Output,
  type UserComment,
} from "@ccmsg/protocol";

/** `<stateDir>/sessions/<sid>.btw.jsonl`. */
export function btwFileOf(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.btw.jsonl`);
}

/** A line of `<sid>.btw.jsonl`: one btw as it was then. A later line of the
 * same id holds it as it was later. */
const BtwLineSchema = jsonText(
  v.object({
    id: v.string(),
    ts: v.string(),
    after_uuid: v.optional(v.string()),
    prompt: v.string(),
    response: v.string(),
    status: v.picklist(["running", "done", "failed", "canceled"]),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    ended_at: v.optional(v.string()),
    error: v.optional(v.string()),
    usage: v.optional(ForkUsageSchema),
  }),
);
type BtwLine = Output<typeof BtwLineSchema>;

/** The btws of `file`, by id, a later line over an earlier one, in the order
 * first written. Null when there is no file to read; a line that does not
 * read is passed over and `warn`ed. */
export async function readBtwFile(
  file: string,
  warn: (msg: string) => void,
): Promise<Map<string, BtwLine> | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
  const btws = new Map<string, BtwLine>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const read = parseWith(BtwLineSchema, line);
    if (!read.ok) {
      warn(`btw copy: a line of ${file} does not read: ${read.failure.summary}`);
      continue;
    }
    btws.set(read.value.id, read.value);
  }
  return btws;
}

/** The comment records of the btws of session `sid` no record of `held`
 * holds the id of yet: per btw, its question then its answer, each given a
 * cid by `newCid`. A btw left running ran with a daemon that stopped: its
 * answer is failed. */
export function btwCopyRecords(
  sid: string,
  btws: ReadonlyMap<string, BtwLine>,
  held: Iterable<CommentRecord>,
  newCid: () => string,
): CommentRecord[] {
  const copied = new Set<string>();
  for (const record of held) {
    if (record.author !== "agent" && record.btw_id !== undefined) copied.add(record.btw_id);
  }
  return [...btws.values()].flatMap((btw): CommentRecord[] => {
    if (copied.has(btw.id)) return [];
    const point = {
      at: btw.ts,
      ...(btw.after_uuid !== undefined ? { after_uuid: btw.after_uuid } : {}),
    };
    const question: UserComment = {
      kind: "comment",
      author: "user",
      cid: newCid(),
      session_id: sid,
      anchor: { kind: "timing" },
      body: btw.prompt,
      written: point,
      sent: point,
      updated_at: btw.ts,
      btw: true,
      status: "sent",
      btw_id: btw.id,
    };
    const stopped = btw.status === "running";
    const answer: BtwAnswer = {
      kind: "comment",
      author: "btw",
      cid: newCid(),
      session_id: sid,
      anchor: { kind: "comment", cid: question.cid },
      body: btw.response,
      written: point,
      updated_at: btw.ended_at ?? btw.ts,
      status: stopped ? "failed" : btw.status,
      ...(btw.model !== undefined ? { model: btw.model } : {}),
      ...(btw.effort !== undefined ? { effort: btw.effort } : {}),
      ...(btw.ended_at !== undefined ? { ended_at: btw.ended_at } : {}),
      ...(stopped
        ? { error: "daemon が止まった" }
        : btw.error !== undefined
          ? { error: btw.error }
          : {}),
      ...(btw.usage !== undefined ? { usage: btw.usage } : {}),
      btw_id: btw.id,
    };
    return [question, answer];
  });
}
