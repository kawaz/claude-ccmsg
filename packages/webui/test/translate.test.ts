// translate.ts unit tests (U2 kawaz spec: thinking 翻訳タブ). Chrome built-in
// Translator API (https://developer.chrome.com/docs/ai/translator-api) is a
// browser-only global with no counterpart in bun's test runtime, so every
// test here drives a hand-rolled mock installed on globalThis.Translator —
// mirroring ws.test.ts's approach to mocking browser-only globals
// (WebSocket/location/localStorage) for the duration of this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetTranslatorStateForTest,
  hasTranslatorApi,
  translateThinkingText,
} from "../src/client/translate.ts";

const originalGlobals: Record<string, unknown> = {};

beforeEach(() => {
  originalGlobals.Translator = (globalThis as any).Translator;
  _resetTranslatorStateForTest();
});

afterEach(() => {
  if (originalGlobals.Translator === undefined) {
    delete (globalThis as any).Translator;
  } else {
    (globalThis as any).Translator = originalGlobals.Translator;
  }
});

/** Installs a mock Translator whose `translate()` records every call and
 * returns `prefix + text` by default — good enough to distinguish "was this
 * paragraph actually sent to the API" from "was it skipped/fallback". */
function installMockTranslator(opts?: {
  translate?: (text: string) => Promise<string>;
  createShouldFail?: boolean;
}): { calls: string[] } {
  const calls: string[] = [];
  const translate =
    opts?.translate ??
    (async (text: string) => {
      calls.push(text);
      return `[ja]${text}`;
    });
  (globalThis as any).Translator = {
    create: async (createOpts: { sourceLanguage: string; targetLanguage: string }) => {
      if (opts?.createShouldFail) throw new Error("model unavailable");
      expect(createOpts).toEqual({ sourceLanguage: "en", targetLanguage: "ja" });
      return {
        translate: async (text: string) => {
          if (opts?.translate) {
            calls.push(text);
            return opts.translate(text);
          }
          return translate(text);
        },
      };
    },
  };
  return { calls };
}

describe("hasTranslatorApi", () => {
  test("no globalThis.Translator -> false", () => {
    delete (globalThis as any).Translator;
    expect(hasTranslatorApi()).toBe(false);
  });

  test("globalThis.Translator present (object form, as installed by the mock) -> true", () => {
    installMockTranslator();
    expect(hasTranslatorApi()).toBe(true);
  });
});

