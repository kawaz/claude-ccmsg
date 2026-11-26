// The hide button at the foot of a left pane (the Timeline's agent list, the
// Files tree) in a real browser (DR-0025 §6, kawaz 2026-11-26):
// - with room below the pane's content, the button sits in the middle of that
//   room, left to right and top to bottom, narrower than the pane
// - with the content reaching the pane's foot, the button is one row across
//   the pane's whole width at its foot, and stays there while the content
//   scrolls
// - pressing it hides the pane as the ☰ does
//
// Which of the two it is comes from CSS's layout alone, which happy-dom does
// not lay out. The session is the test's own (a hello on the daemon's socket
// with a transcript under the daemon's HOME); nothing reaches a Claude Code
// session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ee0000-0000-4000-8000-0000000000a1";
const ANSWER = "答えの行";
const SETTLE_MS = 10_000;
/** Enough files for the opened folder to reach past the pane's foot. */
const FILE_COUNT = 120;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-pane-hide-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(cwd, `file-${String(i).padStart(3, "0")}.md`), "x\n");
  }
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const base = { parentUuid: null, isSidechain: false, sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    row({
      ...base,
      uuid: "e2ee0000-0000-4000-8000-0000000000b1",
      timestamp: "2026-11-26T00:01:00.000Z",
      type: "user",
      message: { role: "user", content: "質問の行" },
    }) +
      row({
        ...base,
        uuid: "e2ee0000-0000-4000-8000-0000000000b2",
        timestamp: "2026-11-26T00:02:00.000Z",
        type: "assistant",
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: ANSWER }],
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

/** The visible session view's part, so a session view kept mounted behind
 * it is never measured. */
const IN_VIEW = ".session-tab-panel:not([hidden])";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Layout {
  pane: Box;
  /** The pane's last child before the hide area: what it scrolls. */
  content: Box;
  area: Box;
  button: Box;
  /** The button is what a press at its middle reaches. */
  reachable: boolean;
}

function layoutOf(page: Page, pane: string): Promise<Layout | null> {
  return page.evaluate((sel) => {
    const paneEl = document.querySelector(sel);
    const area = paneEl?.querySelector(":scope > .pane-hide");
    const content = area?.previousElementSibling;
    const button = area?.querySelector(".pane-hide-button");
    if (!paneEl || !area || !content || !button) return null;
    const box = (el: Element) => {
      const { left, top, right, bottom } = el.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const b = button.getBoundingClientRect();
    const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    return {
      pane: box(paneEl),
      content: box(content),
      area: box(area),
      button: box(button),
      reachable: hit !== null && button.contains(hit),
    };
  }, pane);
}

const mid = (a: number, b: number): number => (a + b) / 2;

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`the hide button of a left pane in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    async function withPage(body: (page: Page) => Promise<void>): Promise<void> {
      const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
      try {
        await body(await context.newPage());
      } finally {
        await context.close();
      }
    }

    test(
      "with room below the agent list, it sits in the middle of the room, and pressing it hides the list",
      async () => {
        await withPage(async (page) => {
          await page.goto(`${webui.url}s/${SID}/timeline/head`);
          await page
            .locator(`${IN_VIEW} .tl-lines`)
            .getByText(ANSWER)
            .waitFor({ state: "attached", timeout: SETTLE_MS });
          const PANE = `${IN_VIEW} .timeline-pane-tree`;
          const layout = await layoutOf(page, PANE);
          expect(layout).not.toBeNull();
          if (layout === null) return;
          // The room is all below the list: from the list's foot to the pane's.
          expect(layout.area.top).toBeCloseTo(layout.content.bottom, 0);
          expect(layout.area.bottom).toBeCloseTo(layout.pane.bottom, 0);
          expect(layout.area.bottom - layout.area.top).toBeGreaterThan(200);
          // In the middle of it, both ways, and not the pane's whole width.
          expect(mid(layout.button.left, layout.button.right)).toBeCloseTo(
            mid(layout.area.left, layout.area.right),
            0,
          );
          expect(mid(layout.button.top, layout.button.bottom)).toBeCloseTo(
            mid(layout.area.top, layout.area.bottom),
            0,
          );
          expect(layout.button.right - layout.button.left).toBeLessThan(
            layout.pane.right - layout.pane.left - 8,
          );
          expect(layout.reachable).toBe(true);

          await page.locator(`${PANE} .pane-hide-button`).click();
          expect(await page.locator(PANE).isVisible()).toBe(false);
          expect(await page.evaluate(() => sessionStorage.getItem("ccmsg.timelineTreeOpen"))).toBe(
            "0",
          );
        });
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "with the tree past the pane's foot, it is one row across the pane at its foot, there while the tree scrolls",
      async () => {
        await withPage(async (page) => {
          await page.goto(`${webui.url}s/${SID}/files`);
          const PANE = `${IN_VIEW} .session-pane-tree`;
          const folder = page.locator(`${PANE} .tree-workspace .tree-dir`).first();
          await folder.waitFor({ timeout: SETTLE_MS });
          await folder.click();
          await page
            .locator(`${PANE} .file-tree`)
            .getByText(`file-${String(FILE_COUNT - 1).padStart(3, "0")}.md`)
            .waitFor({ state: "attached", timeout: SETTLE_MS });

          for (const scrollTo of ["top", "middle", "bottom"] as const) {
            await page.evaluate(
              ({ sel, where }) => {
                const tree = document.querySelector(sel);
                if (tree === null) return;
                const end = tree.scrollHeight - tree.clientHeight;
                tree.scrollTop = where === "top" ? 0 : where === "middle" ? end / 2 : end;
              },
              { sel: `${PANE} .file-tree`, where: scrollTo },
            );
            const layout = await layoutOf(page, PANE);
            expect(layout).not.toBeNull();
            if (layout === null) return;
            // At the pane's foot, across its whole width, one row high.
            expect({ scrollTo, foot: Math.round(layout.area.bottom) }).toEqual({
              scrollTo,
              foot: Math.round(layout.pane.bottom),
            });
            expect(layout.button.left).toBeCloseTo(layout.pane.left, 0);
            expect(layout.button.right).toBeGreaterThan(layout.pane.right - 2);
            expect(layout.button.bottom - layout.button.top).toBeLessThan(48);
            // The tree ends where the row begins: the row hides none of it.
            expect(layout.content.bottom).toBeCloseTo(layout.area.top, 0);
            expect(layout.reachable).toBe(true);
          }

          await page.locator(`${PANE} .pane-hide-button`).click();
          expect(await page.locator(PANE).isVisible()).toBe(false);
          expect(await page.evaluate(() => sessionStorage.getItem("ccmsg.filesTreeOpen"))).toBe(
            "0",
          );
        });
      },
      E2E_TIMEOUT_MS,
    );
  });
}
