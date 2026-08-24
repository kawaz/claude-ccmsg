// translate.ts unit tests (U2 kawaz spec: thinking 翻訳タブ). Chrome built-in
// Translator API (https://developer.chrome.com/docs/ai/translator-api) is a
// browser-only global with no counterpart in bun's test runtime, so every
// test here drives a hand-rolled mock installed on globalThis.Translator —
// mirroring ws.test.ts's approach to mocking browser-only globals
// (WebSocket/location/localStorage) for the duration of this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetTranslatorStateForTest,
  hasCachedHostText,
  hasTranslatorApi,
  getTranslationRevision,
  subscribeTranslationRegistry,
  translatedTextOf,
  translateTextInBrowser,
  translateTextOnHost,
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

describe("translateTextInBrowser", () => {
  test("a single English paragraph is sent to the Translator API and replaced with the result", async () => {
    installMockTranslator();
    const result = await translateTextInBrowser("Let me check the file.");
    expect(result).toBe("[ja]Let me check the file.");
  });

  // kawaz spec: 段落 (\n\n) 分割 — 各段落は独立して翻訳され、\n\n で再結合
  // される。段落の境界そのもの (markdown の箇条書き/見出し等の構造) を崩さ
  // ない。
  test("splits on \\n\\n, translates each paragraph independently, rejoins with \\n\\n", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser("First paragraph.\n\nSecond paragraph.");
    expect(result).toBe("[ja]First paragraph.\n\n[ja]Second paragraph.");
    expect(calls.sort()).toEqual(["First paragraph.", "Second paragraph."]);
  });

  // host 経路と同じく browser 経路も段落の訳が届くたびに途中経過を渡す
  // (表示側は 1 テキストの全段落が揃うのを待たずに部分的に訳文へ差し替える)。
  test("streams a partial body each time a paragraph resolves", async () => {
    const resolvers = new Map<string, (text: string) => void>();
    installMockTranslator({
      translate: (text: string) =>
        new Promise<string>((resolve) => {
          resolvers.set(text, resolve);
        }),
    });
    const partials: string[] = [];
    const translated = translateTextInBrowser("First.\n\nSecond.", (partial) =>
      partials.push(partial),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(partials).toEqual([]);

    resolvers.get("Second.")!("二番目");
    await new Promise((r) => setTimeout(r, 5));
    expect(partials).toEqual(["First.\n\n二番目"]);

    resolvers.get("First.")!("一番目");
    expect(await translated).toBe("一番目\n\n二番目");
    expect(partials).toEqual(["First.\n\n二番目", "一番目\n\n二番目"]);
  });

  // kawaz spec: ひらがな/カタカナ/漢字を含む段落は翻訳をスキップし原文のまま
  // 通す — 既に日本語の thinking (通常は起きないが、混在ケース) を壊れた
  // 翻訳にしない。
  test("a paragraph containing hiragana is skipped (kept as-is), not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser("これはひらがなを含む段落です。");
    expect(result).toBe("これはひらがなを含む段落です。");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing katakana only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser("コレハカタカナ");
    expect(result).toBe("コレハカタカナ");
    expect(calls).toEqual([]);
  });

  test("a paragraph containing kanji (Han script) only is skipped", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser("漢字");
    expect(result).toBe("漢字");
    expect(calls).toEqual([]);
  });

  // Mixed input: English paragraphs still get translated, Japanese ones
  // don't — each paragraph is judged independently.
  test("mixed English/Japanese paragraphs: only the English ones go through translation", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser(
      "English text.\n\n日本語のテキスト。\n\nMore English.",
    );
    expect(result).toBe("[ja]English text.\n\n日本語のテキスト。\n\n[ja]More English.");
    expect(calls.sort()).toEqual(["English text.", "More English."]);
  });

  // kawaz r135m21: 日本語の短い引用が混ざっただけの英文段落は「既に日本語」
  // ではない。日本語文字と英数文字の比率で判定し、僅かな日本語は翻訳に回す。
  test("a mostly-English paragraph quoting a little Japanese is still translated", async () => {
    const { calls } = installMockTranslator();
    const para =
      'Since kawaz explicitly asked to close the PR, but they are asking my opinion on recreating it ("作り直したほうが良い?"), I should answer with my assessment first rather than immediately acting.';
    const result = await translateTextInBrowser(para);
    expect(result).toBe(`[ja]${para}`);
    expect(calls).toEqual([para]);
  });

  test("a Japanese paragraph dense with Latin identifiers is still skipped", async () => {
    const { calls } = installMockTranslator();
    const para =
      "registerSession の transcript_path は adoptTranscriptPath で採用し、resolveVirtualTranscript にフォールバックする。";
    const result = await translateTextInBrowser(para);
    expect(result).toBe(para);
    expect(calls).toEqual([]);
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
    const result = await translateTextInBrowser("ok text.\n\nboom");
    expect(result).toBe("[ja]ok text.\n\nboom");
  });

  // create() itself failing (e.g. model download not ready) must also fall
  // back to the original text for every paragraph, not throw out of
  // translateTextInBrowser.
  test("Translator.create() failing falls back to the original text for all paragraphs", async () => {
    installMockTranslator({ createShouldFail: true });
    const result = await translateTextInBrowser("First.\n\nSecond.");
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

    const first = await translateTextInBrowser("First.");
    expect(first).toBe("First."); // create() failed -> fallback to original
    expect(createCalls).toBe(1);

    const second = await translateTextInBrowser("Second.");
    expect(second).toBe("[ja]Second."); // retried create() succeeded this time
    expect(createCalls).toBe(2);
  });

  // kawaz spec: 結果は segment (段落) 単位でメモリキャッシュ — 同じ段落を
  // 2 回訳しても API へは 1 回しか呼ばれない。
  test("caches per-paragraph results: the same paragraph is translated only once across calls", async () => {
    const { calls } = installMockTranslator();
    const first = await translateTextInBrowser("Repeated paragraph.");
    const second = await translateTextInBrowser("Repeated paragraph.");
    expect(first).toBe(second);
    expect(calls).toEqual(["Repeated paragraph."]);
  });

  // An empty paragraph (e.g. a leading/trailing \n\n producing "") must not
  // be sent to the API — nothing meaningful to translate.
  test("an empty paragraph is left empty, not sent to the API", async () => {
    const { calls } = installMockTranslator();
    const result = await translateTextInBrowser("Text.\n\n\n\nMore.");
    expect(result).toBe("[ja]Text.\n\n\n\n[ja]More.");
    expect(calls.sort()).toEqual(["More.", "Text."]);
  });

  // No Translator API present at all: every paragraph falls back untouched
  // (the caller — Timeline.tsx — is expected to gate this via
  // hasTranslatorApi() and not even offer the "ja" tab, but the function
  // itself must still degrade gracefully rather than throw).
  test("no Translator API present -> translateTextInBrowser falls back to the original text", async () => {
    delete (globalThis as any).Translator;
    const result = await translateTextInBrowser("Some English text.");
    expect(result).toBe("Some English text.");
  });
});

