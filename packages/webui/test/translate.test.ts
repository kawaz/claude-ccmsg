// translate.ts unit tests (U2 kawaz spec: thinking 翻訳タブ). Chrome built-in
// Translator API (https://developer.chrome.com/docs/ai/translator-api) is a
// browser-only global with no counterpart in bun's test runtime, so every
// test here drives a hand-rolled mock installed on globalThis.Translator —
// mirroring ws.test.ts's approach to mocking browser-only globals
// (WebSocket/location/localStorage) for the duration of this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetTranslatorStateForTest,
  hasCachedHostThinkingText,
  hasTranslatorApi,
  translateThinkingTextInBrowser,
  translateThinkingTextOnHost,
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

describe("translateThinkingTextInBrowser", () => {
  test("a single English paragraph is sent to the Translator API and replaced with the result", async () => {
    installMockTranslator();
    const result = await translateThinkingTextInBrowser("Let me check the file.");
    expect(result).toBe("[ja]Let me check the file.");
  });

  // kawaz spec: 段落 (\n\n) 分割 — 各段落は独立して翻訳され、\n\n で再結合
  // される。段落の境界そのもの (markdown の箇条書き/見出し等の構造) を崩さ
  // ない。
  test("splits on \\n\\n, translates each paragraph independently, rejoins with \\n\\n", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser("First paragraph.\n\nSecond paragraph.");
    expect(result).toBe("[ja]First paragraph.\n\n[ja]Second paragraph.");
    expect(calls.sort()).toEqual(["First paragraph.", "Second paragraph."]);
  });

  // kawaz spec: ひらがな/カタカナ/漢字を含む段落は翻訳をスキップし原文のまま
  // 通す — 既に日本語の thinking (通常は起きないが、混在ケース) を壊れた
  // 翻訳にしない。
  test("a paragraph containing hiragana is skipped (kept as-is), not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser("これはひらがなを含む段落です。");
    expect(result).toBe("これはひらがなを含む段落です。");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing katakana only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser("コレハカタカナ");
    expect(result).toBe("コレハカタカナ");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing kanji (Han script) only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser("漢字");
    expect(result).toBe("漢字");
    expect(calls).toEqual([]);
  });

  // Mixed input: English paragraphs still get translated, Japanese ones
  // don't — each paragraph is judged independently.
  test("mixed English/Japanese paragraphs: only the English ones go through translation", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser(
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
    const result = await translateThinkingTextInBrowser("ok text.\n\nboom");
    expect(result).toBe("[ja]ok text.\n\nboom");
  });

  // create() itself failing (e.g. model download not ready) must also fall
  // back to the original text for every paragraph, not throw out of
  // translateThinkingTextInBrowser.
  test("Translator.create() failing falls back to the original text for all paragraphs", async () => {
    installMockTranslator({ createShouldFail: true });
    const result = await translateThinkingTextInBrowser("First.\n\nSecond.");
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

    const first = await translateThinkingTextInBrowser("First.");
    expect(first).toBe("First."); // create() failed -> fallback to original
    expect(createCalls).toBe(1);

    const second = await translateThinkingTextInBrowser("Second.");
    expect(second).toBe("[ja]Second."); // retried create() succeeded this time
    expect(createCalls).toBe(2);
  });

  // kawaz spec: 結果は segment (段落) 単位でメモリキャッシュ — 同じ段落を
  // 2 回訳しても API へは 1 回しか呼ばれない。
  test("caches per-paragraph results: the same paragraph is translated only once across calls", async () => {
    const { calls } = installMockTranslator();
    const first = await translateThinkingTextInBrowser("Repeated paragraph.");
    const second = await translateThinkingTextInBrowser("Repeated paragraph.");
    expect(first).toBe(second);
    expect(calls).toEqual(["Repeated paragraph."]);
  });

  // An empty paragraph (e.g. a leading/trailing \n\n producing "") must not
  // be sent to the API — nothing meaningful to translate.
  test("an empty paragraph is left empty, not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateThinkingTextInBrowser("Text.\n\n\n\nMore.");
    expect(result).toBe("[ja]Text.\n\n\n\n[ja]More.");
    expect(calls.sort()).toEqual(["More.", "Text."]);
  });

  // No Translator API present at all: every paragraph falls back untouched
  // (the caller — Timeline.tsx — is expected to gate this via
  // hasTranslatorApi() and not even offer the "ja" tab, but the function
  // itself must still degrade gracefully rather than throw).
  test("no Translator API present -> translateThinkingTextInBrowser falls back to the original text", async () => {
    delete (globalThis as any).Translator;
    const result = await translateThinkingTextInBrowser("Some English text.");
    expect(result).toBe("Some English text.");
  });
});

