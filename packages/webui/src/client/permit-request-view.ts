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
  type PermitAttachment,
  type PermitCommand,
  type PermitRequestRecord,
} from "@ccmsg/protocol";

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

/** One command as an item of the permission: its heading, then the command
 * whole in a code block (a continued line, a here document stay as written). */
function commandItem(command: PermitCommand): string {
  const fence = fenceFor(command.command);
  return `- ${commandHeading(command)}\n${fence}\n${command.command}\n${fence}`;
}

/** The text the 許可する button copies: the files the request put in front
 * of the person, then what is permitted, each intent and each command
 * whole. */
export function permitGrantText(request: PermitRequestRecord): string {
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
