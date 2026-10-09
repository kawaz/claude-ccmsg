// The one way the daemon turns what it sends into a line of the wire
// (DR-0038). A line is a reply or a push, typed by the wire's schemas in
// protocol, so what reaches a client is what a client's schema reads.
import type { Response, StreamEvent } from "@ccmsg/protocol";

/** A reply or a push, as one line of the wire. */
export function wireLine(frame: Response | StreamEvent): string {
  return `${JSON.stringify(frame)}\n`;
}
