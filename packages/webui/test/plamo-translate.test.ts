// ja(plamo) 経路 (DR-0049) の unit test。翻訳サーバは globalThis.fetch の
// モックで置き換え、送った request を記録して「どの段落を何本同時に送ったか」
// 「失敗を何回送り直したか」「切れた段落をどう分けたか」を見る。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { defined, stubGlobal } from "./helpers.ts";
import {
  _resetPlamoStateForTest,
  hasCachedPlamoText,
  probePlamoHealth,
  splitParagraphInTwo,
  translateTextWithPlamo,
} from "../src/client/plamo-translate.ts";
import { _resetTranslatorStateForTest, translatedTextOf } from "../src/client/translate.ts";

const BASE = "https://translate.example.test";

/** 送られた body のうち test が読むところ。 */
const SentBodySchema = v.object({
  model: v.string(),
  messages: v.tuple([v.object({ role: v.literal("user"), content: v.string() })]),
  chat_template_kwargs: v.object({
    target_lang: v.string(),
    form: v.string(),
    glossary: v.array(v.object({ source: v.string(), target: v.string() })),
    context: v.string(),
  }),
  temperature: v.number(),
  max_tokens: v.number(),
});

interface SentRequest {
  url: string;
  init: RequestInit | undefined;
  content: string;
}

type Responder = (content: string, sent: SentRequest) => Response | Promise<Response>;

/** fetch の init.body (この経路では常に JSON 文字列) を送られた body として読む。 */
function sentBodyOf(init: RequestInit | undefined): v.InferOutput<typeof SentBodySchema> {
  const raw = typeof init?.body === "string" ? init.body : "";
  return v.parse(SentBodySchema, JSON.parse(raw));
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

let restoreFetch = (): void => {};
let sent: SentRequest[] = [];

function completion(content: string, finishReason = "stop"): Response {
  return Response.json({
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
  });
}

/** fetch を差し替える。POST は body を読んで `responder` に段落を渡し、GET
 * (health) は `health` に任せる。 */
function installFetch(opts: { responder?: Responder; health?: () => Response }): void {
  restoreFetch();
  restoreFetch = stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (init?.method !== "POST") {
        sent.push({ url, init, content: "" });
        return (opts.health ?? (() => new Response("ok")))();
      }
      const parsed = sentBodyOf(init);
      const request = { url, init, content: parsed.messages[0].content };
      sent.push(request);
      return (opts.responder ?? ((c) => completion(`[ja]${c}`)))(request.content, request);
    },
  );
}

beforeEach(() => {
  sent = [];
  _resetTranslatorStateForTest();
  _resetPlamoStateForTest({ retryDelayMs: 0 });
});

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
});

