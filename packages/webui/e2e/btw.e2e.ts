// btw in a real browser (DR-0060 §5, §7, §8): checking btw in the session's
// input box and sending puts the text to the btw command, not to the session;
// the btw comes into the session's Timeline after the item it was asked at,
// says it runs (「btw 応答中…」) while its answer grows, ends done, and is
// still there after a reload; 取り消し stops a running one. The box is left
// cleared, closed and unchecked.
//
// The daemon's btw command is a fake (config `btw_command`) that records what
// it was handed and writes stream-json lines as claude would: the first part
// of the answer, then, once the test lets it go (a FIFO of its own), the rest
// and the result. The session is the test's own: a hello on the daemon's
// socket, with a transcript the test wrote in a config dir under the daemon's
// HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { BTW_PROMPT_PREFIX, BtwCommandInputSchema, jsonText, parseWith } from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, startWebui, type Webui } from "./harness.ts";

const SID = "e2eb0000-0000-4000-8000-000000000001";
/** The answer's two parts: the fake writes the first at once, the second
 * once the test lets it go. */
const FIRST = "Install の節には";
const REST = " `bun install` の前提が残っている";

/** The fake btw command: its input to `<dir>/input-XXXXXX`, then the first
 * part of the answer; it waits on a FIFO of its own (`<dir>/gate-XXXXXX`) for
 * a line, then writes the rest and a successful result. */
function fakeBtwCommand(dir: string): string {
  const event = (e: object) => ({ type: "stream_event", parent_tool_use_id: null, event: e });
  const delta = (text: string) =>
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  const print = (lines: readonly object[]) =>
    lines.map((l) => `printf '%s\\n' '${JSON.stringify(l)}'\n`).join("");
  const at = (name: string) => JSON.stringify(path.join(dir, name));
  return writeMockBin(
    path.join(dir, "fake-btw"),
    `#!/bin/sh\ncat > "$(mktemp ${at("input-XXXXXX")})"\n` +
      `gate=$(mktemp -u ${at("gate-XXXXXX")})\nmkfifo "$gate"\n` +
      print([
        { type: "system", subtype: "init", session_id: "fork" },
        event({ type: "message_start", message: { id: "m1" } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        delta(FIRST),
      ]) +
      `read line < "$gate"\nrm -f "$gate"\n` +
      print([
        delta(REST),
        { type: "result", subtype: "success", is_error: false, result: FIRST + REST },
      ]),
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

/** Let the one fake command waiting go on: a line to its FIFO, the write
 * waiting for its reader. */
async function releaseGate(): Promise<void> {
  const gates = fs.readdirSync(dir).filter((name) => name.startsWith("gate-"));
  expect(gates).toHaveLength(1);
  await fs.promises.writeFile(path.join(dir, gates[0] ?? ""), "go\n");
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

    const fab = () => page.getByRole("button", { name: "このセッションに入力を送る" });
    const box = () => page.getByRole("dialog", { name: "セッションへの入力" });

    /** Send `question` as a btw from the input box; the box closes. */
    async function ask(question: string): Promise<Locator> {
      await fab().click();
      await box().getByRole("checkbox", { name: "btw" }).check();
      await box().getByRole("textbox").fill(question);
      await box().getByRole("button", { name: "btw で聞く" }).click();
      await box().waitFor({ state: "detached" });
      return page.getByRole("group", { name: "btw" }).filter({ hasText: question });
    }

    test(
      "sent from the input box, a btw comes after the item it was asked at, runs, grows to its answer and stays after a reload",
      async () => {
        const question = `${engine.name()} で聞く横道の質問`;
        const btw = await ask(question);

        // Running: the first part of the answer and the running line.
        await btw.getByText(FIRST).waitFor();
        await btw.getByRole("status").getByText("btw 応答中").waitFor();
        expect(await btw.getAttribute("data-btw-status")).toBe("running");
        expect(inputs()).toContain(`${BTW_PROMPT_PREFIX}\n\n${question}`);
        // After the conversation's items: its anchor is the last row (the
        // assistant's), which comes after the person's prompt.
        const prompt = page.getByText("最初の質問").first();
        const followsPrompt = await btw.evaluate(
          (el, other) =>
            other !== null &&
            (other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
          await prompt.elementHandle(),
        );
        expect(followsPrompt).toBe(true);

        // Let it go: the answer grows to its end and the running line goes.
        await releaseGate();
        await btw.getByText("bun install").waitFor();
        await btw.getByRole("status").waitFor({ state: "detached" });
        expect(await btw.getAttribute("data-btw-status")).toBe("done");
        expect(await btw.innerText()).toContain("の前提が残っている");

        // Kept by the daemon: after a reload it is there, done.
        await page.reload();
        await btw.getByText("bun install").waitFor();
        expect(await btw.getAttribute("data-btw-status")).toBe("done");

        // Opened again, the box is unchecked: the next send goes to the session.
        await fab().click();
        expect(await box().getByRole("checkbox", { name: "btw" }).isChecked()).toBe(false);
        await box().getByRole("button", { name: "入力欄を閉じる" }).click();
      },
      E2E_TIMEOUT_MS,
    );

    test(
      "取り消し stops a running btw, which ends canceled",
      async () => {
        const btw = await ask(`${engine.name()} で取り消す質問`);
        const running = btw.getByRole("status");
        await running.getByText("btw 応答中").waitFor();
        await running.getByRole("button", { name: "取り消し" }).click();
        await btw.getByRole("alert").getByText("取り消した").waitFor();
        expect(await btw.getAttribute("data-btw-status")).toBe("canceled");
        await running.waitFor({ state: "detached" });
        // The stopped command left its FIFO behind.
        for (const name of fs.readdirSync(dir).filter((n) => n.startsWith("gate-"))) {
          fs.rmSync(path.join(dir, name));
        }
      },
      E2E_TIMEOUT_MS,
    );
  });
}
