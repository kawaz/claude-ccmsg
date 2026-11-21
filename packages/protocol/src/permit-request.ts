// A request for the person's permission (DR-0040): an agent whose action the
// auto mode classifier stopped asks, through the `permit` tool, for the words
// that let it run the action again. As schemas (DR-0038): what the model
// writes into the tool, what the hooks module hands `ccmsg sidecar permit` on
// standard input, the daemon's reply, the call as a reader of the transcript
// shows it (the transcript is where a request is kept, DR-0040 §4), the
// person's state of it the daemon keeps, and an attachment as the daemon reads
// it when the person opens it.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// parse.ts.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** How much of an attachment the daemon reads when the person opens it: the
 * first this many bytes. A longer file is shown as its start and a note
 * that the rest is left out. */
export const PERMIT_ATTACHMENT_MAX_BYTES = 64 * 1024;

/** How many attachments one request may name: each is a line of the bubble
 * the person reads, and of the permission they copy. */
export const PERMIT_ATTACHMENTS_MAX = 16;

/** A text an agent wrote, not only whitespace. */
const PermitTextSchema = v.pipe(
  v.string(),
  v.check((text) => text.trim() !== "", "the text holds something other than whitespace"),
);

/** How long a request's `voice` may be: a call to the person, said in one
 * breath. */
export const PERMIT_VOICE_MAX_LENGTH = 80;

/** A file the person is to read before permitting: an absolute path. */
const AttachmentPathSchema = v.pipe(
  v.string(),
  v.check((path) => path.startsWith("/"), "an attachment is an absolute path"),
);

/** A file rule of `permissions.allow`: `Edit(<path>)`, `Read(<path>)` or
 * `Write(<path>)`, the tool and the path as written. */
interface FileRule {
  readonly tool: string;
  readonly path: string;
}

function fileRuleOf(rule: string): FileRule | undefined {
  const match = /^(Edit|Read|Write)\((.*)\)$/s.exec(rule);
  const tool = match?.[1];
  const path = match?.[2];
  return tool === undefined || path === undefined ? undefined : { tool, path };
}

/** The file rule `rule` in a form Claude Code matches (DR-0040 §12,
 * docs/findings/2026-11-18-permission-rule-path-spelling.md): a `Write(...)`
 * rule matches nothing, and an `Edit(...)` rule covers Write (and lets Read
 * through), so it becomes `Edit(...)`; a path that starts with a single `/`
 * is read from where the settings file is, not from the root, so it gets
 * `//`. Any other rule is as written. A form fix, needing no file system:
 * the daemon adds the real path's rule beside it (when it goes through a
 * symlink) where it can resolve one. */
export function fileRuleWrittenForm(rule: string): string {
  const file = fileRuleOf(rule);
  if (file === undefined) return rule;
  const tool = file.tool === "Write" ? "Edit" : file.tool;
  const path =
    file.path.startsWith("/") && !file.path.startsWith("//") ? `/${file.path}` : file.path;
  return `${tool}(${path})`;
}

/** A file rule that names a path from the root (`//<path>`) or from the home
 * directory (`~/<path>`): the tool, and the absolute path it names, `~`
 * taken as `home`. */
export interface AbsoluteFileRule {
  readonly tool: string;
  readonly path: string;
}

/** The absolute path the file rule `rule` names, `~/` read against `home`;
 * undefined for any other rule (a relative path, a single `/`, not a file
 * rule). */
export function absoluteFileRuleOf(rule: string, home: string): AbsoluteFileRule | undefined {
  const file = fileRuleOf(rule);
  if (file === undefined) return undefined;
  if (file.path.startsWith("//")) return { tool: file.tool, path: file.path.slice(1) };
  if (file.path.startsWith("~/")) return { tool: file.tool, path: `${home}${file.path.slice(1)}` };
  return undefined;
}

/** The file rule of `tool` that names the absolute `path`, in the `//` form. */
export function absoluteFileRuleText(tool: string, path: string): string {
  return `${tool}(/${path})`;
}

/** A rule of `permissions.allow` as written in a project's
 * `.claude/settings.local.json`: `Bash(<the command>)`, `Edit(<the path>)`.
 * The exact form is recommended (an exact allow rule skips the classifier),
 * and nothing tells it apart here: a `*` may be a wildcard or part of the
 * command (`find -name \*.json`), which the person judges in the bubble. */
const ProjectPermissionRuleSchema = PermitTextSchema;

/** One change to the asking session's project `permissions.allow`
 * (DR-0040 §12), the person's one item to apply: a rule to add or one to
 * remove, never both. The rule is taken as the agent wrote it: the daemon
 * puts an added file rule in a form that matches (fileRuleWrittenForm, and
 * the real path's rule beside it), without telling the agent. */
