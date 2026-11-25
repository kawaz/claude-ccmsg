// btw in a real browser (DR-0062 §12, §14): the btw pill of the session's
// input box (a btw comment at the moment of the conversation) and the comment
// form's btw put the comment's block to a fork of the session's main
// conversation (`fork.ask` to the session's hooks module, DR-0060 §2), not to
// the session; the btw comes into the session's Timeline after the item it
// was sent at, says it runs (「btw 応答中…」) until its answer comes, ends
// done, and is still there after a reload, right after the answer it was sent
// at even when the session's rows written after it are older than it;
// 取り消し stops a running one (`fork.stop`). The box is left cleared, closed
// and unchecked.
//
// The session's hooks module is the test's: a fake sidecar (as the daemon's
// tests stand one in) that says it runs every op, keeps each `fork.ask` until
// the test lets it go, then answers it whole, and answers a `fork.stop` by
// stopping the fork it names. The session is the test's own too: a hello on
// the daemon's socket, with a transcript the test writes (rows of the shape
// Claude Code writes, from the protocol's row fixtures) in a config dir under
// the daemon's HOME. Nothing reaches a Claude Code session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { BTW_PROMPT_PREFIX, parseCommentBlocks, SIDECAR_OP_NAMES } from "@ccmsg/protocol";
import {
  assistantContentRow,
  line,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { shortTmpDir } from "../../testkit/src/tmp.ts";
import { fakeSidecar, nextRequest, sidecarReply } from "../../daemon/test/fake-sidecar.ts";
import { sessionConn, type TestClient } from "../../daemon/test/helpers.ts";
import { BROWSERS, E2E_TIMEOUT_MS, skipsEngine, startWebui, type Webui } from "./harness.ts";

const SID = "e2eb0000-0000-4000-8000-000000000001";
/** The answer the fake module's fork gives. */
const ANSWER = "Install の節には `bun install` の前提が残っている";

/** A `fork.ask` the fake module holds: its prompt, and the answer to give it. */
interface HeldFork {
  key: string;
  prompt: string;
  answer(result: object): Promise<void>;
}

let dir: string;
let webui: Webui;
let session: TestClient;
let sidecar: Awaited<ReturnType<typeof fakeSidecar>>;
/** Every fork the module was asked, in order. */
const forksAsked: HeldFork[] = [];
/** The forks not answered yet. */
const held: HeldFork[] = [];
let cwd: string;
let transcript: string;
/** How many exchanges (a person's prompt and its answer) the transcript holds. */
let exchanges = 0;

/** Append the next exchange to the transcript, `質問 <n>` and `答え <n>`,
 * written at minute `n` of a day long past: every exchange is older than any
 * btw the test asks. Returns `n`. */
function appendExchange(): number {
  exchanges += 1;
  const n = exchanges;
  const id = (k: number) => `e2e00000-0000-4000-8000-${String(n * 10 + k).padStart(12, "0")}`;
  const at = (second: number) =>
    `2020-01-01T00:${String(n).padStart(2, "0")}:0${String(second)}.000Z`;
  const head = { sessionId: SID, cwd };
  fs.appendFileSync(
    transcript,
    `${line(
      userContentRow(`質問 ${String(n)}`, {
        ...head,
        uuid: id(1),
        parentUuid:
          n === 1 ? null : `e2e00000-0000-4000-8000-${String((n - 1) * 10 + 2).padStart(12, "0")}`,
        timestamp: at(1),
      }),
    )}\n${line(
      assistantContentRow([textBlock(`答え ${String(n)}`)], {
        ...head,
        uuid: id(2),
        parentUuid: id(1),
        timestamp: at(2),
      }),
    )}\n`,
  );
  return n;
}

beforeAll(async () => {
  dir = shortTmpDir("ccmsg-e2e-btw-");
  webui = await startWebui();
  // The session's place: a cwd, and its transcript in a config dir of its own.
  cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  const configDir = path.join(webui.home, ".claude-e2e");
  transcript = path.join(configDir, "projects", "-e2e", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  appendExchange();
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
  // The module: it runs every op; a fork.ask is held, a fork.stop stops the
  // held fork it names.
  const reply = (id: string, result: object) =>
    session.request(sidecarReply({ id, ok: true, result }));
  void (async () => {
    for (;;) {
      const request = await nextRequest(sidecar).catch(() => null);
      if (request === null) return;
      switch (request.op) {
        case "describe":
          await reply(request.id, { v: [1], ops: [...SIDECAR_OP_NAMES] });
          break;
        case "fork.ask": {
          const fork: HeldFork = {
            key: request.args.key,
            prompt: request.args.prompt,
            answer: async (result) => {
              held.splice(held.indexOf(fork), 1);
              await reply(request.id, result);
            },
          };
          forksAsked.push(fork);
          held.push(fork);
          break;
        }
        case "fork.stop": {
          const fork = held.find((f) => f.key === request.args.key);
          await reply(request.id, { outcome: fork !== undefined ? "stopped" : "not_running" });
          await fork?.answer({ outcome: "not_answered", reason: "stopped" });
          break;
        }
        default:
          break;
      }
    }
  })();
}, E2E_TIMEOUT_MS);
afterAll(async () => {
  sidecar.close();
  await session.end();
  await webui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Answer the one fork the module holds, as a fork that answered. */
async function answerFork(): Promise<void> {
  expect(held).toHaveLength(1);
  await held[0]?.answer({ outcome: "answered", text: ANSWER });
}

for (const engine of BROWSERS) {
  describe.skipIf(skipsEngine(engine))(`btw in ${engine.name()}`, () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await engine.launch();
      page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${webui.url}s/${SID}/timeline/head`);
      // The answer's own bubble: the engine before this one leaves a btw on
      // it in the daemon, whose head quotes the same text.
      await page.locator(".tl-bubble-assistant").getByText("答え 1", { exact: true }).waitFor();
    }, E2E_TIMEOUT_MS);
    afterAll(async () => {
      await browser.close();
    });

    const fab = () => page.getByRole("button", { name: "このセッションに入力を送る" });
    const box = () => page.getByRole("dialog", { name: "セッションへの入力" });

    /** Whether `first` comes before `second` in the page. */
    async function before(first: Locator, second: Locator): Promise<boolean> {
      return first.evaluate(
        (el, other) =>
          other !== null &&
          (el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        await second.elementHandle(),
      );
    }

    /** Send `question` as a btw from the input box; the box closes. */
    async function ask(question: string): Promise<Locator> {
      await fab().click();
      // The split button: pressing btw chooses it, pressing it chosen asks.
      await box().getByRole("button", { name: "btw に切り替える" }).click();
      await box().getByRole("textbox").fill(question);
      await box().getByRole("button", { name: "btw で聞く" }).click();
      await box().waitFor({ state: "detached" });
      return page.getByRole("group", { name: "btw" }).filter({ hasText: question });
    }

    test(
      "sent from the input box, a btw comes after the item it was asked at, runs, grows to its answer and stays after a reload",
      async () => {
        const question = `${engine.name()} で聞く横道の質問`;
        // Its anchor: the last row when it is asked, the answer of this exchange.
        const asked = exchanges;
        const btw = await ask(question);

        // Running: the running line, until the fork's answer comes.
        await btw.getByRole("status").getByText("btw 応答中").waitFor();
        expect(await btw.getAttribute("data-btw-status")).toBe("running");
        // The fork is asked the btw comment's block (DR-0062 §14): at the
        // moment of the conversation, its cid and its text alone.
        const head = `${BTW_PROMPT_PREFIX}\n\n`;
        const blocks = forksAsked
          .map((fork) => fork.prompt)
          .filter((prompt) => prompt.startsWith(head))
          .flatMap((prompt) => parseCommentBlocks(prompt.slice(head.length)));
        expect(blocks.find((block) => block.body === question)?.on).toBeUndefined();
        expect(blocks.some((block) => block.body === question)).toBe(true);
        // Right after the answer it was asked at (its anchor).
        const answer = page.getByText(`答え ${String(asked)}`, { exact: true });
        expect(await before(answer, btw)).toBe(true);

        // Let it go: the answer comes whole and the running line goes.
        await answerFork();
        await btw.getByText("bun install").waitFor();
        await btw.getByRole("status").waitFor({ state: "detached" });
        expect(await btw.getAttribute("data-btw-status")).toBe("done");
        expect(await btw.innerText()).toContain("の前提が残っている");

        // The session goes on: a later exchange, written at a time older
        // than the btw. Kept by the daemon, after a reload the btw is there,
        // done, still right after its anchor and before the later exchange,
        // where its time alone would not put it.
        const next = appendExchange();
        await page.reload();
        await btw.getByText("bun install").waitFor();
        expect(await btw.getAttribute("data-btw-status")).toBe("done");
        const later = page.getByText(`質問 ${String(next)}`, { exact: true });
        await later.waitFor();
        expect(await before(answer, btw)).toBe(true);
        expect(await before(btw, later)).toBe(true);

        // Opened again, 送る is chosen: the next send goes to the session.
        await fab().click();
        expect(
          await box()
            .getByRole("button", { name: "送る", exact: true })
            .getAttribute("aria-current"),
        ).toBe("true");
        expect(
          await box()
            .getByRole("button", { name: "btw に切り替える" })
            .getAttribute("aria-current"),
        ).toBeNull();
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
        // The fork was stopped in the session (fork.stop).
        expect(held).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    // コメントのフォームの btw (DR-0062 §12, §14): 答えへの返信を btw で送ると、本体に
    // 入れずに fork が答え、質問と答えが 1 項目で出る。全体を囲む枠は無く、質問は
    // コメントの点線の吹き出し、答えはエージェントの返信の吹き出しで、どちらの頭にも
    // btw のバッジが付く。答えには返信が付く。
    test(
      "a comment asked as a btw from the form is answered by a fork, its question a comment's bubble and its answer a reply's, both badged btw",
      async () => {
        const question = `${engine.name()} でコメントから聞く btw`;
        const answer = page.locator(".tl-bubble-assistant").filter({ hasText: "答え 1" });
        await answer.locator(".tl-comment-reply").click();
        const form = page.getByRole("dialog", { name: "コメントを書く" });
        await form.getByRole("button", { name: "btw に切り替える" }).click();
        const asking = form.getByRole("button", { name: "btw で聞く" });
        expect(await asking.getAttribute("aria-current")).toBe("true");
        await form.getByRole("textbox").fill(question);
        expect(
          await form
            .getByRole("button", { name: "後で に切り替える" })
            .getAttribute("aria-current"),
        ).toBeNull();
        await asking.click();
        await form.waitFor({ state: "detached" });
        const btw = page.getByRole("group", { name: "btw" }).filter({ hasText: question });
        await btw.getByRole("status").getByText("btw 応答中").waitFor();
        // The fork was asked the comment's block, after the btw prefix.
        const prompt = forksAsked.map((fork) => fork.prompt).find((p) => p.includes(question));
        expect(prompt?.startsWith("<btw>")).toBe(true);
        expect(prompt).toContain('"on":"msg_start_with:答え 1"');
        await answerFork();
        await page
          .locator('.tl-btw[data-btw-status="done"]')
          .filter({ hasText: question })
          .waitFor();
        expect(await btw.locator(".tl-btw-answer").textContent()).toContain("前提が残っている");
        expect(await btw.locator(".tl-btw-answer .tl-comment-reply").count()).toBe(1);
        // No frame around the two: the question in a comment's dashed bubble,
        // the answer in the bubble of an agent's reply (its accent left edge),
        // each with the btw badge at its head.
        const borderOf = (at: Locator) =>
          at.evaluate((el) => {
            const style = getComputedStyle(el);
            return {
              top: [style.borderTopStyle, style.borderTopWidth],
              left: [style.borderLeftStyle, style.borderLeftWidth],
            };
          });
        expect(await borderOf(btw)).toEqual({ top: ["none", "0px"], left: ["none", "0px"] });
        const asked = btw.locator(".tl-bubble-comment");
        const answered = btw.locator(".tl-btw-answer");
        expect((await borderOf(asked.locator(":scope > .tl-bubble-body"))).top).toEqual([
          "dashed",
          "1px",
        ]);
        expect(await answered.getAttribute("class")).toContain("tl-bubble-comment-reply");
        expect((await borderOf(answered.locator(":scope > .tl-bubble-body"))).left).toEqual([
          "solid",
          "3px",
        ]);
        for (const side of [asked, answered]) {
          expect(await side.getByText("btw", { exact: true }).isVisible()).toBe(true);
        }
        // The answer's foot has the md | source tabs of a reply's bubble
        // (DR-0062 §12): md draws the markdown, source the text as written.
        // The question, a person's comment, has none.
        const views = answered.getByRole("tablist", { name: "本文の表示形式" });
        expect(await asked.getByRole("tablist", { name: "本文の表示形式" }).count()).toBe(0);
        const answerBody = answered.locator(":scope > .tl-bubble-body");
        expect(await answerBody.locator("code").first().textContent()).toBe("bun install");
        await answered.hover();
        await views.getByRole("tab", { name: "source", exact: true }).click();
        await answerBody.locator(".tl-bubble-source").getByText(ANSWER).waitFor();
        expect(
          await views
            .getByRole("tab", { name: "source", exact: true })
            .getAttribute("aria-selected"),
        ).toBe("true");
        await views.getByRole("tab", { name: "md", exact: true }).click();
        await answerBody.locator(".tl-bubble-source").waitFor({ state: "detached" });
        expect(await answerBody.locator("code").first().textContent()).toBe("bun install");
      },
      E2E_TIMEOUT_MS,
    );
  });
}
