// The footer of a user's prompt bubble in a real browser (DR-0049 §8,
// DR-0058 §3): the time sits right below the bubble, its right edge on the
// bubble's, whether the footer's hover toolbar (its tabs) fits on the
// time's line or not. When it does not fit, the toolbar's
// line goes below the time, not between the bubble and the time.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ef0000-0000-4000-8000-000000000001";
const PROMPT_UUID = "e2ef0000-0000-4000-8000-000000000001";
/** The widths of the Timeline the footer is looked at in: one where the
 * toolbar and the time share a line, one where they do not. */
const VIEWPORTS = [
  { name: "wide", width: 1600 },
  { name: "narrow", width: 960 },
] as const;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-bubble-footer-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = (uuid: string, minute: number) => ({
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: `2026-11-22T00:0${String(minute)}:00.000Z`,
    sessionId: SID,
    cwd,
  });
  fs.writeFileSync(
    transcript,
    row({
      ...head(PROMPT_UUID, 1),
      type: "user",
      message: { role: "user", content: "README の構成を見直して" },
    }) +
      row({
        ...head("e2ef0000-0000-4000-8000-000000000002", 2),
        type: "assistant",
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "README を 3 つの節に分けました。" }],
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

/** Where the prompt's bubble body, its time and its toolbar are drawn. */
async function footerBoxes(page: Page) {
  return page.evaluate((uuid) => {
    const item = document.querySelector(`.tl-lines > [data-timeline-uuid="${uuid}"]`);
    const box = (selector: string) => {
      const el = item?.querySelector(selector);
      if (el === null || el === undefined) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return {
      body: box(".tl-bubble-right > .tl-bubble-body"),
      time: box(".tl-bubble-right > .tl-bubble-footer > .tl-bubble-time"),
      toolbar: box(".tl-bubble-right > .tl-bubble-footer > .tl-msg-toolbar"),
    };
  }, PROMPT_UUID);
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`the footer of a user's prompt in ${engine.name()}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await engine.launch();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    for (const viewport of VIEWPORTS) {
      test(
        `${viewport.name}: the time is right below the bubble, on its right edge; the toolbar is not above it`,
        async () => {
          const page = await browser.newPage({ viewport: { width: viewport.width, height: 800 } });
          try {
            await page.goto(`${webui.url}s/${SID}/timeline/head`);
            await page.getByText("README を 3 つの節に分けました。").waitFor();
            await page.getByText("README の構成を見直して").hover();
            const { body, time, toolbar } = await footerBoxes(page);
            if (body === null || time === null || toolbar === null) {
              throw new Error("the prompt's bubble, time or toolbar is not drawn");
            }
            expect(Math.abs(time.right - body.right)).toBeLessThanOrEqual(1);
            // Right below: less than a line of the time's own height between
            // (on the toolbar's line it is centred on the toolbar's height).
            expect(time.top - body.bottom).toBeGreaterThanOrEqual(0);
            expect(time.top - body.bottom).toBeLessThan(time.bottom - time.top);
            // On the time's line (centred on it), or on a line below it: never
            // on a line between the bubble and the time.
            expect(toolbar.bottom).toBeGreaterThanOrEqual(time.bottom - 1);
          } finally {
            await page.close();
          }
        },
        E2E_TIMEOUT_MS,
      );
    }
  });
}
