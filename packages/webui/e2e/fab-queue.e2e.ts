// The FAB's queue in a real browser (DR-0062 §11, §13, §15): with 今すぐ送る
// off, two sends from the FAB are put in the daemon's queue and reach the
// session as nothing (the FAB shows 2); in the 💬 filter's preview area they
// are listed one by one under the comments, and 全部送る puts them into the
// session as two prompts, one per draft, in the order they were put (not
// joined into one).
//
// The session is the test's own: a hello on the daemon's socket with a
// transcript the test wrote, and a sidecar the test stands in for (it takes
// the daemon's prompt.send and answers it as the module would, accepted).
// Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { fakeSidecar, nextRequest, sidecarReply } from "../../daemon/test/fake-sidecar.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2ec0000-0000-4000-8000-000000000001";
const id = (k: number) => `e2ec0000-0000-4000-8000-${String(k).padStart(12, "0")}`;

let dir: string;
let webui: Webui;
let session: TestClient;
let sidecar: Awaited<ReturnType<typeof fakeSidecar>>;
/** The texts the session was given (prompt.send), in order. */
const given: string[] = [];

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-fabq-");
  webui = await startWebui();
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const head = { sessionId: SID, cwd };
  fs.writeFileSync(
    transcript,
    [
      userContentRow("質問 1", { ...head, uuid: id(1), timestamp: "2020-01-01T00:00:01.000Z" }),
      assistantContentRow([textBlock("答え 1")], {
        ...head,
        uuid: id(2),
        timestamp: "2020-01-01T00:00:02.000Z",
      }),
    ]
      .map((r) => `${line(r)}\n`)
      .join(""),
  );
  session = await sessionConn({ sock: webui.sock }, SID, {
    cwd,
    transcript_path: transcript,
    config_dir: configDir,
  });
  sidecar = await fakeSidecar(
    { sock: webui.sock, stateDir: path.dirname(webui.sock) },
    SID,
    "run1",
  );
  // The module: each prompt.send is taken in (accepted), and its text kept.
  void (async () => {
    for (;;) {
      const request = await nextRequest(sidecar).catch(() => null);
      if (request === null) return;
      if (request.op !== "prompt.send") continue;
      given.push(request.args.text);
      await session.request(
        sidecarReply({ id: request.id, ok: true, result: { outcome: "accepted" } }),
      );
    }
  })();
}, E2E_TIMEOUT_MS);

afterAll(async () => {
  sidecar.close();
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const engine of BROWSERS) {
  describe(`the FAB's queue, in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      given.splice(0);
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.locator(".tl-bubble-right").filter({ hasText: "質問 1" }).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "two drafts queued from the FAB go in as two prompts with 全部送る",
      async () => {
        const fab = page.locator(".session-input-fab");
        const box = page.getByRole("dialog", { name: "セッションへの入力" });
        for (const text of [`一つ目 ${engine.name()}`, `二つ目 ${engine.name()}`]) {
          await fab.click();
          const sendNow = box.getByRole("checkbox", { name: "今すぐ送る" });
          if (await sendNow.isChecked()) await sendNow.uncheck();
          await box.locator(".session-input-textarea").fill(text);
          await box.getByRole("button", { name: "後で送る" }).click();
          await box.waitFor({ state: "detached" });
        }
        await page.locator(".session-input-fab-count").filter({ hasText: "2" }).waitFor();
        expect(given).toEqual([]);

        await page.goto(`${webui.url}s/${SID}/timeline/head?filter=comment`);
        const drafts = page.locator(".tl-draft-item");
        await drafts.nth(1).waitFor();
        expect(await page.locator(".tl-draft-text").allInnerTexts()).toEqual([
          `一つ目 ${engine.name()}`,
          `二つ目 ${engine.name()}`,
        ]);
        await page.locator(".tl-comments-send-all").click();
        // Sent ones are not listed (each goes once its row is seen).
        await drafts.first().waitFor({ state: "detached" });
        expect(given).toEqual([`一つ目 ${engine.name()}`, `二つ目 ${engine.name()}`]);
      },
      E2E_TIMEOUT_MS,
    );
  });
}
