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

/** What the summary of an attachment says beside its path: that only its
 * start is shown, or why nothing is. Null for a file shown whole. */
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

/** One command as a line of the permission: on the line itself when it is
 * one line, in a code block when it is more (a continued line, a here
 * document), so it is written whole either way. */
function commandLine(command: string): string {
  if (!command.includes("\n")) return `- ${command} の実行`;
  const fence = fenceFor(command);
  return `- 次のコマンドの実行\n${fence}\n${command}\n${fence}`;
}

/** The text the 許可する button copies: the files whose content the person
 * was shown (a file cut short says so; one that could not be read is not
 * listed, since the person did not see it), then what is permitted, each
 * intent and each command whole. */
export function permitGrantText(request: PermitRequestRecord): string {
  const seen = request.attachments.flatMap((a) => {
    if (!a.read) return [];
    return [a.truncated ? `- ${a.path} (先頭の ${String(LIMIT_KIB)} KiB)` : `- ${a.path}`];
  });
  const granted = [
    ...request.intents.map((intent) => `- ${intent}`),
    ...request.commands.map(commandLine),
  ];
  const files = seen.length > 0 ? `内容を確認したファイル\n${seen.join("\n")}\n\n` : "";
  return `${files}以下を許可します。\n${granted.join("\n")}\n`;
}
