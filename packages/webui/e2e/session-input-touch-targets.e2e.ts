// The press areas of the session input panel's small buttons on a touch
// screen, in a real browser (kawaz 2026-11-25, DR-0035 §1): at 390px wide, the
// header's ✕ and the row's 📎 and 📋 can be pressed over 2.25rem (36px) where
// there is room for it, without the buttons or anything around them looking
// any different. Where a neighbour leaves no room the area stops at it: 📎 and
// 📋 meet in the middle of the gap between them, 📋 stops in the middle of the
// gap before md | source, ✕ stops at the panel's edge and above the textarea.
// What is next to them (the other button, md | source, the textarea, the
// header's agent select) is still pressed where it is drawn. Without a touch
// screen nothing changes: the areas are the buttons as drawn.
//
// What a point presses is the browser's hit testing (`elementFromPoint`),
// which happy-dom does not do. The sessions are the test's own: hellos on the
// daemon's socket, one named by a short directory and one by a name long
// enough to fill the header, with a subagent written into its status on the
// way to the page (Playwright's WebSocket routing) so the header carries the
// agent select. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { jsonText, parseWith, SessionStatusSnapshotSchema } from "@ccmsg/protocol";
import type { Browser, Page } from "playwright";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SHORT = "e2ec0000-0000-4000-8000-000000000791";
const LONG = "e2ec0000-0000-4000-8000-000000000792";
const LONG_NAME = "a-repository-name-long-enough-to-fill-the-header-row";
/** The press area the buttons are given, 2.25rem. */
const TARGET_PX = 36;
/** What a measured edge may be off by: hit testing rounds a point to the
 * pixel, so an edge at a fraction of a pixel is found up to a pixel off. */
const SLACK_PX = 1;

let dir: string;
let webui: Webui;
const sessions: TestClient[] = [];

async function connectSession(sid: string, cwd: string): Promise<TestClient> {
  fs.mkdirSync(cwd, { recursive: true });
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: sid, cwd };
  const now = Date.now();
  const rows = [
    userContentRow("質問", {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 2000).toISOString(),
    }),
    assistantContentRow([textBlock("答え")], {
      ...head,
      uuid: crypto.randomUUID(),
      timestamp: new Date(now - 1000).toISOString(),
    }),
  ];
  fs.writeFileSync(transcript, rows.map((r) => `${line(r)}\n`).join(""));
  return sessionConn({ sock: webui.sock }, sid, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-touch-");
  webui = await startWebui();
  sessions.push(
    await connectSession(SHORT, path.join(dir, "repo")),
    await connectSession(LONG, path.join(dir, LONG_NAME)),
  );
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  for (const s of sessions) await s.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A line of the daemon's that carries LONG's status (the
 * session_status(_subscribe) reply and the `ev:"session_status"` push). */
const LongStatusLineSchema = jsonText(
  v.looseObject({ ...SessionStatusSnapshotSchema.entries, sid: v.literal(LONG) }),
);

/** Routes the page's WebSocket to the daemon, with a running subagent in
 * every status of LONG on its way to the page. */
async function routeSubagent(page: Page): Promise<void> {
  const withSubagent = (text: string): string =>
    text
      .split("\n")
      .map((row) => {
        const read = parseWith(LongStatusLineSchema, row);
        return read.ok
          ? JSON.stringify({ ...read.value, subagents: [{ id: "a0123456789abcdef" }] })
          : row;
      })
      .join("\n");
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) =>
      ws.send(typeof message === "string" ? withSubagent(message) : message),
    );
  });
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Measured {
  /** The drawn boxes: the panel's padding box, and each part by name. */
  inner: Box;
  drawn: Record<string, Box>;
  /** Where a press lands on each button: from its middle, how far left /
   * right / up / down the points still press it. */
  hit: Record<"close" | "attach" | "paste", Box>;
  /** The parts that a point inside their drawn box does not press. */
  covered: string[];
}

