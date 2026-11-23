// The FAB's queue on disk (DR-0062 §8, §15): `<stateDir>/sessions/<sid>.queue.jsonl`
// and the files its drafts attach. What reads the file back (and rewrites it
// to what is still there, P34), where an attached file is moved to, and how
// a draft's `[FILE<n>]` numbers become the session's. The store that keeps
// the drafts in order is comments.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  errorText,
  parseWith,
  QueueFileLineSchema,
  type PromptDraftAttachment,
  type PromptDraftRecord,
  type QueueFileLine,
} from "@ccmsg/protocol";
import { isValidUuidV4 } from "./attachment.ts";

/** `<stateDir>/sessions/<sid>.queue.jsonl`. `sid` is a session id's shape
 * (the ops' schema holds to it), so the file is in that directory. */
export function queueFile(stateDir: string, sid: string): string {
  return path.join(stateDir, "sessions", `${sid}.queue.jsonl`);
}

/** A session's queue as its file holds it. */
export interface SessionQueue {
  /** By id, in the order put. */
  drafts: Map<string, PromptDraftRecord>;
  /** The `[FILE<n>]` number the session's next attachment gets (P12). */
  nextFile: number;
}

/** The drafts and the next attachment number of a queue file, a later line
 * over an earlier one of the same draft (a `draft_removed` takes it away)
 * and a later `file_seq` over an earlier. The file is then rewritten to
 * those alone when it held more (P34). A missing file is an empty queue; a
 * line that does not read is passed over and logged. */
export async function readQueueFile(
  file: string,
  warn: (msg: string) => void,
): Promise<SessionQueue> {
  const queue: SessionQueue = { drafts: new Map(), nextFile: 1 };
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    return queue;
  }
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lines += 1;
    const read = parseWith(QueueFileLineSchema, line);
    if (!read.ok) {
      warn(`queue: a line of ${file} does not read: ${read.failure.summary}`);
      continue;
    }
    const value = read.value;
    switch (value.kind) {
      case "draft":
        // A later version goes where the draft was first put.
        queue.drafts.set(value.id, value);
        break;
      case "draft_removed":
        queue.drafts.delete(value.id);
        break;
      case "file_seq":
        queue.nextFile = value.next;
        break;
    }
  }
  // A number a draft holds is never given again, whatever the file says.
  for (const draft of queue.drafts.values()) {
    for (const attachment of draft.attachments) {
      queue.nextFile = Math.max(queue.nextFile, attachment.n + 1);
    }
  }
  const kept = compactLines(queue);
  if (kept.length < lines) {
    try {
      await rewrite(file, kept);
    } catch (e) {
      warn(`queue: ${file} was not rewritten: ${errorText(e)}`);
    }
  }
  return queue;
}

/** What a queue file is rewritten to: each draft's latest line, and the
 * next attachment number when one was given. */
function compactLines(queue: SessionQueue): QueueFileLine[] {
  const seq: QueueFileLine[] =
    queue.nextFile > 1 ? [{ kind: "file_seq", next: queue.nextFile }] : [];
  return [...seq, ...queue.drafts.values()];
}

/** Replace `file` with `lines`, whole or not at all: a file beside it, then
 * a rename over it. */
async function rewrite(file: string, lines: readonly QueueFileLine[]): Promise<void> {
  const temp = `${file}.${String(process.pid)}.tmp`;
  await fs.promises.writeFile(temp, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  await fs.promises.rename(temp, file);
}

/** Append `lines` to `file` in one write. */
export async function appendQueueLines(
  file: string,
  lines: readonly QueueFileLine[],
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

// --- attachments (DR-0062 §15, P29) ---

/** An uploaded file's name in the upload directory (POST /attachment):
 * `<uuid><ext>`, the extension ASCII letters and digits. */
const UPLOADED_NAME = /^([0-9a-f-]{36})(\.[a-z0-9]{1,16})?$/;

/** Where a draft's attachment `uploaded` (a file of the upload directory)
 * goes: `<stateDir>/sessions/<sid>.att-<uuid><ext>`, the uuid and extension
 * the upload's. Null when `uploaded` is not an uploaded file. */
export function draftAttachmentFile(
  stateDir: string,
  uploadDir: string,
  sid: string,
  uploaded: string,
): string | null {
  if (path.dirname(uploaded) !== uploadDir) return null;
  const match = UPLOADED_NAME.exec(path.basename(uploaded));
  const uuid = match?.[1];
  if (uuid === undefined || !isValidUuidV4(uuid)) return null;
  return path.join(stateDir, "sessions", `${sid}.att-${uuid}${match?.[2] ?? ""}`);
}

/** Move `from` to `to`, by a copy and a removal when they are on different
 * file systems. */
export async function moveFile(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "EXDEV")) throw e;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

/** The numbers `[FILE<n>]` names in `text`. */
export function placeholderNumbers(text: string): Set<number> {
  return new Set(Array.from(text.matchAll(/\[FILE(\d+)\]/g), (m) => Number(m[1])));
}

/** `text` with each `[FILE<n>]` whose n `numbers` maps as the number it maps
 * to, in one pass (so 1→3 and 3→5 do not run into each other). */
export function renumberPlaceholders(text: string, numbers: ReadonlyMap<number, number>): string {
  return text.replace(/\[FILE(\d+)\]/g, (placeholder, n: string) => {
    const to = numbers.get(Number(n));
    return to === undefined ? placeholder : `[FILE${String(to)}]`;
  });
}

/** The first of `attachments` whose file is not there, or undefined. */
export async function missingAttachment(
  attachments: readonly PromptDraftAttachment[],
): Promise<PromptDraftAttachment | undefined> {
  for (const attachment of attachments) {
    try {
      await fs.promises.access(attachment.path);
    } catch {
      return attachment;
    }
  }
  return undefined;
}