export const PermitProjectPermissionSchema = v.union(
  [
    v.strictObject({ add: ProjectPermissionRuleSchema }),
    v.strictObject({ remove: ProjectPermissionRuleSchema }),
  ],
  "each project permission is { add } or { remove }, one of the two",
);
export type PermitProjectPermission = Output<typeof PermitProjectPermissionSchema>;

/** The rule a project permission names, added or removed. */
export function projectPermissionRule(permission: { add: string } | { remove: string }): string {
  return "add" in permission ? permission.add : permission.remove;
}

/** One command to permit: exactly as it goes to Bash, and what it does in a
 * few words. */
const PermitCommandEntries = {
  command: PermitTextSchema,
  description: v.optional(PermitTextSchema),
};

const PermitEntries = {
  /** The action the classifier stopped, in markdown. */
  blocked: PermitTextSchema,
  /** Files the commands read (a script, a policy, a patch …), which the
   * person opens to read what is permitted. */
  attachments: v.optional(
    v.pipe(
      v.array(AttachmentPathSchema),
      v.maxLength(PERMIT_ATTACHMENTS_MAX, `at most ${PERMIT_ATTACHMENTS_MAX} attachments`),
      v.check((paths) => new Set(paths).size === paths.length, "each attachment is named once"),
    ),
  ),
  /** What to permit that is not a command (an edit, a write …), in markdown,
   * one sentence each. */
  intents: v.optional(v.array(PermitTextSchema)),
  /** The commands to permit. */
  commands: v.optional(v.array(v.object(PermitCommandEntries))),
  /** Rules to add to or remove from the project's
   * `.claude/settings.local.json` `permissions.allow`, each applied when the
   * person presses its own 許可する (DR-0040 §12). */
  project_permissions: v.optional(
    v.pipe(
      v.array(PermitProjectPermissionSchema),
      v.check(
        (permissions) =>
          new Set(permissions.map(projectPermissionRule)).size === permissions.length,
        "each project permission rule is named once",
      ),
    ),
  ),
};

/** What the speakers say (DR-0040 §6): a short call to the person. Not shown
 * in the webui. */
export const PERMIT_VOICE_REQUIRED = "voice (読み上げる 1 文、日本語) が要る";
/** What a too long voice is refused with. */
export const PERMIT_VOICE_TOO_LONG = `voice is a short call of at most ${PERMIT_VOICE_MAX_LENGTH} characters`;
const PermitVoiceSchema = v.pipe(
  v.string(PERMIT_VOICE_REQUIRED),
  v.check((text) => text.trim() !== "", PERMIT_VOICE_REQUIRED),
  v.maxLength(PERMIT_VOICE_MAX_LENGTH, PERMIT_VOICE_TOO_LONG),
);

/** Whether a request asks for anything: an intent, a command or a project
 * permission, by how many of each it has. */
function asksForSomething(...counts: readonly (number | undefined)[]): boolean {
  return counts.some((count) => (count ?? 0) > 0);
}
const ASKS_FOR_SOMETHING = "ask for at least one of intents and commands, or project_permissions";

/** The `permit` tool's input, picked out of the call (the engine puts its
 * own fields beside it, which `v.object` leaves out). */
export const PermitToolInputSchema = v.pipe(
  v.object({
    ...PermitEntries,
    /** Required: every request says what it asks for, and the speakers
     * say it of the call's row (DR-0040 §6). */
    voice: PermitVoiceSchema,
  }),
  v.check(
    (input) =>
      asksForSomething(
        input.intents?.length,
        input.commands?.length,
        input.project_permissions?.length,
      ),
    ASKS_FOR_SOMETHING,
  ),
);
export type PermitToolInput = Output<typeof PermitToolInputSchema>;

/** What `ccmsg sidecar permit` takes on standard input, and the `permit`
 * field of the `permit_request` op. Strict: the module writes exactly these
 * fields, so another is a mistake of the writer. */
export const PermitInputSchema = v.pipe(
  v.strictObject({
    ...PermitEntries,
    /** The daemon reads no voice off the request: what is spoken is the
     * call's row's (DR-0040 §6). Taken because the module hands on the
     * tool's input as it read it, voice and all. */
    voice: v.optional(PermitVoiceSchema),
    commands: v.optional(v.array(v.strictObject(PermitCommandEntries))),
  }),
  v.check(
    (input) =>
      asksForSomething(
        input.intents?.length,
        input.commands?.length,
        input.project_permissions?.length,
      ),
    ASKS_FOR_SOMETHING,
  ),
);
export type PermitInput = Output<typeof PermitInputSchema>;
export const PermitInputTextSchema = jsonText(PermitInputSchema);

