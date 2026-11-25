// The Timeline toolbar's badges and the panes beside the Timeline and the
// Files viewer in a real browser (kawaz 2026-11-22):
// - the selected badge is filled by a face drawn outside its square, which
//   changes neither the toolbar's height nor any badge's box, is not pressed
//   by a point on it outside the square, and stops short of the next badge
// - the agent list is there for a session with no agents (the main row alone)
// - at a phone's width (390px) the agent list starts hidden, and its ☰ shows
//   it (kawaz 2026-11-24)
// - at 390px the session's panes start at the screen's left edge, a whole
//   pixel, though the drawer beside them is 85% of the width (331.5px)
// - the agent list's ☰ and the Files tree's ☰ fit in their bar without
//   making it taller, hide the pane and the viewer takes its room, and bring
//   it back
// - the tree and the viewer sit side by side at every width, a narrow one
//   (390px) included (kawaz 2026-11-23)
// - the splitter's floor: a pane stored far narrower (a tree's ratio, the
//   SESSIONS list's width, the drawer's) is drawn at the floor app.css gives
//   it, wide (1280px) and narrow (390px) — the same floor for the trees and
//   the SESSIONS list
// - at 390px the splitter moves by a mouse drag and (Chromium) a finger's,
//   and the ratio it leaves and a hidden tree come back after a reload
// - the viewer beside a tree is no narrower than its floor (the splitter's
//   upper end), and at 390px the Files header's parts neither overlap nor
//   stick out of it, whatever the tree's ratio (kawaz 2026-11-23)
//
// The face is a ::before and the floors are CSS's own min sizes, which
// happy-dom does not lay out. The session is the test's own (a hello on the
// daemon's socket with a transcript under the daemon's HOME); nothing reaches
// a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ee0000-0000-4000-8000-000000000001";
const ANSWER = "答えの行";
const SETTLE_MS = 10_000;
/** The floors app.css gives the panes, in px at the 16px root: a tree and the
 * SESSIONS list are both 5rem wide (`--pane-list-min`), the drawer that and
 * the 7px splitter. */
const TREE_MIN_WIDTH = 80;
const LISTS_MIN_WIDTH = 80;
/** The viewer's floor beside a tree (`--pane-body-min`, 17rem). */
const BODY_MIN_WIDTH = 272;
const SPLITTER_PX = 7;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-tl-panels-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# readme\n");
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const base = { parentUuid: null, isSidechain: false, sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    row({
      ...base,
      uuid: "e2ee0000-0000-4000-8000-000000000011",
      timestamp: "2026-11-22T00:01:00.000Z",
      type: "user",
      message: { role: "user", content: "質問の行" },
    }) +
      row({
        ...base,
        uuid: "e2ee0000-0000-4000-8000-000000000012",
        timestamp: "2026-11-22T00:02:00.000Z",
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

async function openTimeline(page: Page, query = ""): Promise<void> {
  await page.goto(`${webui.url}s/${SID}/timeline/head${query}`);
  // Attached rather than visible: under a filter the row is there but hidden.
  await page
    .locator(`${IN_VIEW} .tl-lines`)
    .getByText(ANSWER)
    .waitFor({ state: "attached", timeout: SETTLE_MS });
}

/** At a phone's width the agent list starts hidden (DR-0025): its ☰ in the
 * Timeline's toolbar shows it. */
async function showAgentList(page: Page): Promise<void> {
  const tree = page.locator(`${IN_VIEW} .timeline-pane-tree`);
  expect(await tree.isVisible()).toBe(false);
  await page.locator(`${IN_VIEW} .tl-toolbar .pane-tree-toggle`).click();
  await tree.waitFor();
}

/** A bar's height with its ☰ and with the ☰ taken out of the layout: the ☰
 * is to fit in the row as it is. */
async function heightWithAndWithoutToggle(
  page: Page,
  bar: string,
): Promise<{ with: number; without: number }> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const toggle = el?.querySelector<HTMLElement>(".pane-tree-toggle");
    if (el === null || el === undefined || toggle === null || toggle === undefined) {
      return { with: -1, without: -2 };
    }
    const shown = el.getBoundingClientRect().height;
    toggle.style.display = "none";
    const without = el.getBoundingClientRect().height;
    toggle.style.display = "";
    return { with: shown, without };
  }, bar);
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxOf(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left, top, right, bottom };
  }, selector);
}

/** The tree's box is left of the viewer's, the two the same height and top:
 * a row, never a stack. */