describe("translateThinkingText", () => {
  test("a single English paragraph is sent to the Translator API and replaced with the result", async () => {
    installMockTranslator();
    const result = await translateThinkingText("Let me check the file.");
    expect(result).toBe("[ja]Let me check the file.");
  });

  // kawaz spec: 段落 (\n\n) 分割 — 各段落は独立して翻訳され、\n\n で再結合
  // される。段落の境界そのもの (markdown の箇条書き/見出し等の構造) を崩さ
  // ない。
  test("splits on \\n\\n, translates each paragraph independently, rejoins with \\n\\n", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText("First paragraph.\n\nSecond paragraph.");
    expect(result).toBe("[ja]First paragraph.\n\n[ja]Second paragraph.");
    expect(calls.sort()).toEqual(["First paragraph.", "Second paragraph."]);
  });

  // kawaz spec: ひらがな/カタカナ/漢字を含む段落は翻訳をスキップし原文のまま
  // 通す — 既に日本語の thinking (通常は起きないが、混在ケース) を壊れた
  // 翻訳にしない。
  test("a paragraph containing hiragana is skipped (kept as-is), not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText("これはひらがなを含む段落です。");
    expect(result).toBe("これはひらがなを含む段落です。");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing katakana only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText("コレハカタカナ");
    expect(result).toBe("コレハカタカナ");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing kanji (Han script) only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText("漢字");
    expect(result).toBe("漢字");
    expect(calls).toEqual([]);
  });

  // Mixed input: English paragraphs still get translated, Japanese ones
  // don't — each paragraph is judged independently.
  test("mixed English/Japanese paragraphs: only the English ones go through translation", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText(
      "English text.\n\n日本語のテキスト。\n\nMore English.",
    );
    expect(result).toBe("[ja]English text.\n\n日本語のテキスト。\n\n[ja]More English.");
    expect(calls.sort()).toEqual(["English text.", "More English."]);
  });

  // kawaz spec: 失敗段落は原文 fallback — 一部の翻訳呼び出しが失敗しても
  // 他の段落・全体の結果を壊さない。
  test("a paragraph whose translate() call throws falls back to the original text", async () => {
    installMockTranslator({
      translate: async (text) => {
        if (text === "boom") throw new Error("translation failed");
        return `[ja]${text}`;
      },
    });
    const result = await translateThinkingText("ok text.\n\nboom");
    expect(result).toBe("[ja]ok text.\n\nboom");
  });

  // create() itself failing (e.g. model download not ready) must also fall
  // back to the original text for every paragraph, not throw out of
  // translateThinkingText.
  test("Translator.create() failing falls back to the original text for all paragraphs", async () => {
    installMockTranslator({ createShouldFail: true });
    const result = await translateThinkingText("First.\n\nSecond.");
    expect(result).toBe("First.\n\nSecond.");
  });

  // Regression (adversarial review, translate.ts minor finding): a create()
  // failure is a truthy (rejected) Promise, so without resetting the cached
  // translatorPromise back to null on failure, every later call would keep
  // hitting the same cached rejection forever — a transient failure (e.g. a
  // language-pack download still in progress) would permanently disable
  // translation until a page reload. The next getTranslator() call (from a
  // later, different paragraph — same module-level cache, different
  // paragraphCache key so this doesn't hit the per-paragraph cache instead)
  // must retry create().
  test("a transient Translator.create() failure is retried on the next call, not cached forever", async () => {
    let createCalls = 0;
    (globalThis as any).Translator = {
      create: async (createOpts: { sourceLanguage: string; targetLanguage: string }) => {
        createCalls++;
        expect(createOpts).toEqual({ sourceLanguage: "en", targetLanguage: "ja" });
        if (createCalls === 1) throw new Error("language pack not ready yet");
        return { translate: async (text: string) => `[ja]${text}` };
      },
    };

    const first = await translateThinkingText("First.");
    expect(first).toBe("First."); // create() failed -> fallback to original
    expect(createCalls).toBe(1);

    const second = await translateThinkingText("Second.");
    expect(second).toBe("[ja]Second."); // retried create() succeeded this time
    expect(createCalls).toBe(2);
  });

  // kawaz spec: 結果は segment (段落) 単位でメモリキャッシュ — 同じ段落を
  // 2 回訳しても API へは 1 回しか呼ばれない。
  test("caches per-paragraph results: the same paragraph is translated only once across calls", async () => {
    const { calls } = installMockTranslator();
    const first = await translateThinkingText("Repeated paragraph.");
    const second = await translateThinkingText("Repeated paragraph.");
    expect(first).toBe(second);
    expect(calls).toEqual(["Repeated paragraph."]);
  });

  // An empty paragraph (e.g. a leading/trailing \n\n producing "") must not
  // be sent to the API — nothing meaningful to translate.
  test("an empty paragraph is left empty, not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingText("Text.\n\n\n\nMore.");
    expect(result).toBe("[ja]Text.\n\n\n\n[ja]More.");
    expect(calls.sort()).toEqual(["More.", "Text."]);
  });

  // No Translator API present at all: every paragraph falls back untouched
  // (the caller — Timeline.tsx — is expected to gate this via
  // hasTranslatorApi() and not even offer the "ja" tab, but the function
  // itself must still degrade gracefully rather than throw).
  test("no Translator API present -> translateThinkingText falls back to the original text", async () => {
    delete (globalThis as any).Translator;
    const result = await translateThinkingText("Some English text.");
    expect(result).toBe("Some English text.");
  });
});
