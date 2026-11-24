// The active agents at the end of the Timeline in a real browser (DR-0054 §4):
// while the main thread answers no turn, the mark of the time since the last
// turn says beside its dotted seam how many of the session's agents work
// (`⚫︎ 2 active agents`, `⚫︎ 1 active agent`), and nothing at 0. The words sit
// in the seam, which keeps its height, so the mark is as tall with them as
// without: the end does not grow or shrink as the agents come and go.
//
// The words are drawn by app.css from an attribute and the height is the
// browser's layout, which happy-dom does not have. The session is the test's
// own: a hello on the daemon's socket, with a transcript the test wrote in a
// config dir under the daemon's HOME. What its hooks module and its agents
// would say (the main thread idle, the agents at work) is written into the
// session status on its way to the page (Playwright's WebSocket routing), as
// harness.ts writes the session list. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  jsonText,
  parseWith,
  SessionStatusSnapshotSchema,
  type AgentTreeGroups,
  type AgentTreeNode,
  type SessionStatusSnapshot,
} from "@ccmsg/protocol";
import type { Browser, Page, WebSocketRoute } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ed0000-0000-4000-8000-000000000001";
/** How long to wait for the page to settle on a state. */
const SETTLE_MS = 10_000;
const MARK = '.tl-elapsed[data-tl-marker="idle"]';

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

function agentNode(id: string, state: string): AgentTreeNode {
  return { agent_id: id, kind: "subagent", spawn_depth: 0, state, children: [] };
}

/** The agent tree with `working` subagents at work and an idle teammate and a
 * completed subagent beside them (not counted). */
function treeWith(working: number): AgentTreeGroups {
  return {
    teammates: [{ ...agentNode("t1", "idle"), kind: "teammate", teammate_name: "writer" }],
    agents: [
      ...Array.from({ length: working }, (_, i) => agentNode(`a${String(i)}`, "active")),
      agentNode("done", "completed"),
    ],
    workflows: [],
  };
}

const IDLE: Pick<SessionStatusSnapshot, "turn"> = {
  turn: { state: "idle", since: "2026-11-22T00:02:00.000Z" },
};

/** A line of the daemon's that carries the session's status: the
 * session_status(_subscribe) reply and the `ev:"session_status"` push. The
 * loose read keeps the line's other fields; the strict one is the snapshot
 * alone, to push again. */
const StatusLineSchema = jsonText(
  v.looseObject({ ...SessionStatusSnapshotSchema.entries, sid: v.literal(SID) }),
);
const SnapshotLineSchema = jsonText(v.object(SessionStatusSnapshotSchema.entries));

/** Routes the page's WebSocket to the daemon, laying the overlay over every
 * status of the session on its way to the page. `set` replaces the overlay and
 * pushes the session's last status again with it, as the daemon pushes one.
 * Call before the page loads the webui. */
async function routeStatus(page: Page): Promise<{
  set: (overlay: Partial<SessionStatusSnapshot>) => void;
}> {
  let overlay: Partial<SessionStatusSnapshot> = {};
  let last: SessionStatusSnapshot | null = null;
  let toPage: WebSocketRoute | null = null;
  const withOverlay = (text: string): string =>
    text
      .split("\n")
      .map((line) => {
        const read = parseWith(StatusLineSchema, line);
        if (!read.ok) return line;
        const snapshot = parseWith(SnapshotLineSchema, line);
        if (snapshot.ok) last = snapshot.value;
        return JSON.stringify({ ...read.value, ...overlay });
      })
      .join("\n");
  await page.routeWebSocket(/\/ws$/, (ws) => {
    toPage = ws;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) =>
      ws.send(typeof message === "string" ? withOverlay(message) : message),
    );
  });
  return {
    set: (next) => {
      overlay = next;
      if (toPage === null || last === null) throw new Error("no status of the session yet");
      toPage.send(JSON.stringify({ ...last, ...overlay, ev: "session_status", sid: SID }));
    },
  };
}

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-end-agents-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const base = { parentUuid: null, isSidechain: false, sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    row({
      ...base,
      uuid: "e2ed0000-0000-4000-8000-000000000011",
      timestamp: "2026-11-22T00:01:00.000Z",
      type: "user",
      message: { role: "user", content: "agent を走らせて" },
    }) +
      row({
        ...base,
        uuid: "e2ed0000-0000-4000-8000-000000000012",
        timestamp: "2026-11-22T00:02:00.000Z",
        type: "assistant",
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "走らせた。結果を待っている。" }],
        },
      }),
  );
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const engine of BROWSERS) {
  describe(`the active agents at the end of the Timeline in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    let status: Awaited<ReturnType<typeof routeStatus>>;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      status = await routeStatus(page);
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    /** The mark's words drawn beside its seam (the `::before`'s content, ""
     * quoted when there are none) and its height, once the mark says `agents`
     * (null: none). */
    async function markOnce(agents: string | null): Promise<{ drawn: string; height: number }> {
      const selector = agents === null ? `${MARK}:not([data-agents])` : MARK;
      await page.waitForFunction(
        ([sel, want]) => {
          const mark = document.querySelector<HTMLElement>(sel);
          return mark !== null && (want === null || mark.dataset.agents === want);
        },
        [selector, agents] as const,
        { timeout: SETTLE_MS },
      );
      return page.locator(MARK).evaluate((mark) => ({
        drawn: getComputedStyle(mark, "::before").content,
        height: mark.getBoundingClientRect().height,
      }));
    }

    test(
      "the words come and go with the agents at work, 2 → 1 → 0, and the mark keeps its height",
      async () => {
        await page.goto(`${webui.url}s/${SID}/timeline/head`);
        await page.getByText("走らせた。結果を待っている。").waitFor({ timeout: SETTLE_MS });
        status.set({ ...IDLE, agent_tree: treeWith(2) });
        const two = await markOnce("⚫︎ 2 active agents");
        expect(two.drawn).toBe('"⚫︎ 2 active agents"');

        status.set({ ...IDLE, agent_tree: treeWith(1) });
        const one = await markOnce("⚫︎ 1 active agent");
        expect(one.drawn).toBe('"⚫︎ 1 active agent"');

        status.set({ ...IDLE, agent_tree: treeWith(0) });
        const none = await markOnce(null);
        expect(none.drawn).not.toContain("active");

        expect(two.height).toBeGreaterThan(0);
        expect(one.height).toBe(two.height);
        expect(none.height).toBe(two.height);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