describe("translateThinkingTextOnHost", () => {
  test("reports a whole thinking as cached only after every English paragraph is cached", async () => {
    const request = async (texts: string[]) => ({
      ok: true as const,
      results: [{ ok: true as const, text: `[ja]${texts[0]}` }],
    });
    const text = "First.\n\n日本語。\n\nSecond.";

    expect(hasCachedHostThinkingText(text)).toBe(false);
    await translateThinkingTextOnHost("First.\n\n日本語。", request);
    expect(hasCachedHostThinkingText(text)).toBe(false);
    await translateThinkingTextOnHost("Second.", request);
    expect(hasCachedHostThinkingText(text)).toBe(true);
  });

  // host 経路も browser 経路と同じ `\n\n` 段落契約を持つ。日本語を含む段落と
  // split が作る空段落は原文のまま保持し、英語段落だけを 1 op = 1 段落で
  // daemon に送り、元の段落順・境界で再結合する。
  test("translates only English paragraphs with one daemon request per paragraph", async () => {
    const batches: string[][] = [];
    const input = "First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\nFinal paragraph.";
    const result = await translateThinkingTextOnHost(input, async (texts) => {
      batches.push(texts);
      return { ok: true, results: [{ ok: true, text: `[ja]${texts[0]}` }] };
    });

    expect(batches.sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      ["Final paragraph."],
      ["First paragraph."],
    ]);
    expect(result).toBe(
      "[ja]First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\n[ja]Final paragraph.",
    );
  });

  // Promise.all で段落リクエストを開始するため、先頭段落の応答を待ってから次を
  // 送る逐次処理にはしない。応答順が逆でも join は入力の段落順を保つ。
  test("starts paragraph requests in parallel and rejoins them in input order", async () => {
    const resolvers = new Map<string, (text: string) => void>();
    const batches: string[][] = [];
    const translated = translateThinkingTextOnHost("First.\n\nSecond.", (texts) => {
      const paragraph = texts[0]!;
      batches.push(texts);
      return new Promise((resolve) => {
        resolvers.set(paragraph, (text) => resolve({ ok: true, results: [{ ok: true, text }] }));
      });
    });

    expect(batches).toEqual([["First."], ["Second."]]);
    resolvers.get("Second.")!("二番目");
    resolvers.get("First.")!("一番目");
    expect(await translated).toBe("一番目\n\n二番目");
  });

  // 全段落が日本語判定または空段落なら daemon/helper の仕事は無い。全文用の
  // 特別判定ではなく、段落ごとの同じ規則を全要素へ適用した結果として 0 op にする。
  test("returns all-Japanese text as-is without calling request()", async () => {
    let calls = 0;
    const input = "これは日本語です。\n\nカタカナ\n\n漢字";
    const result = await translateThinkingTextOnHost(input, async () => {
      calls++;
      return { ok: true, results: [{ ok: true, text: "呼ばれてはいけない" }] };
    });

    expect(result).toBe(input);
    expect(calls).toBe(0);
  });

  // 1 段落の helper item error はその段落だけ原文 fallback とし、成功した別段落の
  // 訳は保持する。一部失敗で thinking 全体や host 経路を失敗扱いにしない。
  test("falls back only the paragraph whose helper item failed", async () => {
    const result = await translateThinkingTextOnHost(
      "Translate me.\n\nFallback me.",
      async (texts) =>
        texts[0] === "Fallback me."
          ? { ok: true, results: [{ ok: false, error: "TranslationError.notInstalled" }] }
          : { ok: true, results: [{ ok: true, text: "翻訳成功" }] },
    );

    expect(result).toBe("翻訳成功\n\nFallback me.");
  });

  // transport/daemon 全体エラーも段落単位の失敗として原文 fallback する。別段落の
  // 成功結果まで捨てず、browser 経路と同じ「失敗段落だけ原文」契約を守る。
  test("falls back only the paragraph whose request rejected", async () => {
    const result = await translateThinkingTextOnHost("Works.\n\nRejects.", async (texts) => {
      if (texts[0] === "Rejects.") throw new Error("helper exited");
      return { ok: true, results: [{ ok: true, text: "成功" }] };
    });

    expect(result).toBe("成功\n\nRejects.");
  });

  // 成功結果は全文でなく段落をキーに共有する。同じ段落が別 thinking text に再登場
  // しても daemon へ再送せず、新しい段落だけを翻訳する。
  test("caches successful translations per paragraph across different texts", async () => {
    const calls: string[] = [];
    const request = async (texts: string[]) => {
      const paragraph = texts[0]!;
      calls.push(paragraph);
      return { ok: true as const, results: [{ ok: true as const, text: `[ja]${paragraph}` }] };
    };

    expect(await translateThinkingTextOnHost("Repeated.\n\nFirst only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]First only.",
    );
    expect(await translateThinkingTextOnHost("Repeated.\n\nSecond only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]Second only.",
    );
    expect(calls.sort()).toEqual(["First only.", "Repeated.", "Second only."]);
  });

  // fallback は成功訳ではないためキャッシュしない。一時的な helper 障害の後は同じ
  // 段落を再送でき、成功後だけ段落キャッシュに固定する。
  test("retries a failed paragraph and caches it only after success", async () => {
    let calls = 0;
    const request = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false as const,
          error: { code: "translate_helper_failed", msg: "helper exited" },
        };
      }
      return { ok: true as const, results: [{ ok: true as const, text: "成功" }] };
    };

    expect(await translateThinkingTextOnHost("same", request)).toBe("same");
    expect(await translateThinkingTextOnHost("same", request)).toBe("成功");
    expect(await translateThinkingTextOnHost("same", request)).toBe("成功");
    expect(calls).toBe(2);
  });
});
