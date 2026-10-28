// What the sidebar's GLOBALS fold shows (DR-0043 §5), apart from the drawing
// so that it is checked without a renderer (DR-0005 §1): which endpoints the
// page can move to, the URL a move goes to, and which Claude Code version
// stands for this host.
import type { AgentInfo } from "@ccmsg/protocol";

/** One endpoint the page can move to: its origin, and how it is written. */
export interface EndpointChoice {
  origin: string;
  label: string;
}

/** An origin as the endpoint line writes it: the host (with its port), and the
 * scheme only when it is not `https:` — the usual case goes unsaid, the
 * unusual one is what a reader has to notice. An origin that does not parse
 * is written as it came. */
export function endpointLabel(origin: string): string {
  const url = URL.parse(origin);
  if (url === null) return origin;
  return url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
}

/** The endpoints offered, in the daemon's order (ping's `webui_urls`, DR-0043
 * §7), with the page's own origin among them: first when the daemon does not
 * list it (the daemon's bind opened directly, a loopback name), so the choice
 * always shows where the page is now. */
export function endpointChoices(
  current: string,
  candidates: readonly string[] | undefined,
): EndpointChoice[] {
  const origins = candidates ?? [];
  const all = origins.includes(current) ? origins : [current, ...origins];
  return all.map((origin) => ({ origin, label: endpointLabel(origin) }));
}

/** Where moving `href` to `origin` lands: the same path, query and hash under
 * the other origin. The URL is the screen's state (docs/design/
 * webui-url-grammar.md, the sidebar's `sb.*` included), so this opens the
 * same screen there. */
export function switchedHref(href: string, origin: string): string {
  const url = new URL(href);
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

/** A Claude Code version, and when it was seen (epoch ms of the daemon's
 * clock: a process's start, or the daemon reading `claude --version`). */
export interface ObservedClaudeVersion {
  version: string;
  at: number;
}

/** The Claude Code version of the session started last, among the process
 * rows that name one (DR-0043 §5.3), seen at that start. Not the highest
 * version: with updates applied as sessions start, the session started last
 * runs the version this host has now. Null when no row names a version. */
export function lastSessionClaudeVersion(
  agents: readonly Pick<AgentInfo, "startedAt" | "version">[],
): ObservedClaudeVersion | null {
  let latest: ObservedClaudeVersion | null = null;
  for (const { startedAt, version } of agents) {
    if (version === undefined || version === "") continue;
    if (latest === null || startedAt > latest.at) latest = { version, at: startedAt };
  }
  return latest;
}