/** helper: 1 段落を `[ja]<text>` に翻訳する成功レスポンスを返す標準 request。
 * 送信ごとの texts を recorder に記録するので「1 op = 1 段落」を検証できる。 */
function makeEchoRequest(recorder?: {
  ops: string[][];
}): (texts: string[]) => Promise<{ ok: true; results: { ok: true; text: string }[] }> {
  return async (texts: string[]) => {
    recorder?.ops.push(texts.slice());
    return {
      ok: true as const,
      results: texts.map((t) => ({ ok: true as const, text: `[ja]${t}` })),
    };
  };
}

describe("translateTextOnHost", () => {
  test("reports a whole thinking as cached only after every English paragraph is cached", async () => {
    const request = makeEchoRequest();
    const text = "First.\n\n日本語。\n\nSecond.";

    expect(hasCachedHostText(text)).toBe(false);
    await translateTextOnHost("First.\n\n日本語。", request);
    expect(hasCachedHostText(text)).toBe(false);
    await translateTextOnHost("Second.", request);
    expect(hasCachedHostText(text)).toBe(true);
  });

  // kawaz r99 裁定: 段落は束ねず 1 op = 1 段落で送る。helper は op を直列で回すので、
  // 段落ごとに独立した op を投げることで訳が段落単位で順次返る (束ねると長文段落が
  // 同 op に居るだけで短文段落まで待たされる)。日本語段落と split が作る空段落は
  // daemon へ送らず原文のまま保持し、元の段落順・境界で再結合する。
  test("sends one op per English paragraph, each carrying exactly one text", async () => {
    const recorder = { ops: [] as string[][] };
    const input = "First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\nFinal paragraph.";
    const result = await translateTextOnHost(input, makeEchoRequest(recorder));

    expect(recorder.ops).toEqual([["First paragraph."], ["Final paragraph."]]);
    expect(result).toBe(
      "[ja]First paragraph.\n\n日本語を含む段落。\n\n\n\nHello 日本語\n\n[ja]Final paragraph.",
    );
  });

  // 段落ごとの op は独立に解決するので、後段落が先に返ることもある。join は
  // 解決順ではなく入力順で組み立てる。
  test("rejoins results at the original paragraph positions regardless of resolve order", async () => {
    const resolvers = new Map<string, (text: string) => void>();
    const translated = translateTextOnHost(
      "First.\n\nSecond.",
      (texts) =>
        new Promise((resolve) => {
          resolvers.set(texts[0]!, (text) => resolve({ ok: true, results: [{ ok: true, text }] }));
        }),
    );
    // request() 呼び出しは microtask 越しなので 1 tick 待つ。
    await new Promise((r) => setTimeout(r, 5));

    expect([...resolvers.keys()].sort()).toEqual(["First.", "Second."]);
    // 入力と逆順に解決させる。
    resolvers.get("Second.")!("二番目");
    resolvers.get("First.")!("一番目");
    expect(await translated).toBe("一番目\n\n二番目");
  });

  // 1 thinking の全段落が揃うまで表示が原文のまま固まらないよう、段落の訳が
  // 届くたびに onPartial が「訳せた段落だけ差し替えた本文」を渡す。翻訳不要な
  // 段落 (日本語) は最初から原文で確定しているので、それ自体では通知しない。
  test("streams a partial body each time a paragraph resolves", async () => {
    const resolvers = new Map<string, (text: string) => void>();
    const partials: string[] = [];
    const input = "First.\n\n日本語。\n\nSecond.";
    const translated = translateTextOnHost(
      input,
      (texts) =>
        new Promise((resolve) => {
          resolvers.set(texts[0]!, (text) => resolve({ ok: true, results: [{ ok: true, text }] }));
        }),
      (partial) => partials.push(partial),
    );
    await new Promise((r) => setTimeout(r, 5));
    // 日本語段落は request にも onPartial にも出ない。
    expect([...resolvers.keys()].sort()).toEqual(["First.", "Second."]);
    expect(partials).toEqual([]);

    resolvers.get("Second.")!("二番目");
    await new Promise((r) => setTimeout(r, 5));
    // 先に返った段落だけが訳文、未完了の段落は原文のまま。
    expect(partials).toEqual(["First.\n\n日本語。\n\n二番目"]);

    resolvers.get("First.")!("一番目");
    expect(await translated).toBe("一番目\n\n日本語。\n\n二番目");
    // 最終値と最後の途中経過は一致する (完成後に表示が揺れない)。
    expect(partials.at(-1)).toBe("一番目\n\n日本語。\n\n二番目");
    expect(partials).toHaveLength(2);
  });

  // 失敗段落は原文 fallback = 初期値と同じなので、表示は変わらない。変化の
  // ない更新で再描画を積まないため、その段落では onPartial を呼ばない。
  test("does not emit a partial for a paragraph that falls back to its original", async () => {
    const partials: string[] = [];
    const result = await translateTextOnHost(
      "Works.\n\nFails.",
      async (texts) => {
        if (texts[0] === "Fails.") {
          return {
            ok: false as const,
            error: { code: "translate_helper_failed", msg: "helper exited" },
          };
        }
        return { ok: true as const, results: [{ ok: true as const, text: "[ja]Works." }] };
      },
      (partial) => partials.push(partial),
    );
    expect(result).toBe("[ja]Works.\n\nFails.");
    expect(partials).toEqual(["[ja]Works.\n\nFails."]);
  });

  // 複数 thinking を同時に翻訳しても段落は束ねられず、段落ごとに 1 op が出る。
  test("keeps ops separate across concurrent translateTextOnHost calls", async () => {
    const recorder = { ops: [] as string[][] };
    const request = makeEchoRequest(recorder);
    const [a, b] = await Promise.all([
      translateTextOnHost("Alpha1.\n\nAlpha2.", request),
      translateTextOnHost("Beta1.", request),
    ]);
    expect(a).toBe("[ja]Alpha1.\n\n[ja]Alpha2.");
    expect(b).toBe("[ja]Beta1.");
    expect(recorder.ops.map((op) => op[0]).sort()).toEqual(["Alpha1.", "Alpha2.", "Beta1."]);
    expect(recorder.ops.every((op) => op.length === 1)).toBe(true);
  });

  // 同一段落の並行要求は hostTextCache の Promise を共有し、op は 1 回で済む。
  test("collapses concurrent requests for the same paragraph into a single op", async () => {
    const recorder = { ops: [] as string[][] };
    const request = makeEchoRequest(recorder);
    const [a, b] = await Promise.all([
      translateTextOnHost("Same paragraph.", request),
      translateTextOnHost("Same paragraph.\n\nOther.", request),
    ]);
    expect(a).toBe("[ja]Same paragraph.");
    expect(b).toBe("[ja]Same paragraph.\n\n[ja]Other.");
    expect(recorder.ops.map((op) => op[0]).sort()).toEqual(["Other.", "Same paragraph."]);
  });

  // 全段落が日本語判定または空段落なら daemon/helper の仕事は無い。全文用の
  // 特別判定ではなく、段落ごとの同じ規則を全要素へ適用した結果として 0 op にする。
  test("returns all-Japanese text as-is without calling request()", async () => {
    let calls = 0;
    const input = "これは日本語です。\n\nカタカナ\n\n漢字";
    const result = await translateTextOnHost(input, async () => {
      calls++;
      return { ok: true, results: [{ ok: true, text: "呼ばれてはいけない" }] };
    });

    expect(result).toBe(input);
    expect(calls).toBe(0);
  });

  // 1 段落の helper item error はその段落だけ原文 fallback とし、別 op で成功した
  // 段落の訳は保持する。一部失敗で thinking 全体や host 経路を失敗扱いにしない。
  test("falls back only the paragraph whose helper item failed", async () => {
    const result = await translateTextOnHost("Translate me.\n\nFallback me.", async (texts) => ({
      ok: true,
      results:
        texts[0] === "Fallback me."
          ? [{ ok: false, error: "TranslationError.notInstalled" } as const]
          : [{ ok: true, text: "翻訳成功" } as const],
    }));

    expect(result).toBe("翻訳成功\n\nFallback me.");
  });

  // op が空 results を返す (helper 破損) 場合もその段落だけ原文 fallback。
  test("falls back the paragraph when the response carries no result for it", async () => {
    const result = await translateTextOnHost("Broken.", async () => ({
      ok: true as const,
      results: [],
    }));

    expect(result).toBe("Broken.");
  });

  // request rejection は当該段落のみの失敗として扱う (op が段落単位なので、
  // 別段落の成功訳は巻き添えにならない)。段落キャッシュに成功訳は残らず再試行が効く。
  test("falls back only the rejecting paragraph, keeping the other paragraph's translation", async () => {
    const result = await translateTextOnHost("Works.\n\nRejects.", async (texts) => {
      if (texts[0] === "Rejects.") throw new Error("helper exited");
      return { ok: true as const, results: [{ ok: true as const, text: "成功" }] };
    });

    expect(result).toBe("成功\n\nRejects.");
  });

  // ErrorResponse (ok:false) も rejection と同じくその段落の原文 fallback。
  test("falls back the paragraph when the response is an ErrorResponse", async () => {
    const result = await translateTextOnHost("First.\n\nSecond.", async () => ({
      ok: false as const,
      error: { code: "translate_helper_failed", msg: "helper exited" },
    }));

    expect(result).toBe("First.\n\nSecond.");
  });

  // 成功結果は全文でなく段落をキーに共有する。同じ段落が別 thinking text に再登場
  // しても daemon へ再送せず、新しい段落だけを翻訳する。
  test("caches successful translations per paragraph across different texts and skips ops for cached ones", async () => {
    const recorder = { ops: [] as string[][] };
    const request = makeEchoRequest(recorder);

    expect(await translateTextOnHost("Repeated.\n\nFirst only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]First only.",
    );
    expect(await translateTextOnHost("Repeated.\n\nSecond only.", request)).toBe(
      "[ja]Repeated.\n\n[ja]Second only.",
    );
    // Repeated. はキャッシュ済みなので 2 回目の op は出ない。
    expect(recorder.ops).toEqual([["Repeated."], ["First only."], ["Second only."]]);
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

    expect(await translateTextOnHost("same", request)).toBe("same");
    expect(await translateTextOnHost("same", request)).toBe("成功");
    expect(await translateTextOnHost("same", request)).toBe("成功");
    expect(calls).toBe(2);
  });
});

// 段落訳のレジストリ: TL 検索が「原文の綴りでも訳文の綴りでも同じ thinking を
// 数に入れる」ために、翻訳経路の成功結果をここへ溜める。Timeline は
// translatedTextOf で unit の 2 つ目の綴りを作り、revision の変化で
// 訳の到着を再計算の合図として受け取る。
describe("translation registry", () => {
  test("has nothing to offer before any translation has landed", () => {
    expect(translatedTextOf("First.\n\nSecond.")).toBe(null);
    expect(getTranslationRevision()).toBe(0);
  });

  test("rebuilds a whole thinking from the paragraphs translated so far", async () => {
    installMockTranslator();
    await translateTextInBrowser("First.");

    // 訳の届いた段落だけ差し替わり、まだの段落は原文のまま残る (途中経過でも
    // 「訳された分は訳文クエリで拾える」)。
    expect(translatedTextOf("First.\n\nSecond.")).toBe("[ja]First.\n\nSecond.");

    await translateTextInBrowser("Second.");
    expect(translatedTextOf("First.\n\nSecond.")).toBe("[ja]First.\n\n[ja]Second.");
  });

  test("collects the host route's results too", async () => {
    await translateTextOnHost("Hello.", makeEchoRequest());
    expect(translatedTextOf("Hello.")).toBe("[ja]Hello.");
  });

  // 原文と同じ文字列しか得られなかった段落 (日本語段落の skip、翻訳失敗の
  // 原文 fallback) は綴りを増やさないので登録しない。
  test("ignores paragraphs whose translation is the original", async () => {
    installMockTranslator();
    await translateTextInBrowser("日本語の段落。");
    expect(translatedTextOf("日本語の段落。")).toBe(null);

    _resetTranslatorStateForTest();
    installMockTranslator({ createShouldFail: true });
    await translateTextInBrowser("Untranslatable.");
    expect(translatedTextOf("Untranslatable.")).toBe(null);
  });

  test("notifies subscribers once per newly registered paragraph", async () => {
    installMockTranslator();
    let notified = 0;
    const unsubscribe = subscribeTranslationRegistry(() => notified++);

    await translateTextInBrowser("First.\n\nSecond.");
    expect(notified).toBe(2);
    expect(getTranslationRevision()).toBe(2);

    // 同じ段落の再翻訳は綴りを増やさないので、再計算の合図も出さない。
    await translateTextInBrowser("First.");
    expect(notified).toBe(2);

    unsubscribe();
    await translateTextInBrowser("Third.");
    expect(notified).toBe(2);
    expect(getTranslationRevision()).toBe(3);
  });
});