/** What the `permit` tool answers when the request went out: the daemon
 * took it, and the session's Timeline shows the call's row as the request.
 * A call answered anything else (refused, a subagent's, no daemon) shows
 * nothing, so readers of the transcript tell a request by this result. */
export const PERMIT_REQUESTED_TEXT = "許可依頼を出した";

/** One command of a request as a reader shows it. */
export const PermitCommandSchema = v.object({
  command: v.string(),
  description: v.optional(v.string()),
});
export type PermitCommand = Output<typeof PermitCommandSchema>;

/** Whether the command a session's `<bash-input>` row names (`ended`) is the
 * command `asked` (a request's, DR-0040 §11): Claude Code writes the command
 * with each CR line break (CRLF, or a CR alone) as LF and its trailing blanks
 * (line breaks among them) dropped, and nothing else changed (findings
 * 2026-11-06-permit-bang-run.md, 2026-11-11-permit-bang-multiline.md). Only
 * those two are allowed for, as they were seen. Two commands of the same text
 * cannot be told apart. The webui's 「! で実行」 and the daemon's count of a
 * request's commands run read a row alike through this. */
export function isBashCommandOf(asked: string, ended: string): boolean {
  return asked.replaceAll(/\r\n?/g, "\n").trimEnd() === ended;
}

/** One project permission of a request as a reader shows it: `{ add }` or
 * `{ remove }`. Not strict: the call it is read from was checked when it was
 * made, and only a call the tool answered with PERMIT_REQUESTED_TEXT is
 * shown. */
export const PermitProjectPermissionCallSchema = v.union([
  v.object({ add: v.string() }),
  v.object({ remove: v.string() }),
]);

/** A `permit` call as the person is shown it (DR-0040 §7), read off the
 * call's tool_use in the transcript: the lists the call left out are empty.
 * `voice` is not in it, being the speakers' alone. */
export const PermitCallSchema = v.object({
  blocked: v.string(),
  attachments: v.array(v.string()),
  intents: v.array(v.string()),
  commands: v.array(PermitCommandSchema),
  project_permissions: v.array(PermitProjectPermissionCallSchema),
});
export type PermitCall = Output<typeof PermitCallSchema>;

/** A `permit` call's input as the model wrote it, read for what the person
 * is shown. Loose and with the lists optional, as the input of any version
 * of the tool reads. */
export const PermitCallInputSchema = v.looseObject({
  blocked: v.string(),
  attachments: v.optional(v.array(v.string())),
  intents: v.optional(v.array(v.string())),
  commands: v.optional(v.array(PermitCommandSchema)),
  project_permissions: v.optional(v.array(PermitProjectPermissionCallSchema)),
});

/** permit_request's reply, and what `ccmsg sidecar permit` prints: the
 * daemon has the request, and spoke it. */
export const PermitRequestResponseSchema = v.object({ ok: v.literal(true) });
export type PermitRequestResponse = Output<typeof PermitRequestResponseSchema>;
export const PermitRequestResponseTextSchema = jsonText(PermitRequestResponseSchema);

/** permit_read's reply: the ids it marked, echoed. */
export const PermitReadResponseSchema = v.object({
  ok: v.literal(true),
  ids: v.array(v.string()),
});
export type PermitReadResponse = Output<typeof PermitReadResponseSchema>;

/** The kinds of the items a request asks for (DR-0040 §4): its commands,
 * its project permissions, and its intents (permission put in words). */
export const PermitItemKindSchema = v.picklist(["commands", "project_permissions", "intents"]);
export type PermitItemKind = Output<typeof PermitItemKindSchema>;

/** An item's place in its kind's list in the call. */
export const PermitItemIndexSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** What became of one item of a request (DR-0040 §4), the request by its
 * `permit` call's tool_use id and the item by its kind and place: run (a
 * command ran, a project permission was applied, an intent or a command was
 * in what 許可する copied) or dismiss (the person said not to do it), and
 * when. An item with neither is not done yet. */
export const PermitItemMarkSchema = v.object({
  tool_use_id: v.string(),
  kind: PermitItemKindSchema,
  index: PermitItemIndexSchema,
  mark: v.picklist(["run", "dismiss"]),
  at: v.string(),
});
export type PermitItemMark = Output<typeof PermitItemMarkSchema>;

/** permit_dismiss's reply: the item is dismissed, or not, as asked. */
export const PermitDismissResponseSchema = v.object({ ok: v.literal(true) });
export type PermitDismissResponse = Output<typeof PermitDismissResponseSchema>;

/** The kinds of items 許可する copies into the permission (DR-0040 §8): the
 * intents and the commands the person picked (✅). */
export const PermitGrantedKindSchema = v.picklist(["intents", "commands"]);

