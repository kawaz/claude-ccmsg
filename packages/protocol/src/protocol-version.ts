// The wire's protocol version, apart from the build's version (version.ts):
// it changes only by hand, so the hooks module bundles this file, and its
// bundle does not change with every release as the build's version would.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** A protocol version, `major.minor`. */
export const ProtocolVersionSchema = v.object({
  major: v.pipe(v.number(), v.integer(), v.minValue(1)),
  minor: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type ProtocolVersion = Output<typeof ProtocolVersionSchema>;

/**
 * The wire protocol's version, `major.minor`, moved by hand — never by a
 * release — whenever the contract between the daemon and the clients that
 * start with a session (the hooks module, whose bundle takes in the schemas
 * of this package it imports) changes. A change that only the webui reads
 * does not move it: the daemon serves the webui's bundle, so it is always the
 * daemon's own. The CLI is replaced together with the plugin, so a running
 * session never holds an older one. Which part moves is decided by what the
 * change does to a module already running (DR-0002 §4):
 *
 * - **major**: a client can no longer talk to the daemon (the envelope,
 *   hello, subscribe, the shape of an event). The daemon refuses a hello of
 *   another major and files the session's client as stale
 *   (`PeerInfo.stale_client`); a webui bundle of another major than the
 *   daemon's asks for a reload, in red.
 * - **minor**: the talk goes through but can mean something else (an op or a
 *   tool added or removed, a schema changed — a field the old side drops
 *   without a word). The daemon serves the client and reports its version on
 *   the session's peer row (`PeerInfo.protocol`); the webui marks that
 *   session's ccmsg in yellow, which restarting the session fixes and a
 *   reload does not.
 *
 * A major change sets the minor back to 0. `just check-protocol-bumped`
 * refuses a push that changes this package and the hooks bundle without
 * moving this.
 */
export const PROTOCOL_VERSION: ProtocolVersion = { major: 2, minor: 3 };

/**
 * The major of a party that names no `major.minor`: a hello or a ping reply
 * without the `protocol` field, or a hello carrying a bare number there (the
 * form of major 1, whose clients send `1`). Such a party is of major 1 — the
 * definition of what it speaks, not a compatibility path: its hello is
 * refused like that of any major but the daemon's.
 */
export const UNANNOUNCED_PROTOCOL_MAJOR = 1;

/** What a hello or a reply says of its protocol, in the form of any major: a
 * `major.minor`, a bare number (major 1's form), or nothing. Read as any
 * value of those forms so that a hello of another major reaches the check
 * that refuses it with the version this daemon speaks. */
export const AnnouncedProtocolSchema = v.optional(
  v.union([v.number(), v.object({ major: v.number(), minor: v.optional(v.number()) })]),
);
export type AnnouncedProtocol = Output<typeof AnnouncedProtocolSchema>;

/** A protocol as a party announced it, made comparable: its major, and its
 * minor when it named one. */
export const ClaimedProtocolSchema = v.object({
  major: v.number(),
  minor: v.optional(v.number()),
});
export type ClaimedProtocol = Output<typeof ClaimedProtocolSchema>;

/** The protocol `announced` names: no minor when it is not of the
 * `major.minor` form. */
export function claimedProtocol(announced: AnnouncedProtocol): ClaimedProtocol {
  if (announced === undefined) return { major: UNANNOUNCED_PROTOCOL_MAJOR };
  if (typeof announced === "number") return { major: announced };
  return announced.minor === undefined
    ? { major: announced.major }
    : { major: announced.major, minor: announced.minor };
}

/** `2.0`, or `1` for a protocol named by its major alone. */
export function formatProtocol(protocol: ClaimedProtocol): string {
  return protocol.minor === undefined
    ? String(protocol.major)
    : `${String(protocol.major)}.${String(protocol.minor)}`;
}
