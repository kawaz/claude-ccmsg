// Which session a launch that carries on from one (`claude --continue` or
// `claude --resume <id>`) carries on from, and what that session runs as: what
// a launch command needs to start a continue as the `--resume` of a session it
// knows the id of beforehand, and to carry the session's model and effort onto
// a launch that names neither (DR-0018 §3.2, docs/design/launch-command.md).
//
// The choice `--continue` makes is claude's own; it has no way to name it
// without starting (docs/findings/2026-11-17-claude-continue-session-pick-source.md
// §8). What is here is that choice as measured on Claude Code 2.1.326
// (docs/findings/2026-11-17-claude-continue-session-pick-empirical.md): the
// rule its `pick.sh` follows, which matched the session claude continued in
// every layout tried. A claude whose choice has moved since is still started
// on the id chosen here, as a `--resume`, so a launch that names a place by
// that id never carries on a different session than the one the place is
// for; what moves is only which session that is. A chosen session that
// `--resume` refuses is the one exception: it stays a `--continue`
// (`resumable`), which carries on that same file under that same id.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { JsonTextSchema, parseWith, type LaunchRunsAs, type Output } from "@ccmsg/protocol";
import { carriedRunsAs, sessionRunsAs } from "./session-runs-as.ts";
import { resolveVirtualTranscript } from "./virtual-sessions.ts";

/** How the claude that continues is started: on a terminal, or `-p`. An
 * interactive continue passes over the sessions `-p` or an SDK made and the
 * `/loop` sessions; `-p` takes them. */
export type ContinueMode = "interactive" | "print";

/** The bytes of a transcript's head and tail claude reads to judge it. */
const EDGE_BYTES = 64 * 1024;
/** How far into a transcript claude looks for a conversation row. A file
 * larger than this is taken as having one, found or not. */
const ROWS_SCAN_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SLUG_MAX = 200;
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
/** A cwd holding a character outside these has claude look for its sessions
 * in the other project dirs when its own has none. */
const SEARCH_ELSEWHERE = /[^A-Za-z0-9/\\:-]/;
const CONVERSATION_ROW = '"parentUuid":';
const SDK_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
const DAEMON_KINDS = new Set(["daemon", "daemon-worker"]);

/** The name of the directory under `<config dir>/projects` claude keeps a
 * cwd's sessions in: every UTF-16 code unit outside `[A-Za-z0-9]` as `-`, and
 * past 200 the first 200 and the base-36 of the cwd's Java-style hash. */
export function projectSlug(cwd: string): string {
  const replaced = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= SLUG_MAX) return replaced;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash * 31 + cwd.charCodeAt(i)) | 0;
  return `${replaced.slice(0, SLUG_MAX)}-${Math.abs(hash).toString(36)}`;
}

/** The config dir a claude started with `env` uses: `CLAUDE_CONFIG_DIR`, or
 * `~/.claude` without it. */
export function claudeConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  return (env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")).normalize("NFC");
}

interface Candidate {
  file: string;
  mtime: number;
  birth: number;
  size: number;
}

const newestFirst = (a: Candidate, b: Candidate): number => b.mtime - a.mtime || b.birth - a.birth;

/** The `<uuid>.jsonl` files directly in `dir`, newest mtime first and, at the
 * same mtime, newest birthtime first. A dir that is not there has none. */
