// The active agents at the end of the Timeline in a real browser (DR-0054 §4):
// while the main thread answers no turn, a line above the dotted seam of the
// mark of the time since the last turn says how many of the session's agents
// work (`● 2 active agents`, `● 1 active agent`; a teammate on the prompt it
// was started with, `spawned`, among them, in the list's active group), and
// there is no line at 0. The dot is the agent list's dot of an agent at work:
// the same colour and pulse as the list's working row beside it. The line
// makes the end a line taller while it is there; a reader at the end stays at
// the end as it comes and goes, and a reader up in the list is not moved.
//
// The words are drawn by app.css from an attribute, and the colours, the
// animation and the scrolling are the browser's, which happy-dom does not
// have. The session is the test's
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
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ed0000-0000-4000-8000-000000000001";
/** How long to wait for the page to settle on a state. */
const SETTLE_MS = 10_000;
const MARK = '.tl-elapsed[data-tl-marker="idle"]';

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

/** An answer long enough for the Timeline to scroll: the end can be left. */
const LONG_ANSWER = [
  ...Array.from({ length: 40 }, (_, i) => `経過の段落 ${String(i + 1)}。`),
  "走らせた。結果を待っている。",
].join("\n\n");

function agentNode(id: string, state: string): AgentTreeNode {
  return { agent_id: id, kind: "subagent", spawn_depth: 0, state, children: [] };
}

const teammate = (id: string, name: string, state: string): AgentTreeNode => ({
  ...agentNode(id, state),
  kind: "teammate",
  teammate_name: name,
});

/** The agent tree with `working` at work, an idle teammate and a completed
 * subagent beside them (not counted). The first at work is a teammate on the
 * prompt it was started with (`spawned`, counted as an active one is), the
 * rest subagents. */
