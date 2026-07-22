// translate.ts unit tests (U2 kawaz spec: thinking 翻訳タブ). Chrome built-in
// Translator API (https://developer.chrome.com/docs/ai/translator-api) is a
// browser-only global with no counterpart in bun's test runtime, so every
// test here drives a hand-rolled mock installed on globalThis.Translator —
// mirroring ws.test.ts's approach to mocking browser-only globals
// (WebSocket/location/localStorage) for the duration of this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetTranslatorStateForTest,
  _setHostBatchWindowMsForTest,
  hasCachedHostThinkingText,
  hasTranslatorApi,
  translateThinkingTextInBrowser,
  translateThinkingTextOnHost,
} from "../src/client/translate.ts";

const originalGlobals: Record<string, unknown> = {};

beforeEach(() => {
  originalGlobals.Translator = (globalThis as any).Translator;
  _resetTranslatorStateForTest();
  // host 経路の microbatch 窓を 0 に落として、setTimeout(_, 0) 相当で次 macrotask に
  // flush する。テストが 20ms スリープを挟まなくても batching 挙動を検証できる。
  _setHostBatchWindowMsForTest(0);
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

/** helper: 入力 texts を `[ja]<text>` に翻訳する成功レスポンスを返す標準 request。
 * 個別の失敗が要らないテストで request() 引数の記述を短くする。 */
function makeEchoBatchRequest(recorder?: {
  batches: string[][];
}): (texts: string[]) => Promise<{ ok: true; results: { ok: true; text: string }[] }> {
  return async (texts: string[]) => {
    recorder?.batches.push(texts.slice());
    return {
      ok: true as const,
      results: texts.map((t) => ({ ok: true as const, text: `[ja]${t}` })),
    };
  };
}

describe("translateThinkingTextOnHost", () => {
  test("reports a whole thinking as cached only after every English paragraph is cached", async () => {
    const request = makeEchoBatchRequest();
    const text = "First.\n\n日本語。\n\nSecond.";

    expect(hasCachedHostThinkingText(text)).toBe(false);
    await translateThinkingTextOnHost("First.\n\n日本語。", request);
    expect(hasCachedHostThinkingText(text)).toBe(false);
    await translateThinkingTextOnHost("Second.", request);
    expect(hasCachedHostThinkingText(text)).toBe(true);
  });

  // host 経路も browser 経路と同じ `\n\n` 段落契約を持つ。日本語を含む段落と
  // split が作る空段落は原文のまま保持し、英語段落だけを microbatch 集約層で
  // 1 op にまとめて daemon に送り、元の段落順・境界で再結合する。
  test("bundles English paragraphs from a single call into one batched request", async () => {
    const recorder = { batches: [] as string[][] };
    const input = "First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\nFinal paragraph.";
    const result = await translateThinkingTextOnHost(input, makeEchoBatchRequest(recorder));

    // 集約層は 1 batch に束ねる (旧: 段落ごとに 1 op)。順序は入力順を保つ。
    expect(recorder.batches).toEqual([["First paragraph.", "Final paragraph."]]);
    expect(result).toBe(
      "[ja]First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\n[ja]Final paragraph.",
    );
  });

  // 集約層が 1 op = N 段落で応答を受けたら、結果は入力順の段落位置に復元される
  // (TranslateResponse.results の順序契約を利用)。resolver を後から発火しても
  // join は入力順で組み立てる。
  test("rejoins batched results at the original paragraph positions regardless of resolver order", async () => {
    let externalResolve!: (response: { ok: true; results: { ok: true; text: string }[] }) => void;
    const batches: string[][] = [];
    const translated = translateThinkingTextOnHost("First.\n\nSecond.", (texts) => {
      batches.push(texts.slice());
      return new Promise((resolve) => {
        externalResolve = resolve;
      });
    });
    // await 1 tick so that microbatch flush timer fires and request() is invoked.
    await new Promise((r) => setTimeout(r, 5));

    expect(batches).toEqual([["First.", "Second."]]);
    externalResolve({
      ok: true,
      results: [
        { ok: true, text: "一番目" },
        { ok: true, text: "二番目" },
      ],
    });
    expect(await translated).toBe("一番目\n\n二番目");
  });

  // 同時期 (batch 窓内) の複数 translateThinkingTextOnHost 呼び出しは、集約層が
  // 段落を 1 op にまとめる。Timeline が複数 thinking を同時マウントするケースの
  // helper 直列化コスト圧縮を担保する。
  test("bundles paragraphs from concurrent translateThinkingTextOnHost calls into one batched request", async () => {
    const recorder = { batches: [] as string[][] };
    const request = makeEchoBatchRequest(recorder);
    const [a, b] = await Promise.all([
      translateThinkingTextOnHost("Alpha1.\n\nAlpha2.", request),
      translateThinkingTextOnHost("Beta1.", request),
    ]);
    expect(a).toBe("[ja]Alpha1.\n\n[ja]Alpha2.");
    expect(b).toBe("[ja]Beta1.");
    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]!.sort()).toEqual(["Alpha1.", "Alpha2.", "Beta1."]);
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
    // 集約層は 1 batch を送る: request が受ける texts は ["Translate me.", "Fallback me."]。
    // results 配列を入力順で組み立て、2 番目だけ item error にする。
    const result = await translateThinkingTextOnHost(
      "Translate me.\n\nFallback me.",
      async (texts) => ({
        ok: true,
        results: texts.map((t) =>
          t === "Fallback me."
            ? ({ ok: false, error: "TranslationError.notInstalled" } as const)
            : ({ ok: true, text: "翻訳成功" } as const),
        ),
      }),
    );

    expect(result).toBe("翻訳成功\n\nFallback me.");
  });

  // batch 全体の request rejection は集約対象の全段落が原文 fallback になる
  // (下位 op 単位での判定不能のため)。個別 item の失敗と違い、段落キャッシュに
  // 成功訳は残らないので再試行が効く。
  test("falls back all paragraphs in the batch when the whole request rejects", async () => {
    const result = await translateThinkingTextOnHost("Works.\n\nRejects.", async () => {
      throw new Error("helper exited");
    });

    expect(result).toBe("Works.\n\nRejects.");
  });

  // batch 全体の ErrorResponse (ok:false) も request rejection と同じく batch 全段落を
  // fallback する (下位 op の item 単位判定が付いてこないため)。
  test("falls back all paragraphs in the batch when the response is an ErrorResponse", async () => {
    const result = await translateThinkingTextOnHost("First.\n\nSecond.", async () => ({
      ok: false as const,
      error: { code: "translate_helper_failed", msg: "helper exited" },
    }));

    expect(result).toBe("First.\n\nSecond.");
  });

  // 成功結果は全文でなく段落をキーに共有する。同じ段落が別 thinking text に再登場
  // しても daemon へ再送せず、新しい段落だけを翻訳する。キャッシュ済み段落は
  // batch に含まれない (受け入れ条件 4)。
  test("caches successful translations per paragraph across different texts and excludes cached ones from later batches", async () => {
    const recorder = { batches: [] as string[][] };
    const request = makeEchoBatchRequest(recorder);

    expect(await translateThinkingTextOnHost("Repeated.\n\nFirst only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]First only.",
    );
    expect(await translateThinkingTextOnHost("Repeated.\n\nSecond only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]Second only.",
    );
    // 1 回目の batch: ["Repeated.", "First only."]、2 回目: ["Second only."] (Repeated
    // はキャッシュ済みなので含まれない)。
    expect(recorder.batches).toEqual([["Repeated.", "First only."], ["Second only."]]);
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