async function candidatesIn(dir: string): Promise<Candidate[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !UUID_FILE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const st = await fs.promises.stat(file);
      found.push({ file, mtime: st.mtime.getTime(), birth: st.birthtime.getTime(), size: st.size });
    } catch {
      // gone between the listing and the stat: not a candidate
    }
  }
  return found.sort(newestFirst);
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.toString("utf-8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

const headOf = (file: string): Promise<string> => readRange(file, 0, EDGE_BYTES);

async function tailOf(file: string, size: number): Promise<string> {
  const start = Math.max(0, size - EDGE_BYTES);
  return readRange(file, start, size - start);
}

/** Whether `needle` is in the first `limit` bytes of `file` (all of it
 * without a limit), read a chunk at a time and stopping at the first hit. */
async function fileHas(file: string, needle: string, limit = Infinity): Promise<boolean> {
  const handle = await fs.promises.open(file, "r");
  try {
    const want = Buffer.from(needle);
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = 0;
    while (position < limit) {
      const length = Math.min(READ_CHUNK_BYTES, limit - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) return false;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (window.includes(want)) return true;
      carry = window.subarray(Math.max(0, window.length - (want.length - 1)));
      position += bytesRead;
    }
    return false;
  } finally {
    await handle.close();
  }
}

// Design rationale: claude judges a transcript by the strings in its head and
// tail, not by its rows read as JSON: a broken row still counts when its text
// matches, and only the first `"key":"value"` in the bytes it reads is taken
// (the findings' 「除外されるもの」). Reading the rows through a schema would
// name a different session than claude does whenever a row does not parse or
// the bytes read end mid-row, so these are string matches on purpose.

/** The first `"<key>":"<value>"` in `text`, or undefined. */
function firstValue(text: string, key: string): string | undefined {
  return new RegExp(`"${key}":"([^"]*)"`).exec(text)?.[1];
}

/** The first line of `text` that holds `needle` and none of `without`. */
function firstLine(text: string, needle: string, without?: string): string | undefined {
  return text
    .split("\n")
    .find((line) => line.includes(needle) && (without === undefined || !line.includes(without)));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the cwd a transcript's head records is another existing directory
 * whose slug is `slug`, the cwd's: a session of that directory, which claude
 * passes over. */
async function recordsAnotherDir(head: string, cwd: string, slug: string): Promise<boolean> {
  const recorded = firstValue(head, "cwd");
  if (recorded === undefined || recorded === "" || recorded === cwd) return false;
  if (!(await isDirectory(recorded))) return false;
  return projectSlug((await fs.promises.realpath(recorded)).normalize("NFC")) === slug;
}

/** The candidates of every other project dir whose newest transcript records
 * `cwd`, where claude looks when the cwd's own dir has none of its own. */
async function candidatesElsewhere(
  projects: string,
  slug: string,
  cwd: string,
): Promise<Candidate[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(projects);
  } catch {
    return [];
  }
  const found: Candidate[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === slug) continue;
    const dir = path.join(projects, name);
    if (!(await isDirectory(dir))) continue;
    const inDir = await candidatesIn(dir);
    const newest = inDir[0];
    if (newest !== undefined && firstValue(await headOf(newest.file), "cwd") === cwd) {
      found.push(...inDir);
    }
  }
  return found.sort(newestFirst);
}

/** Whether `--continue` passes over `candidate`. An empty file is taken (claude
 * continues it as an empty conversation). */
async function passedOver(
  candidate: Candidate,
  cwd: string,
  slug: string,
  mode: ContinueMode,
): Promise<boolean> {
  if (candidate.size === 0) return false;
  const head = await headOf(candidate.file);
  if (await recordsAnotherDir(head, cwd, slug)) return true;
  if (head.includes('"isSidechain":true')) return true;
  if ((firstValue(head, "teamName") ?? "") !== "") return true;
  const kindLine = firstLine(head, CONVERSATION_ROW);
  const kind = kindLine === undefined ? undefined : firstValue(kindLine, "sessionKind");
  if (kind !== undefined && DAEMON_KINDS.has(kind)) return true;
  if (mode === "interactive") {
    const entrypoint = firstValue(head, "entrypoint");
    if (entrypoint !== undefined && SDK_ENTRYPOINTS.has(entrypoint)) return true;
    const firstUser = firstLine(head, '"type":"user"', "tool_result");
    if (firstUser?.includes("<command-name>/loop</command-name>") === true) return true;
  }
  if (
    candidate.size <= ROWS_SCAN_BYTES &&
    !(await fileHas(candidate.file, CONVERSATION_ROW, ROWS_SCAN_BYTES))
  ) {
    return true;
  }
  const tail = await tailOf(candidate.file, candidate.size);
  const continuedLine = tail
    .split("\n")
    .filter((line) => line.includes('"type":"continued-in"'))
    .at(-1);
  const continuedIn =
    continuedLine === undefined ? undefined : firstValue(continuedLine, "continuedInSessionId");
  if (continuedIn !== undefined && continuedIn !== "") {
    const next = path.join(path.dirname(candidate.file), `${continuedIn}.jsonl`);
    let isFile = false;
    try {
      isFile = (await fs.promises.stat(next)).isFile();
    } catch {
      // not there: the session did not move on
    }
    if (isFile && (await fileHas(next, CONVERSATION_ROW))) return true;
  }
  return false;
}