describe("probePlamoHealth", () => {
  test("200 from <base>/health means usable", async () => {
    installFetch({ health: () => new Response('{"status":"ok"}') });
    expect(await probePlamoHealth(`${BASE}/`)).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([`${BASE}/health`]);
  });

  test("a failing health is tried once more, then the route is unusable", async () => {
    installFetch({ health: () => new Response("down", { status: 503 }) });
    expect(await probePlamoHealth(BASE)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  test("an unreachable server is unusable", async () => {
    restoreFetch = stubGlobal("fetch", async () => {
      throw new TypeError("network error");
    });
    expect(await probePlamoHealth(BASE)).toBe(false);
  });

  test("a cold start that answers on the second try is usable", async () => {
    let calls = 0;
    installFetch({
      health: () => (++calls === 1 ? new Response(null, { status: 502 }) : new Response("ok")),
    });
    expect(await probePlamoHealth(BASE)).toBe(true);
  });
});

describe("translateTextWithPlamo", () => {
  // 日本語の段落も送る (PLaMo は日本語の段落を壊さないので前処理を持たない)。
  // 空の段落だけは送らない。
  test("sends one request per non-blank paragraph with the fixed parameters", async () => {
    installFetch({});
    const text = "First paragraph.\n\n既に日本語の段落です。\n\n \n\nSecond paragraph.";
    const result = await translateTextWithPlamo(text, BASE);
    expect(result).toBe(
      "[ja]First paragraph.\n\n[ja]既に日本語の段落です。\n\n \n\n[ja]Second paragraph.",
    );
    expect(sent.map((s) => s.content)).toEqual([
      "First paragraph.",
      "既に日本語の段落です。",
      "Second paragraph.",
    ]);
    const first = defined(sent[0], "the first request");
    expect(first.url).toBe(`${BASE}/v1/chat/completions`);
    expect(first.init?.redirect).toBe("manual");
    const body = sentBodyOf(first.init);
    expect(body.model).toBe("plamo-3-translate");
    expect(body.temperature).toBe(0);
    expect(body.chat_template_kwargs.target_lang).toBe("ja");
    expect(body.chat_template_kwargs.form).toBe("plain");
    expect(body.chat_template_kwargs.context).not.toBe("");
    expect(body.chat_template_kwargs.glossary).toContainEqual({ source: "jj", target: "jj" });
    expect(body.chat_template_kwargs.glossary).toContainEqual({
      source: "daemon",
      target: "daemon",
    });
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeLessThanOrEqual(4096);
  });

  test("keeps at most 4 requests in flight and shows each paragraph as it arrives", async () => {
    const release = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    installFetch({
      responder: async (content) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => release.set(content, resolve));
        inFlight--;
        return completion(`[ja]${content}`);
      },
    });
    const paragraphs = ["p1.", "p2.", "p3.", "p4.", "p5.", "p6."];
    const partials: string[] = [];
    const done = translateTextWithPlamo(paragraphs.join("\n\n"), BASE, (p) => partials.push(p));
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    await settle();
    expect(sent.map((s) => s.content)).toEqual(["p1.", "p2.", "p3.", "p4."]);

    defined(release.get("p3."), "p3 in flight")();
    await settle();
    expect(partials.at(-1)).toBe("p1.\n\np2.\n\n[ja]p3.\n\np4.\n\np5.\n\np6.");
    // p3 の slot が空いたので p5 が出た。
    expect(sent.map((s) => s.content)).toContain("p5.");
    expect(sent.map((s) => s.content)).not.toContain("p6.");

    for (const p of ["p1.", "p2.", "p4.", "p5."]) defined(release.get(p), p)();
    await settle();
    defined(release.get("p6."), "p6 in flight")();
    expect(await done).toBe(paragraphs.map((p) => `[ja]${p}`).join("\n\n"));
    expect(maxInFlight).toBe(4);
  });

  test("a failed request is sent once more and then succeeds", async () => {
    let calls = 0;
    installFetch({
      responder: (content) =>
        ++calls === 1 ? new Response(null, { status: 500 }) : completion(`[ja]${content}`),
    });
    expect(await translateTextWithPlamo("Retry me.", BASE)).toBe("[ja]Retry me.");
    expect(sent.map((s) => s.content)).toEqual(["Retry me.", "Retry me."]);
  });

  test("a network error is retried the same way", async () => {
    let calls = 0;
    restoreFetch = stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new TypeError("network error");
      const body = sentBodyOf(init);
      return completion(`[ja]${body.messages[0].content}`);
    });
    expect(await translateTextWithPlamo("Flaky network.", BASE)).toBe("[ja]Flaky network.");
    expect(calls).toBe(2);
  });

  test("two failures leave the original with a note, and are not cached", async () => {
    installFetch({ responder: () => new Response("busy", { status: 503 }) });
    const result = await translateTextWithPlamo("Never works.", BASE);
    expect(result.startsWith("Never works.\n\n")).toBe(true);
    expect(result).toContain("翻訳できなかった");
    expect(sent).toHaveLength(2);
    expect(hasCachedPlamoText("Never works.")).toBe(false);
    expect(translatedTextOf("Never works.")).toBeNull();

    installFetch({});
    expect(await translateTextWithPlamo("Never works.", BASE)).toBe("[ja]Never works.");
  });

  test("a response outside the schema counts as a failure", async () => {
    installFetch({ responder: () => Response.json({ choices: [] }) });
    expect(await translateTextWithPlamo("Odd reply.", BASE)).toContain("翻訳できなかった");
    expect(sent).toHaveLength(2);
  });

  test("a paragraph cut by the length limit is split in two at a sentence and resent", async () => {
    const whole = "First sentence here. Second sentence there.";
    installFetch({
      responder: (content) =>
        content === whole ? completion("途中で", "length") : completion(`[${content}]`),
    });
    expect(await translateTextWithPlamo(whole, BASE)).toBe(
      "[First sentence here.][Second sentence there.]",
    );
    expect(sent.map((s) => s.content)).toEqual([
      whole,
      "First sentence here.",
      "Second sentence there.",
    ]);
  });

  test("a half still cut by the limit is shown as cut, with a note", async () => {
    installFetch({
      responder: (content) =>
        content.startsWith("First") ? completion("前半が切れ", "length") : completion("後半。"),
    });
    const result = await translateTextWithPlamo("First part. Second part.", BASE);
    expect(result).toContain("前半が切れ後半。");
    expect(result).toContain("途中で切れた");
  });

  test("a cut paragraph with no sentence boundary is shown as cut", async () => {
    installFetch({ responder: () => completion("切れた訳", "length") });
    const result = await translateTextWithPlamo("one-long-token-without-boundary", BASE);
    expect(result.startsWith("切れた訳\n\n")).toBe(true);
    expect(result).toContain("途中で切れた");
    expect(sent).toHaveLength(1);
  });

  test("a translated paragraph is served from the cache the next time", async () => {
    installFetch({});
    const text = "Cache me.\n\nAnd me.";
    expect(hasCachedPlamoText(text)).toBe(false);
    await translateTextWithPlamo(text, BASE);
    expect(hasCachedPlamoText(text)).toBe(true);
    expect(await translateTextWithPlamo(`${text}\n\nNew one.`, BASE)).toBe(
      "[ja]Cache me.\n\n[ja]And me.\n\n[ja]New one.",
    );
    expect(sent.map((s) => s.content)).toEqual(["Cache me.", "And me.", "New one."]);
    // 検索のレジストリにも段落の訳が載る。
    expect(translatedTextOf("Cache me.")).toBe("[ja]Cache me.");
  });

  test("concurrent requests for the same paragraph share one request", async () => {
    installFetch({});
    const [a, b] = await Promise.all([
      translateTextWithPlamo("Shared.", BASE),
      translateTextWithPlamo("Shared.", BASE),
    ]);
    expect(a).toBe("[ja]Shared.");
    expect(b).toBe("[ja]Shared.");
    expect(sent).toHaveLength(1);
  });
});

describe("splitParagraphInTwo", () => {
  test("splits at the sentence boundary nearest the middle", () => {
    expect(splitParagraphInTwo("A b. C d. E f. G h.")).toEqual({
      head: "A b. C d.",
      separator: " ",
      tail: "E f. G h.",
    });
  });

  test("a line break inside the paragraph is a boundary too", () => {
    expect(splitParagraphInTwo("- item one\n- item two")).toEqual({
      head: "- item one",
      separator: "\n",
      tail: "- item two",
    });
  });

  test("returns null when there is nowhere to split", () => {
    expect(splitParagraphInTwo("no boundary at all")).toBeNull();
    expect(splitParagraphInTwo("Only one sentence.")).toBeNull();
  });
});
