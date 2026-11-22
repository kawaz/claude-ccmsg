// Unconfirmed sends that landed, in a real browser (DR-0035 §5): a send the
// input box holds as unconfirmed goes from the box once the session's
// transcript holds a prompt of the person with the text it sent, written
// after it was sent. A send whose text the transcript does not hold stays.
//
// The page opens on the session the way it does after a reload: the records
// are already in its localStorage, and the prompt is already in the
// transcript, so the daemon's `last_user_input_at` for the session (read from
// the transcript when the daemon first knows it) has reached the sends. The
// box then asks the daemon's prompt_rows for what was written since, and
// settles the one that landed. The session is the test's own: a hello on the
// daemon's socket, with a transcript the test wrote in a config dir under the
// daemon's HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const LANDED = "重い処理の後で見てほしい";
const NOT_LANDED = "こちらはまだ届いていない";

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;
/** When the two sends were made: a minute ago. */
const sentAt = new Date(Date.now() - 60_000).toISOString();
beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-landing-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  // The sent text, as the harness writes a typed prompt, 30 s after the sends.
  fs.writeFileSync(
    transcript,
    row({
      type: "user",
      uuid: "e2ec1000-0000-4000-8000-000000000001",
      parentUuid: null,
      isSidechain: false,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: SID,
      cwd,
      origin: { kind: "human" },
      promptSource: "typed",
      message: { role: "user", content: LANDED },
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

/** The box's records of the two sends, unconfirmed, as session-input-store
 * keeps them. */
function seedSends(): string {
  return JSON.stringify([
    // The daemon's time of the send, as its unconfirmed reply carried it.
    { id: "landed", text: LANDED, sentAt, receivedAt: sentAt, state: "unconfirmed" },
    { id: "not-landed", text: NOT_LANDED, sentAt, state: "unconfirmed" },
  ]);
}

for (const engine of BROWSERS) {
  describe(`unconfirmed sends that landed, in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.addInitScript(
        ({ key, value }) => {
          // Only on the first load: the box's own writes stay after it.
          if (sessionStorage.getItem("seeded") === null) {
            localStorage.setItem(key, value);
            sessionStorage.setItem("seeded", "1");
          }
        },
        { key: `ccmsg.sessionInput.sends.${SID}`, value: seedSends() },
      );
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.locator(".tl-bubble-right").filter({ hasText: LANDED }).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "the send whose text the transcript holds goes; the other stays",
      async () => {
        await page.getByRole("button", { name: "このセッションに入力を送る" }).click();
        const box = page.getByRole("dialog", { name: "セッションへの入力" });
        const excerpts = box.locator(".session-input-notice-excerpt");
        await excerpts.filter({ hasText: NOT_LANDED }).waitFor();
        await excerpts.filter({ hasText: LANDED }).waitFor({ state: "detached" });
        expect(await excerpts.allInnerTexts()).toEqual([`「${NOT_LANDED}」`]);
        await box.getByRole("button", { name: "入力欄を閉じる" }).click();
      },
      E2E_TIMEOUT_MS,
    );
  });
}
