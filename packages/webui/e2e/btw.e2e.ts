// btw in a real browser (DR-0060 §7, §8): checking btw in the session's input
// box and sending puts the text to the btw command, not to the session, and
// the answer comes into the session's Timeline right after the item it was
// asked at, framed apart from the conversation; the box is left cleared,
// closed and unchecked.
//
// The daemon's btw command is a fake (config `btw_command`) that records what
// it was handed and writes a canned stream-json. The session is the test's
// own: a hello on the daemon's socket, with a transcript the test wrote in a
// config dir under the daemon's HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright";
import { BTW_PROMPT_PREFIX, BtwCommandInputSchema, jsonText, parseWith } from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2eb0000-0000-4000-8000-000000000001";
const ANSWER = "Install の節には `bun install` の前提が残っている";

/** The fake btw command: its input to `<dir>/input-<n>.json`, then an answer
 * in two deltas and a successful result. */
function fakeBtwCommand(dir: string): string {
  const event = (e: object) => ({ type: "stream_event", parent_tool_use_id: null, event: e });
  const lines = [
    { type: "system", subtype: "init", session_id: "fork" },
    event({ type: "message_start", message: { id: "m1" } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: ANSWER.slice(0, 10) },
    }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: ANSWER.slice(10) },
    }),
    { type: "result", subtype: "success", is_error: false, result: ANSWER },
  ];
  const input = JSON.stringify(path.join(dir, "input"));
  return writeMockBin(
    path.join(dir, "fake-btw"),
    `#!/bin/sh\ncat > "$(mktemp ${input}-XXXXXX)"\n` +
      lines.map((l) => `printf '%s\\n' '${JSON.stringify(l)}'`).join("\n") +
      "\n",
  );
}

const row = (fields: object): string => `${JSON.stringify(fields)}\n`;

let dir: string;
let webui: Webui;
let session: TestClient;
beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-btw-");
  webui = await startWebui({ config: { btw_command: [fakeBtwCommand(dir)] } });
  // The session's place: a cwd, and its transcript in a config dir of its own.
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  const transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const at = (s: number) => `2026-11-22T00:00:0${String(s)}.000Z`;
  fs.writeFileSync(
    transcript,
    row({
      type: "user",
      uuid: "e2e00000-0000-4000-8000-000000000001",
      parentUuid: null,
      isSidechain: false,
      timestamp: at(1),
      sessionId: SID,
      cwd,
      message: { role: "user", content: "最初の質問" },
    }) +
      row({
        type: "assistant",
        uuid: "e2e00000-0000-4000-8000-000000000002",
        parentUuid: "e2e00000-0000-4000-8000-000000000001",
        isSidechain: false,
        timestamp: at(2),
        sessionId: SID,
        cwd,
        message: {
          model: "claude-opus-5-5",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "最初の答え" }],
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

const InputText = jsonText(BtwCommandInputSchema);

/** What the fake command was handed, each time it ran. */
function inputs(): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("input-"))
    .flatMap((name) => {
      const read = parseWith(InputText, fs.readFileSync(path.join(dir, name), "utf8"));
      return read.ok ? [read.value.prompt] : [];
    });
}

for (const engine of BROWSERS) {
  describe(`btw in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      await page.getByText("最初の質問").waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    test(
      "a btw sent from the input box comes into the Timeline after the item it was asked at",
      async () => {
        const question = `${engine.name()} で聞く横道の質問`;
        await page.getByRole("button", { name: "このセッションに入力を送る" }).click();
        const box = page.getByRole("dialog", { name: "セッションへの入力" });
        await box.getByRole("checkbox", { name: "btw" }).check();
        await box.getByRole("textbox").fill(question);
        await box.getByRole("button", { name: "btw で聞く" }).click();

        // The box is left as a send leaves it: closed.
        await box.waitFor({ state: "detached" });
        const btw = page.locator(".tl-btw").filter({ hasText: question });
        await btw.getByText("bun install").waitFor();
        expect(await btw.locator(".tl-btw-answer").innerText()).toContain("の前提が残っている");
        // After the conversation's items: the last row, the assistant's,
        // is its anchor, and the person's prompt comes before it.
        const answer = page.locator(".tl-item").filter({ hasText: "最初の質問" }).first();
        const followsAnswer = await btw.evaluate(
          (el, other) =>
            other !== null &&
            (other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          await answer.elementHandle(),
        );
        expect(followsAnswer).toBe(true);
        expect(inputs()).toContain(`${BTW_PROMPT_PREFIX}\n\n${question}`);

        // Opened again, the box is unchecked: the next send goes to the session.
        await page.getByRole("button", { name: "このセッションに入力を送る" }).click();
        expect(await box.getByRole("checkbox", { name: "btw" }).isChecked()).toBe(false);
        await box.getByRole("button", { name: "入力欄を閉じる" }).click();
      },
      E2E_TIMEOUT_MS,
    );
  });
}