function treeWith(working: number): AgentTreeGroups {
  return {
    teammates: [
      ...(working > 0 ? [teammate("t0", "starter", "spawned")] : []),
      teammate("t1", "writer", "idle"),
    ],
    agents: [
      ...Array.from({ length: Math.max(0, working - 1) }, (_, i) =>
        agentNode(`a${String(i)}`, "active"),
      ),
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
 * pushes the session's last status again with it, as the daemon pushes one,
 * once a status of the session has come. Call before the page loads the
 * webui. */
async function routeStatus(page: Page): Promise<{
  set: (overlay: Partial<SessionStatusSnapshot>) => Promise<void>;
}> {
  let overlay: Partial<SessionStatusSnapshot> = {};
  let last: SessionStatusSnapshot | null = null;
  let toPage: WebSocketRoute | null = null;
  const firstStatus = Promise.withResolvers<void>();
  const withOverlay = (text: string): string =>
    text
      .split("\n")
      .map((line) => {
        const read = parseWith(StatusLineSchema, line);
        if (!read.ok) return line;
        const snapshot = parseWith(SnapshotLineSchema, line);
        if (snapshot.ok) {
          last = snapshot.value;
          firstStatus.resolve();
        }
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
    set: async (next) => {
      overlay = next;
      await firstStatus.promise;
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
          content: [{ type: "text", text: LONG_ANSWER }],
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
  describe.skipIf(skipsEngine(engine))(
    `the active agents at the end of the Timeline in ${engine.name()}`,
    () => {
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

      /** The mark's words drawn beside its seam (the `::after`'s content, null
       * when there are none), its dot's colour and animation, and its height,
       * once the mark says `agents` (null: none). */
      async function markOnce(agents: string | null): Promise<{
        drawn: string | null;
        dot: { color: string; animation: string } | null;
      }> {
        await page.waitForFunction(
          ([sel, want]) => {
            const mark = document.querySelector<HTMLElement>(sel);
            const said =
              mark?.querySelector<HTMLElement>(".tl-elapsed-agents")?.dataset.label ?? null;
            return mark !== null && said === want;
          },
          [MARK, agents] as const,
          { timeout: SETTLE_MS },
        );
        return page.locator(MARK).evaluate((mark) => {
          const words = mark.querySelector(".tl-elapsed-agents");
          const dot = mark.querySelector(".tl-elapsed-agents > .status-teammate-dot");
          const look = dot === null ? null : getComputedStyle(dot);
          return {
            drawn: words === null ? null : getComputedStyle(words, "::after").content,
            dot: look === null ? null : { color: look.color, animation: look.animationName },
          };
        });
      }

      /** The colour and animation of the agent list's dot of a row at work. */
      const listDot = () =>
        page
          .locator(".agent-tree-row .status-teammate-dot-active")
          .first()
          .evaluate((dot) => {
            const look = getComputedStyle(dot);
            return { color: look.color, animation: look.animationName };
          });

      /** How far the Timeline's end is below its view (0 at the bottom), once it
       * is at the bottom (or what it is when the wait runs out). */
      async function gapOnce(): Promise<number> {
        const gap = () =>
          page.evaluate(() => {
            const scroller = document.querySelector(".timeline-view");
            return scroller === null
              ? Infinity
              : scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          });
        await page
          .waitForFunction(
            () => {
              const scroller = document.querySelector(".timeline-view");
              return (
                scroller !== null &&
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
              );
            },
            undefined,
            { timeout: SETTLE_MS },
          )
          .catch(() => undefined);
        return gap();
      }

      /** A turn of the wheel over the Timeline, `dy` px, until the scroll it
       * makes has ended (the browser's `scrollend`): what moves the view
       * after it is the Timeline's own. */
      async function wheel(dy: number): Promise<void> {
        const scroller = page.locator(".timeline-view");
        const box = await scroller.boundingBox();
        if (box === null) throw new Error("the Timeline is not drawn");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const ended = scroller.evaluate(
          (el) =>
            new Promise<void>((resolve) =>
              el.addEventListener("scrollend", () => resolve(), { once: true }),
            ),
        );
        await page.mouse.wheel(0, dy);
        await ended;
      }

      /** Where the items in the view stand (their tops), after two frames. */
      const itemTops = () =>
        page.evaluate(async () => {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const scroller = document.querySelector(".timeline-view");
          if (scroller === null) return [];
          const view = scroller.getBoundingClientRect();
          return [...document.querySelectorAll(".tl-lines > [data-timeline-uuid]")]
            .map((item) => item.getBoundingClientRect())
            .filter((box) => box.bottom > view.top && box.top < view.bottom)
            .map((box) => Math.round(box.top));
        });

      test(
        "the words come and go with the agents at work, 2 → 1 → 0, after the list's working dot",
        async () => {
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page.getByText("走らせた。結果を待っている。").waitFor({ timeout: SETTLE_MS });
          await status.set({ ...IDLE, agent_tree: treeWith(2) });
          const two = await markOnce("2 active agents");
          expect(two.drawn).toBe('"2 active agents"');
          const list = await listDot();
          expect(list.animation).toBe("status-teammate-pulse");
          expect(two.dot).toEqual(list);
          // The spawned teammate is in the list's active group, with no group of its
          // own (DR-0020).
          const groups = await page
            .locator(".agent-tree-completed-toggle")
            .evaluateAll((toggles) => toggles.map((t) => t.textContent?.trim() ?? ""));
          expect(groups).toContain("▽ active (1)");
          expect(groups.some((g) => g.includes("spawned"))).toBe(false);

          await status.set({ ...IDLE, agent_tree: treeWith(1) });
          const one = await markOnce("1 active agent");
          expect(one.drawn).toBe('"1 active agent"');
          expect(one.dot).toEqual(list);

          await status.set({ ...IDLE, agent_tree: treeWith(0) });
          const none = await markOnce(null);
          expect(none.drawn).toBeNull();
          expect(none.dot).toBeNull();
        },
        E2E_TIMEOUT_MS,
      );

      // The line above the seam makes the end a line taller while it is there
      // (DR-0054 §4): a reader at the end stays at the end as it comes and goes,
      // whether the Timeline holds the end or the reader came down to it by
      // hand, and a reader up in the list is not moved.
      test(
        "the end is kept in sight as the line comes and goes, and a reader up in the list stays",
        async () => {
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page.getByText("走らせた。結果を待っている。").waitFor({ timeout: SETTLE_MS });
          // Opened at the end: the Timeline holds it.
          await status.set({ ...IDLE, agent_tree: treeWith(1) });
          await markOnce("1 active agent");
          expect(await gapOnce()).toBeLessThanOrEqual(1);
          await status.set({ ...IDLE, agent_tree: treeWith(0) });
          await markOnce(null);
          expect(await gapOnce()).toBeLessThanOrEqual(1);
          await status.set({ ...IDLE, agent_tree: treeWith(1) });
          await markOnce("1 active agent");
          expect(await gapOnce()).toBeLessThanOrEqual(1);

          // Down to the end by hand (the wheel lets the hold go).
          await wheel(-300);
          await wheel(100_000);
          expect(await gapOnce()).toBeLessThanOrEqual(1);
          await status.set({ ...IDLE, agent_tree: treeWith(0) });
          await markOnce(null);
          expect(await gapOnce()).toBeLessThanOrEqual(1);
          await status.set({ ...IDLE, agent_tree: treeWith(1) });
          await markOnce("1 active agent");
          expect(await gapOnce()).toBeLessThanOrEqual(1);

          // Up in the list: what is in the view does not move.
          await wheel(-600);
          expect(
            await page.evaluate(() => {
              const el = document.querySelector(".timeline-view");
              return el === null ? 0 : el.scrollHeight - el.scrollTop - el.clientHeight;
            }),
          ).toBeGreaterThan(300);
          const before = await itemTops();
          await status.set({ ...IDLE, agent_tree: treeWith(0) });
          await markOnce(null);
          expect(await itemTops()).toEqual(before);
          await status.set({ ...IDLE, agent_tree: treeWith(1) });
          await markOnce("1 active agent");
          expect(await itemTops()).toEqual(before);
        },
        E2E_TIMEOUT_MS,
      );
    },
  );
}