/** Opens the input panel of `sid` and measures it. */
async function openAndMeasure(page: Page, sid: string): Promise<Measured> {
  await page.goto(`${webui.url}s/${sid}/timeline/head`);
  await page.getByRole("button", { name: "このセッションに入力を送る" }).click();
  const panel = page.getByRole("dialog", { name: "セッションへの入力" });
  await panel.waitFor();
  if (sid === LONG) await panel.getByRole("combobox", { name: "入力先のエージェント" }).waitFor();
  return page.evaluate(() => {
    const STEP = 0.25;
    const panelEl = document.querySelector(".session-input-panel");
    if (panelEl === null) throw new Error("no input panel");
    const parts: Record<string, string> = {
      header: ".session-input-panel-header",
      name: ".session-input-target code",
      agent: ".session-input-agent",
      close: ".composer-panel-close",
      field: ".session-input-textarea-ring",
      textarea: ".session-input-textarea",
      row: ".session-input-actions",
      attach: ".session-input-actions .composer-attach-buttons .composer-attach-btn",
      paste: ".session-input-actions .compose-paste-btn",
      tabs: ".session-input-actions .tl-thinking-tabs",
    };
    const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const els: Record<string, Element> = {};
    const drawn: Record<string, ReturnType<typeof box>> = {};
    for (const [name, selector] of Object.entries(parts)) {
      const el = panelEl.querySelector(selector);
      if (el === null) continue;
      els[name] = el;
      drawn[name] = box(el.getBoundingClientRect());
    }
    const style = getComputedStyle(panelEl);
    const outer = panelEl.getBoundingClientRect();
    const inner = {
      left: outer.left + Number.parseFloat(style.borderLeftWidth),
      right: outer.right - Number.parseFloat(style.borderRightWidth),
      top: outer.top + Number.parseFloat(style.borderTopWidth),
      bottom: outer.bottom - Number.parseFloat(style.borderBottomWidth),
    };
    const presses = (el: Element, x: number, y: number) => {
      const at = document.elementFromPoint(x, y);
      return at !== null && el.contains(at);
    };
    const extent = (name: "close" | "attach" | "paste") => {
      const el = els[name];
      const d = drawn[name];
      if (el === undefined || d === undefined) throw new Error(`no ${name}`);
      const cx = (d.left + d.right) / 2;
      const cy = (d.top + d.bottom) / 2;
      let left = cx;
      while (presses(el, left - STEP, cy)) left -= STEP;
      let right = cx;
      while (presses(el, right + STEP, cy)) right += STEP;
      let top = cy;
      while (presses(el, cx, top - STEP)) top -= STEP;
      let bottom = cy;
      while (presses(el, cx, bottom + STEP)) bottom += STEP;
      return { left, right, top, bottom };
    };
    const hit = { close: extent("close"), attach: extent("attach"), paste: extent("paste") };
    // Every point on each pressable part's middle lines, edge to edge (a pixel
    // in: hit testing rounds a point to the pixel), presses it. The corners
    // are left out: they are rounded, and a rounded corner is not the
    // element's to press.
    const covered: string[] = [];
    for (const name of ["agent", "close", "textarea", "attach", "paste", "tabs"]) {
      const el = els[name];
      const d = drawn[name];
      if (el === undefined || d === undefined) continue;
      const cx = (d.left + d.right) / 2;
      const cy = (d.top + d.bottom) / 2;
      let all = true;
      for (let i = 0; i <= 8; i++) {
        const x = d.left + 1 + ((d.right - d.left - 2) * i) / 8;
        const y = d.top + 1 + ((d.bottom - d.top - 2) * i) / 8;
        if (!presses(el, x, cy) || !presses(el, cx, y)) all = false;
      }
      if (!all) covered.push(name);
    }
    return { inner, drawn, hit, covered };
  });
}

const width = (b: Box) => b.right - b.left;
const height = (b: Box) => b.bottom - b.top;

/** What the person sees of the panel, rounded to a tenth of a pixel: each
 * part's left, width and height. The rows' heights differ between a touch
 * screen and a mouse (the send button is taller on touch), so tops are not
 * compared. */
function looks(m: Measured): Record<string, number[]> {
  const r = (n: number) => Math.round(n * 10) / 10;
  return Object.fromEntries(
    Object.entries(m.drawn)
      .filter(([name]) => name !== "row" && name !== "field" && name !== "textarea")
      .map(([name, b]) => [name, [r(b.left), r(width(b)), r(height(b))]]),
  );
}

