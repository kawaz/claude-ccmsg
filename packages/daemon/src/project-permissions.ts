// Project permissions of a request for permission (DR-0040 §12): a rule the
// asking session wants in, or out of, its project's `.claude/settings.local.json`
// `permissions.allow`, written when the person presses that rule's 許可する.
// A running Claude Code session reads the file again when it changes, so the
// rule holds from the session's next tool call (DR-0040 §12, observed on
// 2.1.319). The session is told what changed, as one unified diff per burst
// of presses.
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as v from "valibot";
import {
  errorText,
  type JsonObject,
  JsonValueSchema,
  type JsonValue,
  jsonText,
  parseWith,
  type PermitProjectPermission,
} from "@ccmsg/protocol";

/** The project's local settings file, from the project directory. */
export const PROJECT_SETTINGS_FILE = path.join(".claude", "settings.local.json");

/** Where a project's local settings are, for a session whose project
 * directory is `cwd`. */
export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, PROJECT_SETTINGS_FILE);
}

/** The settings file's text, as JSON. JsonValueSchema reads an array as an
 * array (a record schema would take it for an object), and each key in the
 * order written, so that no key moves when the file is written back. */
const SettingsTextSchema = jsonText(JsonValueSchema);

/** Whether a JSON value is an array. Array.isArray does not narrow a
 * readonly array out of a union, so the narrowing is said here. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** `value` when it is a JSON object, null when it is another JSON value. */
function objectOf(value: JsonValue): JsonObject | null {
  if (typeof value !== "object" || value === null || isJsonArray(value)) return null;
  return value;
}

/** `permissions.allow`: the rules, as strings. */
const AllowSchema = v.array(v.string());

/** What applying one project permission came to:
 *
 * - `applied`: the file as it was (null when there was none) and as it is
 *   now. `changed` is false when the rule was in place already (an add of a
 *   rule there, a remove of one not there), and then nothing was written.
 * - `unreadable`: the file is not JSON, or its `permissions` /
 *   `permissions.allow` is not of the settings' shape. Nothing was written.
 * - `failed`: reading or writing failed otherwise. */
export type ProjectPermissionApplied =
  | { kind: "applied"; changed: boolean; before: string | null; after: string }
  | { kind: "unreadable"; reason: string }
  | { kind: "failed"; reason: string };

/** The file's text, or null when nothing is at `file`. */
async function readIfThere(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** `object` with `key` set to `value`: in its place when the object has it,
 * at the end when it does not. The other keys keep their order, so the file
 * reads as the person wrote it. */
function withKey(object: JsonObject, key: string, value: JsonValue): JsonObject {
  return key in object
    ? Object.fromEntries(Object.entries(object).map(([k, held]) => [k, k === key ? value : held]))
    : { ...object, [key]: value };
}

/** The settings with `permission` applied to `permissions.allow`, or why the
 * settings do not read. An added rule goes in once; a removed one goes out.
 * The rules are sorted (as strings) so that the file does not depend on the
 * order the person pressed in. */
function applyTo(
  settings: JsonObject,
  permission: PermitProjectPermission,
): { ok: true; settings: JsonObject; changed: boolean } | { ok: false; reason: string } {
  const permissions = objectOf(settings.permissions ?? {});
  if (permissions === null) return { ok: false, reason: "permissions is not an object" };
  const allowRead = parseWith(AllowSchema, permissions.allow ?? []);
  if (!allowRead.ok) return { ok: false, reason: "permissions.allow is not a list of strings" };
  const allow = allowRead.value;
  const next =
    "add" in permission
      ? allow.includes(permission.add)
        ? allow
        : [...allow, permission.add]
      : allow.filter((rule) => rule !== permission.remove);
  const changed = next.length !== allow.length;
  const sorted = [...next].sort();
  return {
    ok: true,
    changed,
    settings: withKey(settings, "permissions", withKey(permissions, "allow", sorted)),
  };
}

/** Write `text` to `file` whole: into a file beside it, then renamed over it,
 * so the session reading the file again never sees half of it. A symlink at
 * `file` is followed, and the file it names is the one replaced. */
async function writeWhole(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const target = await realpath(file).catch(() => file);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  await writeFile(temporary, text);
  await rename(temporary, target);
}

/** Apply one project permission to the settings file `file`: read it (none
 * is an empty settings), change `permissions.allow`, and write it back with
 * the rules sorted and two spaces of indent, every other key as it was.
 * Never rejects. The caller runs one apply of a file at a time. */
export async function applyProjectPermission(
  file: string,
  permission: PermitProjectPermission,
): Promise<ProjectPermissionApplied> {
  let before: string | null;
  try {
    before = await readIfThere(file);
  } catch (error) {
    return { kind: "failed", reason: errorText(error) };
  }
  const read = parseWith(SettingsTextSchema, before ?? "{}");
  if (!read.ok) return { kind: "unreadable", reason: read.failure.summary };
  const settings = objectOf(read.value);
  if (settings === null) return { kind: "unreadable", reason: "the settings are not an object" };
  const applied = applyTo(settings, permission);
  if (!applied.ok) return { kind: "unreadable", reason: applied.reason };
  if (!applied.changed) return { kind: "applied", changed: false, before, after: before ?? "" };
  const after = `${JSON.stringify(applied.settings, null, 2)}\n`;
  try {
    await writeWhole(file, after);
  } catch (error) {
    return { kind: "failed", reason: errorText(error) };
  }
  return { kind: "applied", changed: true, before, after };
}

/** Run `task` after every task of the same `key` asked before it: the
 * applies to one file one at a time, so two presses never read the same
 * file and the second write the first's away. */
export function createKeyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** The lines of a text, without the empty one after its last newline. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type DiffOp = { kind: " " | "-" | "+"; line: string };

/** The lines of `before` and `after` as kept, removed and added, by the
 * longest common subsequence. A settings file is a few dozen lines, so the
 * table is small. */
function diffOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const removed = before[i];
    const added = after[j];
    if (removed !== undefined && removed === added) {
      ops.push({ kind: " ", line: removed });
      i += 1;
      j += 1;
    } else if (removed !== undefined && (added === undefined || lcs(i + 1, j) >= lcs(i, j + 1))) {
      ops.push({ kind: "-", line: removed });
      i += 1;
    } else if (added !== undefined) {
      ops.push({ kind: "+", line: added });
      j += 1;
    } else break;
  }
  return ops;
}

