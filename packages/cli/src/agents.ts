// `ccmsg agents --format text`: the daemon's agents rows (one per live Claude
// Code process in the config dirs the daemon serves, op `agents`) as a table
// for a person at a terminal. The JSON form is the daemon's reply as it came.
import type { AgentInfo, AgentsResponse } from "@ccmsg/protocol";

/** What `ccmsg agents` prints. */
export type AgentsFormat = "json" | "text";

const COLUMNS: ReadonlyArray<{
  readonly title: string;
  readonly cell: (agent: AgentInfo, home: string) => string;
}> = [
  { title: "SESSION", cell: (a) => a.sessionId },
  // Claude Code's own word for the process (idle / busy / waiting / shell, an
  // open set), with what a waiting process waits for.
  {
    title: "STATUS",
    cell: (a) =>
      a.status === undefined
        ? "-"
        : a.waitingFor === undefined
          ? a.status
          : `${a.status} (${a.waitingFor})`,
  },
  // Whether the main thread answers a turn, as the session's hooks module said:
  // "-" for a session whose module has said nothing.
  { title: "TURN", cell: (a) => a.turn?.state ?? "-" },
  { title: "NAME", cell: (a) => a.name ?? "-" },
  { title: "CONFIG DIR", cell: (a, home) => tildePath(a.config_dir, home) },
  { title: "CWD", cell: (a, home) => tildePath(a.cwd, home) },
];

/** `p` with a leading `home` written `~`, as a person reads paths. */
function tildePath(p: string, home: string): string {
  if (home === "" || home === "/") return p;
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** The rows as a table with a header line, columns padded to their widest
 * cell as a terminal shows it (an emoji in a name takes two columns), the last
 * column unpadded. With no rows, one line saying why there are none. */
export function agentsTable(res: AgentsResponse, home: string): string {
  if (res.agents.length === 0) {
    return res.polled_at === null
      ? "The daemon has not read the session records yet; run this again in a moment.\n"
      : "No Claude Code session is running in the config dirs the daemon serves.\n";
  }
  const rows = [
    COLUMNS.map((c) => c.title),
    ...res.agents.map((agent) => COLUMNS.map((c) => c.cell(agent, home))),
  ];
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((r) => Bun.stringWidth(r[i] ?? ""))));
  const lines = rows.map((r) =>
    r
      .map((cell, i) =>
        i === r.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - Bun.stringWidth(cell)),
      )
      .join("  "),
  );
  return `${lines.join("\n")}\n`;
}