function expectSideBySide(tree: Box | null, viewer: Box | null): void {
  expect(tree).not.toBeNull();
  expect(viewer).not.toBeNull();
  expect(tree?.right ?? Infinity).toBeLessThanOrEqual(viewer?.left ?? -Infinity);
  expect(tree?.top).toBe(viewer?.top);
  expect(tree?.bottom).toBe(viewer?.bottom);
}

/** The visible panes' container is no wider inside than it is: nothing in it
 * is reached by a sideways scroll. */
function noSidewaysScroll(page: Page): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el !== null && el.scrollWidth <= el.clientWidth;
  }, `${IN_VIEW} .session-panes`);
}

const widthOf = (box: Box | null): number => (box?.right ?? 0) - (box?.left ?? 0);

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(
    `the Timeline's toolbar and the panes in ${engine.name()}`,
    () => {
      let browser: Browser;
      beforeAll(async () => {
        browser = await engine.launch();
      }, E2E_TIMEOUT_MS);
      afterAll(async () => {
        await browser.close();
      });

      async function withPage(
        viewport: { width: number; height: number },
        stored: Record<string, string>,
        body: (page: Page) => Promise<void>,
      ): Promise<void> {
        const context: BrowserContext = await browser.newContext({ viewport });
        try {
          await context.addInitScript((entries) => {
            for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
          }, stored);
          await body(await context.newPage());
        } finally {
          await context.close();
        }
      }

      test(
        "the selected badge's face is drawn outside its square without moving anything or taking presses, short of the next badge",
        async () => {
          await withPage({ width: 390, height: 844 }, {}, async (page) => {
            const BADGES = `${IN_VIEW} .tl-toolbar-badges .notif-badge`;
            const layout = () =>
              page.evaluate(
                ({ toolbar, badges }) => ({
                  toolbar: document.querySelector(toolbar)?.getBoundingClientRect().height ?? -1,
                  badges: [...document.querySelectorAll(badges)].map((el) => {
                    const { left, top, width, height } = el.getBoundingClientRect();
                    return { left, top, width, height };
                  }),
                }),
                { toolbar: `${IN_VIEW} .tl-toolbar`, badges: BADGES },
              );
            await openTimeline(page);
            const unselected = await layout();
            await openTimeline(page, "?filter=permit");
            expect(await layout()).toEqual(unselected);

            const face = await page.evaluate((badges) => {
              const links = [...document.querySelectorAll(badges)];
              const selected = links.findIndex((el) => el.getAttribute("aria-current") === "true");
              const link = links[selected];
              const next = links[selected + 1];
              if (link === undefined || next === undefined) return null;
              const before = getComputedStyle(link, "::before");
              const box = link.getBoundingClientRect();
              // A point on the face (which reaches 4px out) left of the square,
              // half way down, clear of the emoji's own box: WebKit's emoji box
              // is wider than the square and hits up to 2px out of it.
              const hit = document.elementFromPoint(box.left - 3.5, box.top + box.height / 2);
              return {
                background: before.backgroundColor,
                inset: [before.top, before.right, before.bottom, before.left],
                pointerEvents: before.pointerEvents,
                hitIsLink: hit !== null && link.contains(hit),
                gapToNext: next.getBoundingClientRect().left - box.right,
                unselectedContent: getComputedStyle(next, "::before").content,
              };
            }, BADGES);
            expect(face).not.toBeNull();
            expect(face?.background).not.toBe("rgba(0, 0, 0, 0)");
            expect(face?.inset).toEqual(["-2px", "-4px", "-2px", "-4px"]);
            expect(face?.pointerEvents).toBe("none");
            expect(face?.hitIsLink).toBe(false);
            // The face reaches 4px out on each side: the next badge is further.
            expect(face?.gapToNext ?? 0).toBeGreaterThan(2 * 4);
            expect(face?.unselectedContent).toBe("none");
          });
        },
        E2E_TIMEOUT_MS,
      );

      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        test(
          `at ${viewport.width}px the agent list is there with no agents, its ☰ and the Files tree's ☰ hide the pane and bring it back`,
          async () => {
            await withPage(viewport, {}, async (page) => {
              await openTimeline(page);
              const tree = page.locator(`${IN_VIEW} .timeline-pane-tree`);
              // Shown at first on a wide screen; hidden at first on a phone's
              // width, where its ☰ shows it.
              if (viewport.width <= 720) await showAgentList(page);
              expect(await tree.isVisible()).toBe(true);
              const toolbarHeights = await heightWithAndWithoutToggle(
                page,
                `${IN_VIEW} .tl-toolbar`,
              );
              expect(toolbarHeights.with).toBe(toolbarHeights.without);
              expect(await tree.locator(".agent-tree-label").allTextContents()).toEqual(["main"]);
              const viewer = `${IN_VIEW} .session-pane-viewer`;
              const shown = await boxOf(page, viewer);
              expectSideBySide(await boxOf(page, `${IN_VIEW} .timeline-pane-tree`), shown);
              // Shown and hidden by the ☰ alone: the panes never scroll sideways.
              expect(await noSidewaysScroll(page)).toBe(true);

              const toggle = page.locator(`${IN_VIEW} .tl-toolbar .pane-tree-toggle`);
              await toggle.click();
              expect(await tree.isVisible()).toBe(false);
              expect(await page.locator(`${IN_VIEW} .session-splitter`).count()).toBe(0);
              const hidden = await boxOf(page, viewer);
              // The viewer takes the tree's room beside it, at its own height.
              expect((hidden?.right ?? 0) - (hidden?.left ?? 0)).toBeGreaterThan(
                (shown?.right ?? 0) - (shown?.left ?? 0),
              );
              expect(hidden?.top).toBe(shown?.top);
              expect(hidden?.bottom).toBe(shown?.bottom);
              await toggle.click();
              expect(await tree.isVisible()).toBe(true);

              await page.goto(`${webui.url}s/${SID}/files?path=README.md`);
              await page
                .locator(`${IN_VIEW} .viewer-path`)
                .getByText("README.md")
                .waitFor({ timeout: SETTLE_MS });
              const headerHeights = await heightWithAndWithoutToggle(
                page,
                `${IN_VIEW} .viewer-header`,
              );
              expect(headerHeights.with).toBe(headerHeights.without);
              const header = page.locator(`${IN_VIEW} .viewer-header`);
              const filesToggle = header.locator(".pane-tree-toggle");
              expect(
                await header.evaluate((el) =>
                  el.firstElementChild?.classList.contains("pane-tree-toggle"),
                ),
              ).toBe(true);
              const filesTree = page.locator(`${IN_VIEW} .session-pane-tree`);
              expect(await filesTree.isVisible()).toBe(true);
              expectSideBySide(
                await boxOf(page, `${IN_VIEW} .session-pane-tree`),
                await boxOf(page, viewer),
              );
              await filesToggle.click();
              expect(await filesTree.isVisible()).toBe(false);
              await filesToggle.click();
              expect(await filesTree.isVisible()).toBe(true);
            });
          },
          E2E_TIMEOUT_MS,
        );
      }

      // Stored far below the floors: a tree's ratio, the list's width, the drawer's.
      const TINY = {
        "ccmsg.timelinePaneRatio": "0.01",
        "ccmsg.sessionPaneRatio": "0.01",
        "ccmsg.sidebarWidth": "20",
        "ccmsg.drawerWidth": "30",
      };

      test(
        "at 1280px a tree is drawn no narrower than its floor, and the SESSIONS list no narrower than its own",
        async () => {
          await withPage({ width: 1280, height: 900 }, TINY, async (page) => {
            await openTimeline(page);
            const tree = await boxOf(page, `${IN_VIEW} .timeline-pane-tree`);
            expect((tree?.right ?? 0) - (tree?.left ?? 0)).toBeCloseTo(TREE_MIN_WIDTH, 0);
            const lists = await boxOf(page, "#sidebar-lists");
            expect((lists?.right ?? 0) - (lists?.left ?? 0)).toBeCloseTo(LISTS_MIN_WIDTH, 0);
            const sidebar = await boxOf(page, "#sidebar");
            expect((sidebar?.right ?? 0) - (sidebar?.left ?? 0)).toBeCloseTo(
              LISTS_MIN_WIDTH + SPLITTER_PX,
              0,
            );
          });
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "at 390px the agent list starts hidden with the viewer the panes' whole width, its ☰ shows it, and a reload keeps it shown",
        async () => {
          await withPage({ width: 390, height: 844 }, {}, async (page) => {
            await openTimeline(page);
            const viewer = `${IN_VIEW} .session-pane-viewer`;
            expect(widthOf(await boxOf(page, viewer))).toBeCloseTo(
              widthOf(await boxOf(page, `${IN_VIEW} .session-panes`)),
              0,
            );
            await showAgentList(page);
            expectSideBySide(
              await boxOf(page, `${IN_VIEW} .timeline-pane-tree`),
              await boxOf(page, viewer),
            );
            // The window remembers it was shown.
            await page.reload();
            await page
              .locator(`${IN_VIEW} .tl-lines`)
              .getByText(ANSWER)
              .waitFor({ state: "attached", timeout: SETTLE_MS });
            expect(await page.locator(`${IN_VIEW} .timeline-pane-tree`).isVisible()).toBe(true);
          });
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "at 390px the session's panes start at the screen's left edge and reach its right edge",
        async () => {
          await withPage({ width: 390, height: 844 }, {}, async (page) => {
            await openTimeline(page);
            const panes = await boxOf(page, `${IN_VIEW} .session-panes`);
            expect(panes?.left).toBe(0);
            expect(panes?.right).toBe(390);
          });
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "at 390px both trees are drawn no narrower than their floor, the SESSIONS list's, beside the viewer, and the drawer no narrower than that floor",
        async () => {
          await withPage({ width: 390, height: 844 }, TINY, async (page) => {
            await openTimeline(page);
            await showAgentList(page);
            const tree = await boxOf(page, `${IN_VIEW} .timeline-pane-tree`);
            expect(widthOf(tree)).toBeCloseTo(TREE_MIN_WIDTH, 0);
            expectSideBySide(tree, await boxOf(page, `${IN_VIEW} .session-pane-viewer`));
            await page.goto(`${webui.url}s/${SID}/files?path=README.md`);
            await page
              .locator(`${IN_VIEW} .viewer-path`)
              .getByText("README.md")
              .waitFor({ timeout: SETTLE_MS });
            const filesTree = await boxOf(page, `${IN_VIEW} .session-pane-tree`);
            expect(widthOf(filesTree)).toBeCloseTo(TREE_MIN_WIDTH, 0);
            expectSideBySide(filesTree, await boxOf(page, `${IN_VIEW} .session-pane-viewer`));
            const sidebar = await boxOf(page, "#sidebar");
            expect((sidebar?.right ?? 0) - (sidebar?.left ?? 0)).toBeCloseTo(
              LISTS_MIN_WIDTH + SPLITTER_PX,
              0,
            );
          });
        },
        E2E_TIMEOUT_MS,
      );

      test(
        "at 390px the splitter moves by a mouse drag, and the ratio it leaves and a hidden tree come back after a reload",
        async () => {
          await withPage({ width: 390, height: 844 }, {}, async (page) => {
            await openTimeline(page);
            await showAgentList(page);
            const TREE = `${IN_VIEW} .timeline-pane-tree`;
            const splitter = await boxOf(page, `${IN_VIEW} .session-splitter`);
            const panes = await boxOf(page, `${IN_VIEW} .session-panes`);
            expect(splitter).not.toBeNull();
            const y = ((splitter?.top ?? 0) + (splitter?.bottom ?? 0)) / 2;
            const from = ((splitter?.left ?? 0) + (splitter?.right ?? 0)) / 2;
            // Narrower than the default (28%, about 109px) and above the floor.
            // On a whole pixel: WebKit's pointer events carry whole-pixel
            // clientX.
            const to = Math.round((panes?.left ?? 0) + 95);
            await page.mouse.move(from, y);
            await page.mouse.down();
            await page.mouse.move(to, y, { steps: 5 });
            await page.mouse.up();
            // The tree's right edge is where the pointer was let go.
            const dragged = widthOf(await boxOf(page, TREE));
            expect(dragged).toBeCloseTo(to - (panes?.left ?? 0), 1);
            expect(await noSidewaysScroll(page)).toBe(true);

            await page.locator(`${IN_VIEW} .tl-toolbar .pane-tree-toggle`).click();
            expect(await page.locator(TREE).isVisible()).toBe(false);
            await page.reload();
            await page
              .locator(`${IN_VIEW} .tl-lines`)
              .getByText(ANSWER)
              .waitFor({ state: "attached", timeout: SETTLE_MS });
            expect(await page.locator(TREE).isVisible()).toBe(false);
            await page.locator(`${IN_VIEW} .tl-toolbar .pane-tree-toggle`).click();
            expect(widthOf(await boxOf(page, TREE))).toBeCloseTo(dragged, 0);

            // Dragged to the right edge, the tree stops where the viewer is at its floor.
            const again = await boxOf(page, `${IN_VIEW} .session-splitter`);
            const againX = ((again?.left ?? 0) + (again?.right ?? 0)) / 2;
            await page.mouse.move(againX, y);
            await page.mouse.down();
            await page.mouse.move((panes?.right ?? 0) - 2, y, { steps: 5 });
            await page.mouse.up();
            expect(widthOf(await boxOf(page, `${IN_VIEW} .session-pane-viewer`))).toBeCloseTo(
              BODY_MIN_WIDTH,
              0,
            );
            expect(await noSidewaysScroll(page)).toBe(true);
          });
        },
        E2E_TIMEOUT_MS,
      );

      // A finger's drag: Chromium's CDP turns touch points into the pointer
      // events PaneSplitter listens to (WebKit's driver has no such input).
      if (engine.name() === "chromium") {
        test(
          "at 390px the splitter moves by a finger's drag",
          async () => {
            const context = await browser.newContext({
              viewport: { width: 390, height: 844 },
              hasTouch: true,
              isMobile: true,
            });
            try {
              const page = await context.newPage();
              await page.goto(`${webui.url}s/${SID}/files?path=README.md`);
              await page
                .locator(`${IN_VIEW} .viewer-path`)
                .getByText("README.md")
                .waitFor({ timeout: SETTLE_MS });
              const splitter = await boxOf(page, `${IN_VIEW} .session-splitter`);
              const panes = await boxOf(page, `${IN_VIEW} .session-panes`);
              expect(splitter).not.toBeNull();
              const y = ((splitter?.top ?? 0) + (splitter?.bottom ?? 0)) / 2;
              const from = ((splitter?.left ?? 0) + (splitter?.right ?? 0)) / 2;
              const to = (panes?.left ?? 0) + 90;
              const cdp = await context.newCDPSession(page);
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{ x: from, y }],
              });
              for (let i = 1; i <= 5; i++) {
                await cdp.send("Input.dispatchTouchEvent", {
                  type: "touchMove",
                  touchPoints: [{ x: from + ((to - from) * i) / 5, y }],
                });
              }
              await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              expect(widthOf(await boxOf(page, `${IN_VIEW} .session-pane-tree`))).toBeCloseTo(
                90,
                0,
              );
            } finally {
              await context.close();
            }
          },
          E2E_TIMEOUT_MS,
        );
      }

      for (const ratio of ["0.01", "0.28", "0.95"]) {
        test(
          `at 390px with the tree's ratio ${ratio}, the viewer is no narrower than its floor and the Files header's parts neither overlap nor stick out`,
          async () => {
            await withPage(
              { width: 390, height: 844 },
              { "ccmsg.sessionPaneRatio": ratio, "ccmsg.timelinePaneRatio": ratio },
              async (page) => {
                await openTimeline(page);
                await showAgentList(page);
                expect(
                  widthOf(await boxOf(page, `${IN_VIEW} .session-pane-viewer`)),
                ).toBeGreaterThanOrEqual(BODY_MIN_WIDTH - 0.5);
                await page.goto(`${webui.url}s/${SID}/files?path=README.md`);
                await page
                  .locator(`${IN_VIEW} .viewer-path`)
                  .getByText("README.md")
                  .waitFor({ timeout: SETTLE_MS });
                expect(
                  widthOf(await boxOf(page, `${IN_VIEW} .session-pane-viewer`)),
                ).toBeGreaterThanOrEqual(BODY_MIN_WIDTH - 0.5);
                const parts = await page.evaluate((sel) => {
                  const header = document.querySelector(sel);
                  if (header === null) return null;
                  const own = header.getBoundingClientRect();
                  return {
                    header: { left: own.left, top: own.top, right: own.right, bottom: own.bottom },
                    children: [...header.children].map((el) => {
                      const { left, top, right, bottom } = el.getBoundingClientRect();
                      return { name: el.className, left, top, right, bottom };
                    }),
                  };
                }, `${IN_VIEW} .viewer-header`);
                expect(parts).not.toBeNull();
                const children = parts?.children ?? [];
                const header = parts?.header;
                // The path, ☰, 🔍, the modes, 編集, ↻: each drawn with a width.
                expect(children.length).toBeGreaterThanOrEqual(6);
                for (const c of children) {
                  expect({ name: c.name, width: c.right - c.left > 0 }).toEqual({
                    name: c.name,
                    width: true,
                  });
                  expect(c.left).toBeGreaterThanOrEqual((header?.left ?? 0) - 0.5);
                  expect(c.right).toBeLessThanOrEqual((header?.right ?? 0) + 0.5);
                  expect(c.bottom).toBeLessThanOrEqual((header?.bottom ?? 0) + 0.5);
                }
                for (const [i, a] of children.entries()) {
                  for (const b of children.slice(i + 1)) {
                    const overlap =
                      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
                      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
                    expect({ a: a.name, b: b.name, overlap }).toEqual({
                      a: a.name,
                      b: b.name,
                      overlap: false,
                    });
                  }
                }
              },
            );
          },
          E2E_TIMEOUT_MS,
        );
      }
    },
  );
}
