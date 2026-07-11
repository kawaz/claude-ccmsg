// thinking ブロックの原文 -> 日本語訳を提供する薄いレイヤ (U2: Timeline
// thinking 翻訳タブ)。Chrome built-in Translator API
// (https://developer.chrome.com/docs/ai/translator-api) をグローバル
// `Translator.create(...)` 経由で使う — バンドルされた翻訳ライブラリではなく
// ブラウザ内蔵モデルを使うので、対応していないブラウザ/OS では
// `hasTranslatorApi()` が false を返し、Timeline.tsx はタブ自体を出さない
// (レイアウト変化なし、kawaz spec)。
//
// Design rationale: 翻訳ロジックは kawaz 提供ロジック準拠 — 段落 (\n\n) 単位
// に分割し、ひらがな/カタカナ/漢字を含む段落は「既に日本語」とみなして
// 翻訳をスキップする (Translator API に日本語を渡すと意味不明な結果になる
// ケースがあるため、事前フィルタで防ぐ)。失敗した段落は原文へ fallback する
// ので、一部の翻訳が失敗しても全体が壊れない。

/** Chrome の Translator API はまだ TypeScript の lib.dom.d.ts に型定義が
 * 無い実験的グローバルなので、必要な形だけここで宣言する。 */
interface TranslatorLike {
  translate(text: string): Promise<string>;
}
interface TranslatorStatic {
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorLike>;
}

/** \p{Script=...} は Unicode script property escape — ES2018+ の RegExp `u`
 * フラグで使える。ひらがな/カタカナ/漢字のいずれかを含む段落は「翻訳不要
 * (既に日本語)」と判定する (kawaz 提供ロジック準拠)。 */
const JAPANESE_CHAR_RE = /\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han}/u;

function getTranslatorStatic(): TranslatorStatic | null {
  const t = (globalThis as Record<string, unknown>).Translator;
  // 実ブラウザではコンストラクタ (function)、テストの mock では単なる
  // {create: ...} オブジェクトを差し込むことがあるため両方を受け付ける。
  if (t && (typeof t === "function" || typeof t === "object")) return t as TranslatorStatic;
  return null;
}

/** feature-detect: Chrome built-in Translator API がこの環境に存在するか。
 * Timeline.tsx はこれが false ならタブ自体を描画しない。 */
export function hasTranslatorApi(): boolean {
  return getTranslatorStatic() !== null;
}

let translatorPromise: Promise<TranslatorLike> | null = null;

/** en->ja の Translator インスタンスを遅延生成し、以降の呼び出しで使い回す
 * (create() 自体がモデルロード等でコストを持つ想定のため)。 */
function getTranslator(): Promise<TranslatorLike> {
  if (!translatorPromise) {
    const Translator = getTranslatorStatic();
    if (!Translator) {
      return Promise.reject(new Error("Translator API not available"));
    }
    // A rejected promise is still a truthy `Promise` object, so without the
    // `.catch` reset below a transient create() failure (language-pack
    // download in progress, missing user-gesture, ...) would permanently
    // wedge translatorPromise on that rejection — every later paragraph
    // (any thinking block, not just this one) would hit the same cached
    // rejection forever, with no way to retry short of a page reload
    // (adversarial review finding). Resetting to null on failure lets the
    // next call attempt create() again.
    translatorPromise = Translator.create({ sourceLanguage: "en", targetLanguage: "ja" }).catch(
      (e) => {
        translatorPromise = null;
        throw e;
      },
    );
  }
  return translatorPromise;
}

/** 段落 (原文) -> 訳文のメモリキャッシュ。thinking ブロックはセッション中に
 * 何度も再訪されうる (タブ切替、fold 開閉) ので、同じ段落を毎回 API に
 * 投げ直さない — kawaz spec の「結果は segment 単位でメモリキャッシュ」。 */
const paragraphCache = new Map<string, string>();

/** 1 段落を翻訳する。既に日本語を含む段落・空段落は原文のまま、API 呼び出し
 * が失敗した段落も原文へ fallback する (kawaz spec: 「失敗段落は原文
 * fallback」) — 一部失敗が全体の結果を壊さない。 */
async function translateParagraph(paragraph: string): Promise<string> {
  if (paragraph.trim() === "" || JAPANESE_CHAR_RE.test(paragraph)) return paragraph;
  const cached = paragraphCache.get(paragraph);
  if (cached !== undefined) return cached;
  try {
    const translator = await getTranslator();
    const result = await translator.translate(paragraph);
    paragraphCache.set(paragraph, result);
    return result;
  } catch {
    return paragraph;
  }
}

/** thinking ブロックのテキストを日本語へ翻訳する。`\n\n` で段落分割して
 * 段落ごとに translateParagraph を呼び、`\n\n` で再結合する (kawaz spec:
 * 「段落 (\n\n) 分割」) — 段落境界を保つことで markdown 構造 (箇条書き等)
 * を崩さない。 */
export async function translateThinkingText(text: string): Promise<string> {
  const paragraphs = text.split("\n\n");
  const translated = await Promise.all(paragraphs.map(translateParagraph));
  return translated.join("\n\n");
}

/** テスト専用: モジュール内キャッシュ (段落キャッシュ + Translator
 * インスタンス) をリセットする。globalThis.Translator を差し替えるテストが
 * 前のテストの結果を引き継がないようにするためのフック。 */
export function _resetTranslatorStateForTest(): void {
  translatorPromise = null;
  paragraphCache.clear();
}