/** How many unchanged lines a hunk shows around a change. */
const DIFF_CONTEXT = 3;

/** The unified diff of `before` (null: no file) to `after`, both named
 * `file`, with three lines of context; empty when they are the same.
 *
 * Design rationale: written here rather than taken from the webui's line
 * diff (inline-file-model.ts), which is the client's and has no hunks. */
export function unifiedDiff(file: string, before: string | null, after: string): string {
  const ops = diffOps(linesOf(before ?? ""), linesOf(after));
  if (ops.every((op) => op.kind === " ")) return "";
  // The indexes of the ops each hunk covers: every change, and the context
  // around it, runs that touch merged.
  const ranges: { start: number; end: number }[] = [];
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    const start = Math.max(0, index - DIFF_CONTEXT);
    const end = Math.min(ops.length, index + DIFF_CONTEXT + 1);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });
  const out = [`--- ${before === null ? "/dev/null" : file}`, `+++ ${file}`];
  for (const { start, end } of ranges) {
    const leading = ops.slice(0, start);
    const oldStart = leading.filter((op) => op.kind !== "+").length;
    const newStart = leading.filter((op) => op.kind !== "-").length;
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${String(oldCount === 0 ? oldStart : oldStart + 1)},${String(oldCount)} +${String(newCount === 0 ? newStart : newStart + 1)},${String(newCount)} @@`,
    );
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}

/** How long after the last apply the session is told: presses in a row come
 * as one notice. */
export const SETTINGS_DIFF_NOTICE_DELAY_MS = 5_000;

/** The notice the session gets for a change to its project settings: one
 * fixed sentence, then the diff, whose header names the file as named from
 * the project directory (the session's cwd), so that the notice stays short
 * enough to read on a phone. */
export function settingsDiffNotice(diff: string): string {
  const fence = "```";
  return [
    ".claude/settings.local.json was updated; it takes effect immediately.",
    "",
    `${fence}diff`,
    diff.trimEnd(),
    fence,
  ].join("\n");
}

/** One session's settings file, being told about: the file as it was before
 * the first apply of the burst, as it is after the last, and the timer that
 * tells. */
interface PendingDiff {
  sid: string;
  file: string;
  before: string | null;
  after: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface SettingsDiffNotifier {
  /** One apply that changed `file` for session `sid`: (re)start the wait,
   * keeping the burst's first `before`. */
  applied(sid: string, file: string, before: string | null, after: string): void;
  /** Drop every wait (the daemon is stopping): nothing more is told. */
  stop(): void;
}

/** Tell a session what the person's presses did to its settings file, once
 * per burst: `delayMs` after the last apply, the unified diff of the file
 * before the first to after the last. A burst that ends where it began
 * (added, then removed) tells nothing. */
export function createSettingsDiffNotifier(
  tell: (sid: string, text: string) => void,
  delayMs: number = SETTINGS_DIFF_NOTICE_DELAY_MS,
): SettingsDiffNotifier {
  const pending = new Map<string, PendingDiff>();
  const fire = (key: string): void => {
    const held = pending.get(key);
    if (held === undefined) return;
    pending.delete(key);
    const diff = unifiedDiff(PROJECT_SETTINGS_FILE, held.before, held.after);
    if (diff !== "") tell(held.sid, settingsDiffNotice(diff));
  };
  return {
    applied(sid, file, before, after) {
      const key = `${sid}\u0000${file}`;
      const held = pending.get(key);
      if (held !== undefined) clearTimeout(held.timer);
      pending.set(key, {
        sid,
        file,
        before: held !== undefined ? held.before : before,
        after,
        timer: setTimeout(() => fire(key), delayMs),
      });
    },
    stop() {
      for (const held of pending.values()) clearTimeout(held.timer);
      pending.clear();
    },
  };
}
