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

/** The words fileRuleAddRefusal says them in: why each form matches nothing
 * as Claude Code reads `permissions.allow`, and what else a path through a
 * symlink needs (docs/findings/2026-11-18-permission-rule-path-spelling.md). */
const WRITE_RULE_MATCHES_NOTHING =
  "Write の rule は何にも当たらない (Edit の rule が Edit と Write の両方に効き、Read も許す)";
const SINGLE_SLASH_IS_NOT_ABSOLUTE =
  "/ 1 つで始まる path は settings の置き場からの相対として読まれ、絶対パスに当たらない (絶対パスは // で始める)";
const ADD_THE_REAL_PATH_TOO =
  "path が symlink を通るなら、実体の綴り (realpath) の // の rule も一緒に足す";

/** Why adding the file rule `rule` would put in `permissions.allow` a rule
 * that matches nothing, with the whole rule to add instead (DR-0040 §12):
 * a `Write(...)` rule (an `Edit(...)` rule covers Write), and a path that
 * starts with a single `/` (read from where the settings file is, not from
 * the root; an absolute path starts with `//`). Undefined for any other rule.
 * A form check, needing no file system: the tool's input and the daemon's
 * apply both run it. */
export function fileRuleAddRefusal(rule: string): string | undefined {
  const file = fileRuleOf(rule);
  if (file === undefined) return undefined;
  const write = file.tool === "Write";
  const singleSlash = file.path.startsWith("/") && !file.path.startsWith("//");
  if (!write && !singleSlash) return undefined;
  const path = singleSlash ? `/${file.path}` : file.path;
  const instead = `${write ? "Edit" : file.tool}(${path})`;
  const why = [
    ...(write ? [WRITE_RULE_MATCHES_NOTHING] : []),
    ...(singleSlash ? [SINGLE_SLASH_IS_NOT_ABSOLUTE] : []),
  ];
  const realToo =
    path.startsWith("//") || path.startsWith("~/") ? `。${ADD_THE_REAL_PATH_TOO}` : "";
  return `${rule}: ${why.join("。")}。代わりに ${instead} を足す${realToo}`;
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

/** Why the file rule `rule` alone does not let the person's permission
 * reach a path through a symlink, with the whole rule the request lacks:
 * Claude Code matches both the path as written and the real path the
 * symlinks lead to (DR-0040 §12). */
export function realFileRuleMissingText(rule: string, missing: string): string {
  return `${rule}: path が symlink を通り、実体の綴りの rule も無いと当たらない。同じ依頼の add に ${missing} も足す`;
}

/** A rule of `permissions.allow` as written in a project's
 * `.claude/settings.local.json`: `Bash(<the command>)`, `Edit(<the path>)`.
 * The exact form is recommended (an exact allow rule skips the classifier),
 * and nothing tells it apart here: a `*` may be a wildcard or part of the
 * command (`find -name \*.json`), which the person judges in the bubble. */
const ProjectPermissionRuleSchema = PermitTextSchema;

/** One change to the asking session's project `permissions.allow`
 * (DR-0040 §12): a rule to add or one to remove, never both. A rule to add is
 * one of a form that matches something (fileRuleAddRefusal); a rule to remove
 * may be of any form, so one that never matched can be taken out.
 *
 * Design rationale: the form of an added rule is checked on the entry, after
 * the union, rather than on the `add` field inside it. A reader that stops at
 * the first issue (the daemon's, `firstIssue`) leaves a union option with a
 * failed field untyped, and the union then says only that the entry is
 * neither shape; checked on the entry, the reason reaches every reader. */
export const PermitProjectPermissionSchema = v.pipe(
  v.union(
    [
      v.strictObject({ add: ProjectPermissionRuleSchema }),
      v.strictObject({ remove: ProjectPermissionRuleSchema }),
    ],
    "each project permission is { add } or { remove }, one of the two",
  ),
  v.rawCheck<{ add: string } | { remove: string }>(({ dataset, addIssue }) => {
    if (!dataset.typed || !("add" in dataset.value)) return;
    const refusal = fileRuleAddRefusal(dataset.value.add);
    if (refusal !== undefined) addIssue({ message: refusal });
  }),
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

/** The project permission `permission`, as the person may apply it. */
export function permitCallPermission(
  permission: Output<typeof PermitProjectPermissionCallSchema>,
): PermitProjectPermission {
  return "add" in permission ? { add: permission.add } : { remove: permission.remove };
}

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

/** A project permission of a request the person applied (DR-0040 §12): the
 * request by its `permit` call's tool_use id, the change, and when. */
export const AppliedPermitPermissionSchema = v.object({
  tool_use_id: v.string(),
  permission: PermitProjectPermissionCallSchema,
  applied_at: v.string(),
});
export type AppliedPermitPermission = Output<typeof AppliedPermitPermissionSchema>;

/** One action a request asks for (DR-0040 §4): a command, by its place in
 * the call's `commands`, or a project permission, by the change. */
export const PermitActionSchema = v.union([
  v.object({ command: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
  v.object({ permission: PermitProjectPermissionCallSchema }),
]);
export type PermitAction = Output<typeof PermitActionSchema>;

/** An action of a request the person said they will not do (やらない,
 * DR-0040 §4): the request by its `permit` call's tool_use id, and the
 * action. It is the person's alone: the asking session is never told. */
export const SkippedPermitActionSchema = v.object({
  tool_use_id: v.string(),
  action: PermitActionSchema,
});
export type SkippedPermitAction = Output<typeof SkippedPermitActionSchema>;

/** permit_skip's reply: the action is among the skipped. */
export const PermitSkipResponseSchema = v.object({ ok: v.literal(true) });
export type PermitSkipResponse = Output<typeof PermitSkipResponseSchema>;

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
