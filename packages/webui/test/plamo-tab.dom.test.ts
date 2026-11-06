// ja(plamo) タブ (DR-0049) を thinking の描画で見る: 翻訳サーバの URL が
// あれば `original / ja(plamo) / ja(browser) / ja(host)` の順にタブが並び、
// 選ぶと段落の訳が翻訳サーバから届いて本文が差し替わる。URL が無ければ
// タブは出ない。fold を開いた thinking と、応答・許可依頼のバブルは、20 文字以上の英語の
// 段落が 1 つでもあれば ja(plamo) を既定で選び、無ければ original のまま。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ComponentChild, h, render } from "preact";
import { act } from "preact/test-utils";
import type { ErrorResponse, PermitRequestRecord } from "@ccmsg/protocol";
import { SegmentView } from "../src/client/components/timeline/segments.tsx";
import { AssistantBubble, UserPromptBubble } from "../src/client/components/timeline/bubbles.tsx";
import { PermitRequestBubble } from "../src/client/components/timeline/PermitRequestBubble.tsx";
import { AppContext } from "../src/client/context.ts";
import { FakeTranscriptWs, SID, timelineStore } from "./timeline-harness.ts";
import type { Segment } from "../src/client/transcript-model.ts";
import type { TranslationAvailability } from "../src/client/components/timeline/translation.ts";
import { _resetPlamoStateForTest } from "../src/client/plamo-translate.ts";
import { _resetTranslatorStateForTest } from "../src/client/translate.ts";
import { withDom } from "./dom.ts";
import { defined, stubGlobal } from "./helpers.ts";

withDom();

const PLAMO_URL = "https://translate.example.test";
const unavailable: ErrorResponse = { ok: false, error: { code: "unavailable", msg: "test" } };

let container: HTMLElement | null = null;
let restoreFetch = (): void => {};

beforeEach(() => {
  _resetTranslatorStateForTest();
  _resetPlamoStateForTest({ retryDelayMs: 0 });
});

afterEach(async () => {
  restoreFetch();
  restoreFetch = () => {};
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

async function mountThinking(
  text: string,
  availability: TranslationAvailability,
): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  container = root;
  await act(() =>
    render(
      h(SegmentView, {
        segment: { kind: "thinking", text },
        translationAvailability: availability,
        ts: null,
        foldGroupOpen: false,
        searchKey: "0-0",
        searchCtx: undefined,
      }),
      root,
    ),
  );
  return root;
}

function tabLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".tl-thinking-tab")].map((el) => el.textContent ?? "");
}

describe("ja(plamo) tab", () => {
  test("no plamo URL, no ja(plamo) tab", async () => {
    const root = await mountThinking("Some thinking.", {
      host: true,
      browser: false,
      hostRequest: async () => unavailable,
    });
    expect(tabLabels(root)).toEqual(["original", "ja(host)"]);
  });

  test("tabs are ordered original / ja(plamo) / ja(browser) / ja(host)", async () => {
    const root = await mountThinking("Some thinking.", {
      host: true,
      browser: true,
      hostRequest: async () => unavailable,
      plamoUrl: PLAMO_URL,
    });
    expect(tabLabels(root)).toEqual(["original", "ja(plamo)", "ja(browser)", "ja(host)"]);
  });

  test("selecting ja(plamo) shows the server's translation paragraph by paragraph", async () => {
    const posted: string[] = [];
    const { promise: bothPosted, resolve: resolveBothPosted } = Promise.withResolvers<void>();
    restoreFetch = stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const content = body.includes("First") ? "First paragraph." : "Second paragraph.";
      posted.push(content);
      if (posted.length === 2) resolveBothPosted();
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: `訳:${content}` } }],
      });
    });
    const root = await mountThinking("First paragraph.\n\nSecond paragraph.", {
      host: false,
      browser: false,
      hostRequest: async () => unavailable,
      plamoUrl: PLAMO_URL,
    });
    const plamoTab = defined(
      [...root.querySelectorAll<HTMLButtonElement>(".tl-thinking-tab")].find(
        (el) => el.textContent === "ja(plamo)",
      ),
      "the ja(plamo) tab",
    );
    await act(() => plamoTab.click());
    await bothPosted;
    // 応答の body を読んで state に入るまでの continuation を流す。
    for (let i = 0; i < 3; i++) {
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    expect(posted.sort()).toEqual(["First paragraph.", "Second paragraph."]);
    const body = defined(root.querySelector(".tl-thinking-body"), "the thinking body");
    expect(body.textContent).toContain("訳:First paragraph.");
    expect(body.textContent).toContain("訳:Second paragraph.");
  });
});