function drawnPart(m: Measured, name: string): Box {
  const b = m.drawn[name];
  if (b === undefined) throw new Error(`${name} is not drawn`);
  return b;
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`input panel press areas (${engine.name()})`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    async function measureIn(sid: string, hasTouch: boolean): Promise<Measured> {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch });
      try {
        const page = await context.newPage();
        await routeSubagent(page);
        return await openAndMeasure(page, sid);
      } finally {
        await context.close();
      }
    }

    for (const [label, sid] of [
      ["a short name", SHORT],
      ["a long name and the agent select", LONG],
    ] as const) {
      test(
        `${label}: on touch the areas grow, stop at their neighbours, and nothing looks different`,
        async () => {
          const touch = await measureIn(sid, true);
          const mouse = await measureIn(sid, false);
          expect(looks(touch)).toEqual(looks(mouse));
          expect(touch.covered).toEqual([]);

          const close = touch.hit.close;
          const closeDrawn = drawnPart(touch, "close");
          const field = drawnPart(touch, "field");
          // The agent select, when the name is long enough to bring it next
          // to ✕, keeps its own press area: ✕'s stops at it.
          const agentRight = touch.drawn.agent?.right ?? Number.NEGATIVE_INFINITY;
          expect(close.left).toBeGreaterThanOrEqual(
            Math.min(closeDrawn.left, agentRight) - SLACK_PX,
          );
          expect(width(close)).toBeGreaterThanOrEqual(
            Math.min(TARGET_PX, touch.inner.right - agentRight) - SLACK_PX,
          );
          expect(close.right).toBeLessThanOrEqual(touch.inner.right + SLACK_PX);
          expect(close.top).toBeGreaterThanOrEqual(touch.inner.top - SLACK_PX);
          expect(close.bottom).toBeLessThanOrEqual(field.top + SLACK_PX);
          expect(height(close)).toBeGreaterThanOrEqual(
            Math.min(TARGET_PX, field.top - touch.inner.top) - SLACK_PX,
          );
          expect(height(close)).toBeGreaterThan(height(closeDrawn));

          const attach = touch.hit.attach;
          const paste = touch.hit.paste;
          const attachDrawn = drawnPart(touch, "attach");
          const pasteDrawn = drawnPart(touch, "paste");
          const tabs = drawnPart(touch, "tabs");
          const between = (attachDrawn.right + pasteDrawn.left) / 2;
          const beforeTabs = (pasteDrawn.right + tabs.left) / 2;
          for (const b of [attach, paste]) {
            expect(height(b)).toBeGreaterThanOrEqual(TARGET_PX - SLACK_PX);
            expect(b.top).toBeGreaterThanOrEqual(field.bottom - SLACK_PX);
            expect(b.bottom).toBeLessThanOrEqual(touch.inner.bottom + SLACK_PX);
          }
          expect(attach.left).toBeGreaterThanOrEqual(touch.inner.left - SLACK_PX);
          expect(Math.abs(attach.right - between)).toBeLessThanOrEqual(SLACK_PX);
          expect(width(attach)).toBeGreaterThanOrEqual(
            Math.min(TARGET_PX, between - touch.inner.left) - SLACK_PX,
          );
          expect(Math.abs(paste.left - between)).toBeLessThanOrEqual(SLACK_PX);
          expect(Math.abs(paste.right - beforeTabs)).toBeLessThanOrEqual(SLACK_PX);
        },
        E2E_TIMEOUT_MS,
      );

      test(
        `${label}: without a touch screen the areas are the buttons as drawn`,
        async () => {
          const mouse = await measureIn(sid, false);
          expect(mouse.covered).toEqual([]);
          for (const name of ["close", "attach", "paste"] as const) {
            const hit = mouse.hit[name];
            const d = drawnPart(mouse, name);
            expect(Math.abs(hit.left - d.left)).toBeLessThanOrEqual(1);
            expect(Math.abs(hit.right - d.right)).toBeLessThanOrEqual(1);
            expect(Math.abs(hit.top - d.top)).toBeLessThanOrEqual(1);
            expect(Math.abs(hit.bottom - d.bottom)).toBeLessThanOrEqual(1);
          }
        },
        E2E_TIMEOUT_MS,
      );
    }
  });
}