/** The transcript `claude --continue`, started in `cwd` with `configDir` as
 * its config dir, carries on, or undefined when it has none to carry on (an
 * interactive claude then ends with "No conversation found to continue", a
 * `-p` one starts a new session). A session that is running now is chosen as
 * claude chooses it: claude does not pass over it either. */
export async function continueTranscript(options: {
  configDir: string;
  cwd: string;
  mode: ContinueMode;
}): Promise<string | undefined> {
  const cwd = (await fs.promises.realpath(options.cwd)).normalize("NFC");
  const projects = path.join(options.configDir, "projects");
  const slug = projectSlug(cwd);
  let candidates = await candidatesIn(path.join(projects, slug));
  let allOfAnotherDir = true;
  for (const candidate of candidates) {
    if (
      candidate.size === 0 ||
      !(await recordsAnotherDir(await headOf(candidate.file), cwd, slug))
    ) {
      allOfAnotherDir = false;
      break;
    }
  }
  if (allOfAnotherDir && SEARCH_ELSEWHERE.test(cwd)) {
    candidates = await candidatesElsewhere(projects, slug, cwd);
  }
  for (const candidate of candidates) {
    if (!(await passedOver(candidate, cwd, slug, options.mode))) return candidate.file;
  }
  return undefined;
}

// What `claude --resume <id>` carries on, as measured on Claude Code 2.1.326
// and read in its loader (the findings' 「`--resume` に断られる形」): it
// reads the transcript row by row as JSON and keeps the message rows. From
// the last main-context row it follows the parentUuid chain up to the first
// user or assistant row, and carries the id on when that row is not a
// sidechain's and has a timestamp it reads. With no such row it looks at the
// turns that end a branch instead, and with none of those at any timed
// main-context row. A conversation rewound to empty is carried on whatever
// its rows; one with no message row is refused ("No conversation found with
// session ID"). `--continue` carries on the file it chose regardless.

/** A row's `message` as claude keeps it: content that is a string or a list,
 * each block of the list an object with a string `type` or not (`null`). */
const MessageSchema = v.looseObject({
  content: v.fallback(
    v.optional(
      v.union([
        v.string(),
        v.array(v.fallback(v.nullable(v.looseObject({ type: v.string() })), null)),
      ]),
    ),
    undefined,
  ),
});

/** What a row tells about the conversation: a field of another type than
 * claude writes reads as absent, as claude passes over it. */
const ConversationRowSchema = v.looseObject({
  type: v.string(),
  subtype: v.fallback(v.optional(v.string()), undefined),
  uuid: v.fallback(v.optional(v.string()), undefined),
  parentUuid: v.fallback(v.optional(v.nullable(v.string())), undefined),
  isSidechain: v.fallback(v.optional(v.boolean()), undefined),
  timestamp: v.fallback(v.optional(v.string()), undefined),
  message: v.fallback(v.optional(MessageSchema), undefined),
  attachment: v.fallback(
    v.optional(v.looseObject({ type: v.fallback(v.optional(v.string()), undefined) })),
    undefined,
  ),
  leafUuid: v.fallback(v.optional(v.nullable(v.string())), undefined),
  explicit: v.fallback(v.optional(v.boolean()), undefined),
});
type ConversationRow = Output<typeof ConversationRowSchema>;

