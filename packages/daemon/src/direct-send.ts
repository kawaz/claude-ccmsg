// message_send (DR-0036 §1): a message from one session straight to another,
// without a room. The envelope is written into the recipient's peer messaging
// socket (peer-inject.ts) and the sender is told whether it arrived; nothing is
// held for a later attempt (DR-0036 §3).
import { randomBytes } from "node:crypto";
import {
  isDirectMid,
  isSessionIdShape,
  renderDirectDelivery,
  type MessageSendReason,
} from "@ccmsg/protocol";
import type { InjectFrame, InjectResult } from "./peer-inject.ts";

/** Issues the mids of the direct messages this daemon sends:
 * `<instance id>/<n>`, counting from 1.
 *
 * The instance id is drawn afresh for each daemon process and the counter
 * lives in memory, so a restarted daemon starts a new series rather than
 * reusing numbers of the old one.
 *
 * Design rationale: a mid exists only so a reply's `reply_to` can point at one
 * message, which needs ids that never repeat, not ids that name the same
 * daemon across restarts. Persisting the instance id would also mean
 * persisting the counter (or `<id>/1` would be issued twice), which is state
 * this daemon would keep for no other use; DR-0036 §3 adds no v1-only
 * persistent state. */
export function createMidIssuer(
  instanceId: string = randomBytes(16).toString("hex"),
): () => string {
  let counter = 0;
  return () => `${instanceId}/${++counter}`;
}

export interface MessageSendArgs {
  to: unknown;
  text: unknown;
  reply_to?: unknown;
}

/** Why the request itself cannot be carried out, or undefined when it can.
 * `from` is the sending session's sid. */
export function messageSendArgsError(args: MessageSendArgs, from: string): string | undefined {
  if (typeof args.to !== "string" || !isSessionIdShape(args.to)) {
    return "message_send requires to: a session id";
  }
  if (args.to === from) return "message_send cannot send to the sending session itself";
  if (typeof args.text !== "string" || args.text === "") {
    return "message_send requires a non-empty text";
  }
  if (
    args.reply_to !== undefined &&
    (typeof args.reply_to !== "string" || !isDirectMid(args.reply_to))
  ) {
    return "message_send reply_to must be a direct message mid (<instance id>/<n>)";
  }
  return undefined;
}

export type MessageSendOutcome =
  | { outcome: "delivered"; mid: string }
  | { outcome: "not_delivered"; reason: MessageSendReason }
  | { outcome: "unconfirmed"; mid: string };

export interface DirectSendDeps {
  /** The registered session by this sid, or undefined when there is none. */
  session(sid: string): { configDir?: string } | undefined;
  issueMid(): string;
  deliver(configDir: string, sid: string, frame: InjectFrame): Promise<InjectResult>;
  /** The command the recipient's reply line names. */
  launcher: string;
  log(line: string): void;
}

/** Deliver one direct message. The arguments have passed
 * `messageSendArgsError`. */
export async function sendDirect(
  message: { from: string; to: string; text: string; replyTo?: string },
  deps: DirectSendDeps,
): Promise<MessageSendOutcome> {
  const entry = deps.session(message.to);
  if (entry === undefined) return { outcome: "not_delivered", reason: "session_not_found" };
  if (entry.configDir === undefined) return { outcome: "not_delivered", reason: "no_config_dir" };
  const mid = deps.issueMid();
  const content = renderDirectDelivery(
    {
      mid,
      from: message.from,
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
      text: message.text,
    },
    deps.launcher,
  );
  const result = await deps.deliver(entry.configDir, message.to, { mid, content });
  deps.log(
    `peer-inject ${mid} -> ${message.to}: ${result.outcome}` +
      (result.outcome === "unavailable" ? ` (${result.cause})` : ""),
  );
  switch (result.outcome) {
    case "delivered":
      return { outcome: "delivered", mid };
    case "refused":
      return { outcome: "not_delivered", reason: "refused" };
    case "unavailable":
      return { outcome: "not_delivered", reason: result.cause };
    case "unconfirmed":
      return { outcome: "unconfirmed", mid };
  }
}