describe("default tab", () => {
  const ENGLISH = "I will read the file first, then run the whole test suite again.";
  const JAPANESE = ["まずファイルを読む。", "次にテストを走らせる。", "最後に結果を報告する。"];

  let restoreObserver = (): void => {};
  beforeEach(() => {
    // 可視範囲の判定を待たずに既定の選択を走らせる。
    restoreObserver = stubGlobal("IntersectionObserver", undefined);
    restoreFetch = stubGlobal("fetch", async () =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content: "訳" } }] }),
    );
  });
  afterEach(() => {
    restoreObserver();
    restoreObserver = () => {};
  });

  const withPlamo: TranslationAvailability = {
    host: true,
    browser: true,
    hostRequest: async () => unavailable,
    plamoUrl: PLAMO_URL,
  };

  async function mountSegment(
    segment: Segment,
    availability: TranslationAvailability,
  ): Promise<HTMLElement> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    container = root;
    await act(() =>
      render(
        h(SegmentView, {
          segment,
          translationAvailability: availability,
          ts: null,
          foldGroupOpen: true,
          searchKey: "0-0",
          searchCtx: undefined,
        }),
        root,
      ),
    );
    return root;
  }

  function selectedTab(root: HTMLElement): string | null {
    return root.querySelector('.tl-thinking-tab[aria-selected="true"]')?.textContent ?? null;
  }

  async function thinkingTab(text: string, availability = withPlamo): Promise<string | null> {
    return selectedTab(await mountSegment({ kind: "thinking", text }, availability));
  }

  test("one English paragraph among Japanese ones opens on ja(plamo)", async () => {
    expect(await thinkingTab([...JAPANESE, ENGLISH, ...JAPANESE].join("\n\n"))).toBe("ja(plamo)");
  });

  test("short English lines alone stay on original", async () => {
    expect(await thinkingTab("OK\n\nDone.\n\nLGTM, thanks")).toBe("original");
  });

  test("a Japanese-only thinking stays on original", async () => {
    expect(await thinkingTab(JAPANESE.join("\n\n"))).toBe("original");
  });

  test("without ja(plamo), host and browser are not chosen by default", async () => {
    expect(
      await thinkingTab(ENGLISH, {
        host: true,
        browser: true,
        hostRequest: async () => unavailable,
      }),
    ).toBe("original");
  });

  // 応答のバブルも同じ判定。ツールバーの言語タブは 1 つ目の tablist。
  async function bubbleTab(text: string): Promise<string | null> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    container = root;
    await act(() =>
      render(
        h(AssistantBubble, {
          line: {
            kind: "turn",
            ts: null,
            role: "assistant",
            segments: [{ kind: "text", role: "assistant", text }],
          },
          offset: 0,
          translationAvailability: withPlamo,
          now: 0,
          searchCtx: undefined,
          actions: undefined,
        }),
        root,
      ),
    );
    const languageTabs = root.querySelector('[aria-label="本文の言語"]');
    return languageTabs?.querySelector('[aria-selected="true"]')?.textContent ?? null;
  }

  test("an assistant bubble with an English paragraph opens on ja(plamo)", async () => {
    expect(await bubbleTab(ENGLISH)).toBe("ja(plamo)");
  });

  test("a Japanese assistant bubble stays on original", async () => {
    expect(await bubbleTab(JAPANESE.join("\n\n"))).toBe("original");
  });

  // user のバブル (別セッションからのメッセージを含む) も同じ判定。
  async function userBubble(text: string): Promise<{ tab: string | null; body: string }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    container = root;
    await act(() =>
      render(
        h(UserPromptBubble, {
          line: {
            kind: "turn",
            ts: null,
            role: "user",
            segments: [{ kind: "text", role: "user", text }],
          },
          offsetKey: 0,
          navKey: "k",
          registerUserTurnRef: () => {},
          translationAvailability: withPlamo,
          now: 0,
          searchCtx: undefined,
          onUserTurnClick: () => {},
          selected: false,
        }),
        root,
      ),
    );
    for (let i = 0; i < 3; i++) {
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    return {
      tab: languageTab(root),
      body: root.querySelector(".tl-bubble-body")?.textContent ?? "",
    };
  }

  test("a user bubble with English opens on ja(plamo) and shows the translation", async () => {
    const { tab, body } = await userBubble(ENGLISH);
    expect(tab).toBe("ja(plamo)");
    expect(body).not.toContain(ENGLISH);
    expect(body).toContain("訳");
  });

  test("a Japanese user bubble stays on original", async () => {
    const { tab, body } = await userBubble(JAPANESE.join("\n\n"));
    expect(tab).toBe("original");
    expect(body).toContain("まずファイルを読む。");
  });

  // 許可依頼のバブルも同じ判定。訳は fetch のモックが返す「訳」。
  async function settleTranslation(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
  }

  async function mountInApp(vnode: ComponentChild): Promise<HTMLElement> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    container = root;
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    await act(() =>
      render(h(AppContext.Provider, { value: { store, ws: ws.handle } }, vnode), root),
    );
    await settleTranslation();
    return root;
  }

  function languageTab(root: HTMLElement): string | null {
    const languageTabs = root.querySelector('[aria-label="本文の言語"]');
    return languageTabs?.querySelector('[aria-selected="true"]')?.textContent ?? null;
  }

  function permitOf(blocked: string, intent: string, description: string): PermitRequestRecord {
    return {
      id: "i/1",
      sid: SID,
      ts: "2026-11-06T00:00:00.000Z",
      blocked,
      attachments: ["/w/policy.json"],
      intents: [intent],
      commands: [{ command: "git push origin main", description }],
      read: false,
    };
  }

  test("an English permit request opens on ja(plamo) and shows the translation", async () => {
    const root = await mountInApp(
      h(PermitRequestBubble, {
        request: permitOf(ENGLISH, "Editing the configuration file of the daemon.", "push it"),
        now: 0,
        translationAvailability: withPlamo,
      }),
    );
    expect(languageTab(root)).toBe("ja(plamo)");
    const body = defined(root.querySelector(".tl-bubble-body"), "the permit body");
    expect(body.textContent).not.toContain(ENGLISH);
    expect(body.textContent).toContain("訳");
    // コマンド本文と添付のパスは訳さない。
    expect(body.textContent).toContain("git push origin main");
    expect(body.textContent).toContain("/w/policy.json");
  });

  test("a Japanese permit request stays on original", async () => {
    const root = await mountInApp(
      h(PermitRequestBubble, {
        request: permitOf(JAPANESE[0] ?? "", JAPANESE[1] ?? "", JAPANESE[2] ?? ""),
        now: 0,
        translationAvailability: withPlamo,
      }),
    );
    expect(languageTab(root)).toBe("original");
  });
});