const MESSAGE_TYPES = new Set(["user", "assistant", "attachment", "system"]);
/** The bytes of the tail read first, and how much more each wider read takes. */
const RESUME_TAIL_BYTES = 64 * 1024;
const RESUME_TAIL_GROWTH = 16;

/** Whether claude keeps `row` as a message: a user or assistant row needs a
 * message whose content is a string (an assistant's not blank) or a list
 * that is empty or holds a block. */
function keptAsMessage(row: ConversationRow): boolean {
  if (!MESSAGE_TYPES.has(row.type)) return false;
  if (row.type !== "user" && row.type !== "assistant") return true;
  const content = row.message?.content;
  if (content === undefined) return false;
  if (typeof content === "string") return row.type === "user" || content.trim() !== "";
  return content.length === 0 || content.some((block) => block !== null);
}

/** Whether a row, as the last of the conversation, is where the chain is
 * followed up from: not a sidechain's, not a file snapshot, not a fork's
 * briefing. */
function endsTheConversation(row: ConversationRow): boolean {
  if (row.isSidechain === true) return false;
  if (row.type === "system" && row.subtype === "file_snapshot") return false;
  return !(row.type === "attachment" && row.attachment?.type === "fork_briefing");
}

const readableTime = (row: ConversationRow): boolean =>
  row.timestamp !== undefined && !Number.isNaN(Date.parse(row.timestamp));

/** What the rows of `text` (whole lines) tell: `resumable` when they decide
 * it, or undefined when the chain leaves them (a wider read decides). */
function judgeRows(text: string, whole: boolean): boolean | undefined {
  const rows = new Map<string | undefined, ConversationRow>();
  /** A progress row's id and the row it hangs from: claude hangs a message
   * that hangs from a progress row from that row's own parent. */
  const progress = new Map<string, string | null>();
  let last: ConversationRow | undefined;
  /** The conversation was rewound to empty (a `last-prompt` row with no leaf,
   * explicit) and nothing followed: claude resumes it whatever its rows. */
  let cleared = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const json = parseWith(JsonTextSchema, line);
    if (!json.ok) continue;
    const read = parseWith(ConversationRowSchema, json.value);
    if (!read.ok) continue;
    const row = read.value;
    if (row.type === "last-prompt") {
      if (row.leafUuid !== undefined && row.leafUuid !== null && row.leafUuid !== "")
        cleared = false;
      else if (row.leafUuid === null && row.explicit === true) cleared = true;
      continue;
    }
    if (row.type === "progress" && row.uuid !== undefined) {
      const parent = row.parentUuid ?? null;
      progress.set(row.uuid, parent !== null ? (progress.get(parent) ?? parent) : null);
      continue;
    }
    if (!keptAsMessage(row)) continue;
    const parent = row.parentUuid;
    const kept =
      parent !== undefined && parent !== null && progress.has(parent)
        ? { ...row, parentUuid: progress.get(parent) ?? null }
        : row;
    rows.set(kept.uuid, kept);
    if (endsTheConversation(kept)) {
      last = kept;
      cleared = false;
    }
  }
  if (cleared && rows.size > 0) return true;
  if (last === undefined) return whole ? false : undefined;
  const leaf = last.uuid === undefined ? undefined : turnAbove(rows, last);
  if (leaf !== undefined) return leaf.isSidechain !== true && readableTime(leaf);
  // the chain left these rows, or a wider read may hold another branch's end
  if (!whole) return undefined;
  // No turn above the last row: claude takes the turns that end a branch
  // (above a row no other row hangs from, with no turn hanging from them).
  const parents = new Set<string | null | undefined>();
  const turnParents = new Set<string | null | undefined>();
  for (const row of rows.values()) {
    if (row.parentUuid === null) continue;
    parents.add(row.parentUuid);
    if (row.type === "user" || row.type === "assistant") turnParents.add(row.parentUuid);
  }
  const ends: ConversationRow[] = [];
  for (const row of rows.values()) {
    if (parents.has(row.uuid)) continue;
    const end = turnAbove(rows, row);
    if (end !== undefined && !turnParents.has(end.uuid)) ends.push(end);
  }
  if (ends.length > 0) return ends.some((end) => end.isSidechain !== true && readableTime(end));
  for (const row of rows.values()) if (row.isSidechain !== true && readableTime(row)) return true;
  return false;
}

