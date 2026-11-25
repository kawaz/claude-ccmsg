// The 「↑前 | 次↓」 of a user's prompt in a real browser (DR-0058 §3): on a
// Timeline whose first page does not reach the transcript's start, ↑前 of the
// window's first prompt reads the older page in and lands on the prompt before
// it, with that prompt's own row of controls in the view below the toolbar (so
// ↑前 / 次↓ can be pressed again at once); there ↑前 is disabled (the oldest
// prompt), 次↓ moves back, and 次↓ of the newest prompt is disabled.
//
// The session is the test's own: a hello on the daemon's socket, with a
// transcript the test wrote in a config dir under the daemon's HOME. Nothing
// reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { TRANSCRIPT_READ_MAX_BYTES } from "@ccmsg/protocol";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2ed0000-0000-4000-8000-000000000001";
const uuidOf = (n: number): string => `e2ed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROMPTS = [
  { uuid: uuidOf(1), text: "最初の質問" },
  { uuid: uuidOf(2), text: "二番目の質問" },
  { uuid: uuidOf(3), text: "三番目の質問" },
] as const;
/** How long to wait for the page to settle on a state (a read, a smooth
 * scroll's end). */
const SETTLE_MS = 10_000;

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-prompt-steps-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  let seq = 100;
  const head = (uuid?: string) => {
    seq += 1;
    return {
      uuid: uuid ?? uuidOf(seq),
      parentUuid: null,
      isSidechain: false,
      timestamp: `2026-11-22T01:${String(seq - 100).padStart(2, "0")}:00.000Z`,
      sessionId: SID,
      cwd,
    };
  };
  const prompt = (p: { uuid: string; text: string }) =>
    row({ ...head(p.uuid), type: "user", message: { role: "user", content: p.text } });
  const answer = (label: string) =>
    row({
      ...head(),
      type: "assistant",
      message: {
        model: "claude-opus-5-5",
        role: "assistant",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: "text",
            text: Array.from({ length: 30 }, (_, i) => `${label}の段落 ${String(i + 1)}。`).join(
              "\n\n",
            ),
          },
        ],
      },
    });
  // Rows that fold away, more than the first page's bytes: the first prompt
  // is before the window the Timeline opens with.
  const filler = Array.from({ length: 5 }, () =>
    row({
      ...head(),
      type: "system",
      subtype: "informational",
      level: "info",
      content: "x".repeat(Math.ceil(TRANSCRIPT_READ_MAX_BYTES / 4)),
    }),
  ).join("");
  fs.writeFileSync(
    transcript,
    prompt(PROMPTS[0]) +
      answer("最初の答え") +
      filler +
      prompt(PROMPTS[1]) +
      answer("二番目の答え") +
      prompt(PROMPTS[2]) +
      answer("三番目の答え"),
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
  describe.skipIf(skipsEngine(engine))(`↑前 | 次↓ of a prompt in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.getByText("三番目の答えの段落 30。").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    const itemOf = (uuid: string): Locator =>
      page.locator(`.tl-lines > [data-timeline-uuid="${uuid}"]`);
    const stepOf = (uuid: string, name: "↑前" | "次↓"): Locator =>
      itemOf(uuid).getByRole("button", { name });

    /** Once the scroller has stopped (the landing's smooth scroll ended: the
     * same scrollTop over 10 frames), whether `uuid`'s row of controls above
     * its bubble sits right below the toolbar, in the view. */
    async function landedOn(uuid: string): Promise<boolean> {
      await itemOf(uuid).waitFor({ timeout: SETTLE_MS });
      return page.evaluate(async (id) => {
        const scroller = document.querySelector(".timeline-view");
        const toolbar = document.querySelector(".tl-toolbar");
        if (scroller === null || toolbar === null) return false;
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        let last = -1;
        for (let still = 0; still < 10;) {
          await frame();
          still = scroller.scrollTop === last ? still + 1 : 0;
          last = scroller.scrollTop;
        }
        const steps = document.querySelector(
          `.tl-lines > [data-timeline-uuid="${id}"] > .tl-item-prompt-steps`,
        );
        if (steps === null) return false;
        const gap = steps.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom;
        return gap >= -0.5 && gap <= 8;
      }, uuid);
    }

    async function press(uuid: string, name: "↑前" | "次↓"): Promise<void> {
      await itemOf(uuid).hover();
      await stepOf(uuid, name).click();
    }

    test(
      "↑前 reads the prompt before the window in and lands on it, 次↓ moves back; the oldest's ↑前 and the newest's 次↓ are disabled",
      async () => {
        // Opened at the end: the first prompt is not in the window.
        expect(await itemOf(PROMPTS[0].uuid).count()).toBe(0);
        expect(await stepOf(PROMPTS[2].uuid, "次↓").isDisabled()).toBe(true);
        await itemOf(PROMPTS[1].uuid).scrollIntoViewIfNeeded();
        expect(await stepOf(PROMPTS[1].uuid, "↑前").isDisabled()).toBe(false);

        await press(PROMPTS[1].uuid, "↑前");
        expect(await landedOn(PROMPTS[0].uuid)).toBe(true);
        expect(page.url()).toContain(`/timeline/${PROMPTS[0].uuid}`);
        expect(await stepOf(PROMPTS[0].uuid, "↑前").isDisabled()).toBe(true);

        // Pressed again at once, from the controls the landing left in view.
        await press(PROMPTS[0].uuid, "次↓");
        expect(await landedOn(PROMPTS[1].uuid)).toBe(true);
        expect(page.url()).toContain(`/timeline/${PROMPTS[1].uuid}`);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