/** One item 許可する copied. */
export const PermitGrantedItemSchema = v.object({
  kind: PermitGrantedKindSchema,
  index: PermitItemIndexSchema,
});
export type PermitGrantedItem = Output<typeof PermitGrantedItemSchema>;

/** permit_grant's reply: the request is granted, its items run. */
export const PermitGrantResponseSchema = v.object({ ok: v.literal(true) });
export type PermitGrantResponse = Output<typeof PermitGrantResponseSchema>;

/** The rules the daemon writes for one project permission of a request
 * (DR-0040 §12): the rule the agent wrote put in a form that matches, with
 * the rule of its real path beside it when the path goes through a symlink.
 * Fixed when the daemon first finds the request, so what the person is
 * shown and what is written do not change after. */
export const PermitRuleSetSchema = v.object({
  tool_use_id: v.string(),
  index: PermitItemIndexSchema,
  rules: v.array(v.string()),
});
export type PermitRuleSet = Output<typeof PermitRuleSetSchema>;

/** One request the person has not acted on yet (DR-0040 §5): a `permit`
 * call of a session's, by the id of its tool_use. */
export const UnreadPermitSchema = v.object({
  session_id: v.string(),
  tool_use_id: v.string(),
  /** The time of the transcript row that made the call. */
  ts: v.string(),
});
export type UnreadPermit = Output<typeof UnreadPermitSchema>;

/** One request of a session, as notification_list answers it. */
export const SessionPermitSchema = v.object({
  /** The tool_use's id: what permit_read and the permit ops name. */
  tool_use_id: v.string(),
  /** The time of the transcript row that made the call. */
  ts: v.string(),
  /** The directory the session ran in when it asked (the row's `cwd`): its
   * `.claude/settings.local.json` is where the project permissions go. */
  cwd: v.string(),
  permit: PermitCallSchema,
  /** The subagent or teammate that called it; absent on the main thread. */
  agent_id: v.optional(v.string()),
});
export type SessionPermit = Output<typeof SessionPermitSchema>;

/** Why the daemon could not show an attachment's content:
 *
 * - `missing`: nothing is at the path
 * - `not_a_file`: something is, and it is not a regular file (a directory …)
 * - `denied`: the daemon may not read it
 * - `not_text`: it is not UTF-8 text (it holds a NUL byte or a byte sequence
 *   UTF-8 does not have)
 * - `failed`: reading it failed otherwise */
export const PermitAttachmentUnreadableSchema = v.picklist([
  "missing",
  "not_a_file",
  "denied",
  "not_text",
  "failed",
]);
export type PermitAttachmentUnreadable = Output<typeof PermitAttachmentUnreadableSchema>;

/** Each reason in the words the person reads it in. */
export const PERMIT_ATTACHMENT_UNREADABLE_TEXT: Readonly<
  Record<PermitAttachmentUnreadable, string>
> = {
  missing: "ファイルが無い",
  not_a_file: "通常のファイルでない",
  denied: "読む権限が無い",
  not_text: "テキストでない",
  failed: "読めなかった",
};

/** One attachment as the daemon read it when the person opened it: its
 * content (the first PERMIT_ATTACHMENT_MAX_BYTES, `truncated` when the file
 * is longer, `bytes` its whole size), or why it could not. */
export const PermitAttachmentSchema = v.variant("read", [
  v.object({
    path: v.string(),
    read: v.literal(true),
    content: v.string(),
    bytes: v.number(),
    truncated: v.boolean(),
  }),
  v.object({
    path: v.string(),
    read: v.literal(false),
    reason: PermitAttachmentUnreadableSchema,
  }),
]);
export type PermitAttachment = Output<typeof PermitAttachmentSchema>;

/** permit_attachment_read's reply: the attachment as read now. */
export const PermitAttachmentReadResponseSchema = v.object({
  ok: v.literal(true),
  attachment: PermitAttachmentSchema,
});
export type PermitAttachmentReadResponse = Output<typeof PermitAttachmentReadResponseSchema>;

/** permit_settings_read's reply: the request's settings file as read now, in
 * the shape of an attachment (`missing` when there is none yet). */
export const PermitSettingsReadResponseSchema = PermitAttachmentReadResponseSchema;
export type PermitSettingsReadResponse = Output<typeof PermitSettingsReadResponseSchema>;

/** permit_permission_apply's reply: whether the file changed (an added rule
 * already there, or a removed one not there, leaves it as it was), and the
 * time the permission was applied at, which ev:"permit_state" now carries. */
export const PermitPermissionApplyResponseSchema = v.object({
  ok: v.literal(true),
  changed: v.boolean(),
  applied_at: v.string(),
});
export type PermitPermissionApplyResponse = Output<typeof PermitPermissionApplyResponseSchema>;
