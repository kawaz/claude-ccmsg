// What a request for permission (DR-0040) shows and what its 許可する button
// copies. Pure, per DR-0005 §1, so the words the person pastes are testable
// without a Timeline.
//
// The copied text goes into the asking session's composer as the person's
// own words. The auto mode classifier lets an action the person permitted in
// the conversation run again, and it ties the permission to the action by
// what the words name, so each command is written whole.
import {
  PERMIT_ATTACHMENT_MAX_BYTES,
  PERMIT_ATTACHMENT_UNREADABLE_TEXT,
  type AppliedPermitPermission,
  type PermitAttachment,
  type PermitCall,
  type PermitCommand,
  type PermitProjectPermission,
} from "@ccmsg/protocol";

/** A request for permission as its bubble draws it: session `sid`'s `permit`
 * call, by its tool_use id, as the transcript holds it (DR-0040 §4) — the
 * Timeline's own row, or, outside the loaded window, the daemon's
 * notification_list. Whether the person has acted on it is the daemon's
 * ev:"permit_state". */
export interface PermitRequestView {
  sid: string;
  toolUseId: string;
  /** The call's row's time. */
  ts: string;
  /** The directory the session ran in when it asked: its project
   * permissions go into the settings file there. */
  cwd: string;
  permit: PermitCall;
}

/** The settings file a request's project permissions go into, as the bubble
 * names it: the call's directory's `.claude/settings.local.json`. */
export function projectSettingsPathOf(cwd: string): string {
  return `${cwd.replace(/\/+$/, "")}/.claude/settings.local.json`;
}

/** When the person applied `permission` of the request `toolUseId`, out of
 * every application the daemon reports; undefined while it is not
 * applied. */
export function appliedAtOf(
  applied: readonly AppliedPermitPermission[],
  toolUseId: string,
  permission: PermitProjectPermission,
): string | undefined {
  const rule = projectPermissionLine(permission);
  return applied.find((a) => {
    if (a.tool_use_id !== toolUseId) return false;
    const held = projectPermissionLine(a.permission);
    return held.kind === rule.kind && held.rule === rule.rule;
  })?.applied_at;
}

/** The fence language of a file, for its code block: its extension, which
 * the code block reads as a file's (CodeBlock), or none for a file without
 * one. */
export function fenceLangOfPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? null : base.slice(dot + 1);
}

const LIMIT_KIB = PERMIT_ATTACHMENT_MAX_BYTES / 1024;

/** What an opened attachment says beside its content: that only its start
 * is shown, or why nothing is. Null for a file shown whole. */
export function attachmentNote(attachment: PermitAttachment): string | null {
  if (!attachment.read) return PERMIT_ATTACHMENT_UNREADABLE_TEXT[attachment.reason];
  if (attachment.truncated) {
    return `先頭の ${String(LIMIT_KIB)} KiB だけ (全体 ${attachment.bytes.toLocaleString("en-US")} バイト)`;
  }
  return null;
}

/** A fence that `code` cannot close: one backtick longer than its longest
 * run of them, and three at least. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** What a command's line of the permission says it is: what it does, when
 * the agent said. The bubble shows the same words above the command. */
export function commandHeading(command: PermitCommand): string {
  return command.description !== undefined
    ? `以下コマンドの実行（${command.description}）`
    : "以下コマンドの実行";
}

/** A 「! で実行」 that is under way or done (DR-0040 §11): running from the
 * press until the session's `<bash-input>` row for it comes
 * (ev:"bash_command_ended"), then ended for good. That row does not say how
 * the command exited, so ended says nothing of it either. A press the
 * session did not take goes back to none. */
export type PermitBangRun = { kind: "running"; sid: string; command: string } | { kind: "ended" };

/** Where a 「! で実行」's run is held: the request (its `permit` call's
 * tool_use id) and the command's place among its commands. Two requests
 * asking the same command are two runs, so one does not show the other's as
 * ended. */
export function permitBangKey(toolUseId: string, index: number): string {
  return `${toolUseId}\n${String(index)}`;
}

/** Whether the command a session's `<bash-input>` row names (`ended`) is the
 * one a 「! で実行」 sent (`asked`): Claude Code writes the command with each
 * CR line break (CRLF, or a CR alone) as LF and its trailing blanks (line
 * breaks among them) dropped, and nothing else changed (findings
 * 2026-11-06-permit-bang-run.md, 2026-11-11-permit-bang-multiline.md). Only
 * those two are allowed for, as they were seen. Two commands of the same text
 * cannot be told apart. */
export function isBashCommandOf(asked: string, ended: string): boolean {
  return asked.replaceAll(/\r\n?/g, "\n").trimEnd() === ended;
}

/** The runs after a bash mode command ended in session `sid`: each running
 * one of that session and command is ended. The same map when none is. */
export function endPermitBangRuns(
  runs: ReadonlyMap<string, PermitBangRun>,
  sid: string,
  command: string,
): ReadonlyMap<string, PermitBangRun> {
  const ending = [...runs].filter(
    ([, run]) => run.kind === "running" && run.sid === sid && isBashCommandOf(run.command, command),
  );
  if (ending.length === 0) return runs;
  const next = new Map(runs);
  for (const [key] of ending) next.set(key, { kind: "ended" });
  return next;
}

/** One command as an item of the permission: its heading, then the command
 * whole in a code block (a continued line, a here document stay as written). */
function commandItem(command: PermitCommand): string {
  const fence = fenceFor(command.command);
  return `- ${commandHeading(command)}\n${fence}\n${command.command}\n${fence}`;
}

/** The text the 許可する button copies: every attached file (in the
 * request's order), then what is permitted, each intent and each command
 * whole. Each file is listed whether or not the person opened it, and
 * whether or not it could be read: whether they checked it is theirs to
 * judge before they send the text. */
export function permitGrantText(request: PermitCall): string {
  const files =
    request.attachments.length > 0
      ? `以下ファイルの内容を確認しました。問題無し。\n${request.attachments.map((path) => `- ${path}`).join("\n")}\n\n`
      : "";
  const granted = [
    ...request.intents.map((intent) => `- ${intent}`),
    ...request.commands.map(commandItem),
  ];
  return `${files}以下の操作を許可します。\n${granted.join("\n")}\n`;
}

/** One project permission as a line of a diff (DR-0040 §12): an added rule
 * is `+`, a removed one `-`, in the colors of the file diffs. */
export function projectPermissionLine(permission: PermitProjectPermission): {
  kind: "add" | "delete";
  marker: "+" | "-";
  rule: string;
} {
  return "add" in permission
    ? { kind: "add", marker: "+", rule: permission.add }
    : { kind: "delete", marker: "-", rule: permission.remove };
}

/** What an opened settings file says beside its content: 「(無し)」 for a
 * file that is not there yet (the first apply makes it), otherwise as an
 * attachment's note. */
export function settingsFileNote(attachment: PermitAttachment): string | null {
  if (!attachment.read && attachment.reason === "missing") return "(無し)";
  return attachmentNote(attachment);
}