/** The first user or assistant row up the parentUuid chain from `from`
 * (itself included): none when the chain ends, leaves `rows` or loops. */
function turnAbove(
  rows: ReadonlyMap<string | undefined, ConversationRow>,
  from: ConversationRow,
): ConversationRow | undefined {
  const seen = new Set<string>();
  let at: ConversationRow | undefined = from;
  while (at !== undefined) {
    if (at.type === "user" || at.type === "assistant") return at;
    const parent: string | null | undefined = at.parentUuid;
    if (parent === undefined || parent === null || seen.has(parent)) return undefined;
    seen.add(parent);
    at = rows.get(parent);
  }
  return undefined;
}

/** Whether `claude --resume <the id of file>` carries on `file`, or refuses
 * it as a session with no conversation (the comment above). Read from the
 * tail, wider until the chain from the last row is decided. */
export async function resumable(file: string): Promise<boolean> {
  const size = (await fs.promises.stat(file)).size;
  for (let window = RESUME_TAIL_BYTES; ; window *= RESUME_TAIL_GROWTH) {
    const start = Math.max(0, size - window);
    const text = await readRange(file, start, size - start);
    // a read that starts mid-file opens inside a row: that line is the next read's
    const lines = start === 0 ? text : text.slice(text.indexOf("\n") + 1);
    const judged = judgeRows(lines, start === 0);
    if (judged !== undefined) return judged;
  }
}

/** A launch that carries on from a session: a continue (`--continue`, `-p`
 * or not) or a resume of `resume`, with the model and effort it names. */
export type LaunchContextAsk = LaunchRunsAs &
  ({ continue: ContinueMode; resume?: undefined } | { continue?: undefined; resume: string });

/** The session a launch carries on from (`session_id`; none for a continue
 * that has none to carry on), and what to add to its model and effort: each
 * field the ask leaves out as the session runs it (`carriedRunsAs`, the rule a
 * resume through the daemon is filled by), read from the newest main-context
 * assistant row of its transcript. A field the transcript names none of, and
 * the effort of an ask that names another model, are left out.
 * `keep_continue` is there for a continue whose session `--resume` refuses
 * (`resumable`): the launch keeps `--continue`, which carries on that session
 * under `session_id` all the same. */
export interface LaunchContext {
  session_id?: string;
  keep_continue?: true;
  model?: LaunchRunsAs["model"];
  effort?: LaunchRunsAs["effort"];
}

export async function launchContext(
  ask: LaunchContextAsk,
  where: { configDir: string; cwd: string },
  log: { warn(msg: string): void },
): Promise<LaunchContext> {
  let sessionId: string | undefined;
  let transcript: string | undefined;
  let keepContinue = false;
  if (ask.resume !== undefined) {
    sessionId = ask.resume;
    transcript = (await resolveVirtualTranscript(ask.resume, [where.configDir]))?.file;
  } else {
    transcript = await continueTranscript({ ...where, mode: ask.continue });
    sessionId = transcript === undefined ? undefined : path.basename(transcript, ".jsonl");
    keepContinue = transcript !== undefined && !(await resumable(transcript));
  }
  if (transcript === undefined) return sessionId === undefined ? {} : { session_id: sessionId };
  const { carried } = carriedRunsAs(ask, await sessionRunsAs(undefined, transcript, log));
  return {
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(keepContinue ? { keep_continue: true } : {}),
    ...(ask.model === undefined && carried.model !== undefined ? { model: carried.model } : {}),
    ...(ask.effort === undefined && carried.effort !== undefined ? { effort: carried.effort } : {}),
  };
}
