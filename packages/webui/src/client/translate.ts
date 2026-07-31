import type { ErrorResponse, TranslateResponse } from "@ccmsg/protocol";
import { setBounded } from "./bounded-map.ts";

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

function shouldSkipParagraph(paragraph: string): boolean {
  return paragraph.trim() === "" || JAPANESE_CHAR_RE.test(paragraph);
}

/** テキスト全体が翻訳不要 (全段落が skip 対象) か。true なら翻訳タブの
 * デフォルト選択を original に留める (kawaz r38 mid=54: 翻訳が走らないのに
 * 訳タブが選ばれていると「原文と同一か」の確認クリックが無駄に発生する)。 */
export function isTranslationSkippedText(text: string): boolean {
  return text.split("\n\n").every(shouldSkipParagraph);
}

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

/** 段落キャッシュ (browser / host 共通) の保持上限。キーは段落の原文そのもの
 * なので、開いた thinking ブロックの総量がそのまま常駐ヒープになる。再訪で
 * 効かせたいのは「今見ている周辺の thinking」であって全履歴ではないため、
 * 直近書き込み順で古い段落から捨てる。溢れた段落は次に開いた時に再翻訳
 * (host 経路なら daemon へ 1 op) されるだけで、表示は壊れない。 */
const PARAGRAPH_CACHE_MAX_ENTRIES = 512;

/** 1 段落を翻訳する。既に日本語を含む段落・空段落は原文のまま、API 呼び出し
 * が失敗した段落も原文へ fallback する (kawaz spec: 「失敗段落は原文
 * fallback」) — 一部失敗が全体の結果を壊さない。 */
async function translateParagraph(paragraph: string): Promise<string> {
  if (shouldSkipParagraph(paragraph)) return paragraph;
  const cached = paragraphCache.get(paragraph);
  if (cached !== undefined) return cached;
  try {
    const translator = await getTranslator();
    const result = await translator.translate(paragraph);
    setBounded(paragraphCache, paragraph, result, PARAGRAPH_CACHE_MAX_ENTRIES);
    return result;
  } catch {
    return paragraph;
  }
}

/** thinking ブロックのテキストを日本語へ翻訳する。`\n\n` で段落分割して
 * 段落ごとに translateParagraph を呼び、`\n\n` で再結合する (kawaz spec:
 * 「段落 (\n\n) 分割」) — 段落境界を保つことで markdown 構造 (箇条書き等)
 * を崩さない。 */
export async function translateThinkingTextInBrowser(text: string): Promise<string> {
  const paragraphs = text.split("\n\n");
  const translated = await Promise.all(paragraphs.map(translateParagraph));
  return translated.join("\n\n");
}

export type HostTranslateRequest = (texts: string[]) => Promise<TranslateResponse | ErrorResponse>;

/** host 翻訳も browser 翻訳と同じ段落単位で成功結果を共有する。同じ段落は
 * thinking text をまたいで再利用し、失敗時は削除して helper 復帰後の再試行を
 * 許す。Promise を保持するため、同じ段落の並行要求も 1 op に集約される。
 *
 * paragraphCache と同じ上限を持つ。未解決の Promise が溢れて捨てられても、
 * onResult 側は「自分が入れた promise がまだ載っているか」を確認してから
 * 消すので他人のエントリを壊さない。捨てられた直後に同じ段落が再要求されれば
 * daemon への op が 1 回余分に出るだけで、結果は同じ。 */
const hostTextCache = new Map<string, Promise<string>>();

// 未完了の host 段落リクエスト数。daemon は helper を直列で回すため、この
// カウンタは 「投げてまだ結果が返っていない段落」 = 待ちキュー長の近似として
// UI に露出する (kawaz r38 m94,95: 翻訳中表示が固まっているのか妥当な待ちか
// の判断材料)。段落キャッシュヒットは request しないので counter を増やさない。
let pendingHostCount = 0;
const pendingListeners = new Set<() => void>();
function notifyPendingChange(): void {
  for (const listener of pendingListeners) listener();
}
export function getPendingHostTranslationCount(): number {
  return pendingHostCount;
}
/** pending counter の変化を購読する。返り値で unsubscribe。 */
export function subscribePendingHostTranslation(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

/** thinking 全体の翻訳対象段落が host cache に揃っているかを返す。可視範囲外でも
 * キャッシュ済み結果は daemon request を増やさず即表示できる。 */
export function hasCachedHostThinkingText(text: string): boolean {
  return text
    .split("\n\n")
    .every((paragraph) => shouldSkipParagraph(paragraph) || hostTextCache.has(paragraph));
}

/** host で 1 段落を翻訳する。日本語を含む段落・空段落は daemon へ送らず、
 * request/daemon/helper のどの失敗もその段落の原文へ fallback する。
 *
 * Design rationale: 1 op = 1 段落。daemon の translate op は `texts: string[]` を
 * 受け取れるが、ここでは常に 1 要素で送る。daemon 側 helper は translate op を
 * 厳密直列で処理するため、複数段落を 1 op に束ねるとその op が終わるまで 1 段落も
 * 表示できない (短文数個の後ろに長文が並ぶと全部が長文待ちになる)。段落ごとに
 * 独立した op を投げれば helper は 1 つずつ処理して段落単位で順次返すので、
 * 総時間が多少増えても訳が小出しに出る (kawaz 裁定 r99: UX は小出し優先)。 */
function translateParagraphOnHost(
  paragraph: string,
  request: HostTranslateRequest,
): Promise<string> {
  if (shouldSkipParagraph(paragraph)) {
    return Promise.resolve(paragraph);
  }
  const cached = hostTextCache.get(paragraph);
  if (cached) return cached;

  pendingHostCount++;
  notifyPendingChange();

  const settle = (text: string, ok: boolean): string => {
    if (!ok && hostTextCache.get(paragraph) === promise) {
      // 成功結果ではないためキャッシュを外し、後続 op で再試行できるようにする
      // (browser 経路 paragraphCache とは対照的に、host 経路は helper の一時的
      // 失敗からの復旧を想定してキャッシュに fallback を残さない)。
      hostTextCache.delete(paragraph);
    }
    pendingHostCount--;
    notifyPendingChange();
    return text;
  };

  const send = async (): Promise<string> => {
    let response: Awaited<ReturnType<HostTranslateRequest>>;
    try {
      // request 呼び出しを 1 microtask 遅らせる: request が同期 throw しても
      // settle が下の `promise` 初期化より前に走らないようにするため。
      response = await Promise.resolve().then(() => request([paragraph]));
    } catch {
      return settle(paragraph, false);
    }
    if (!response.ok) return settle(paragraph, false);
    // TranslateResponse.results は入力順を保つ契約 (protocol/src/index.ts)。
    // 1 要素で送っているので結果も 1 要素。item error / 結果欠落 (helper 破損)
    // はどちらもこの段落の原文 fallback。
    const result = response.results[0];
    if (result?.ok) return settle(result.text, true);
    return settle(paragraph, false);
  };

  // hostTextCache には送信前に promise を載せる: 同じ段落の並行要求はこの promise を
  // 共有し、daemon への op は 1 回に収まる。
  const promise = send();
  setBounded(hostTextCache, paragraph, promise, PARAGRAPH_CACHE_MAX_ENTRIES);
  return promise;
}

/** thinking ブロックを `\n\n` で分割し、翻訳対象の各段落を段落ごとの独立した
 * translate op として送る。結果は入力順に `\n\n` で再結合する。 */
export async function translateThinkingTextOnHost(
  text: string,
  request: HostTranslateRequest,
): Promise<string> {
  const paragraphs = text.split("\n\n");
  const translated = await Promise.all(
    paragraphs.map((paragraph) => translateParagraphOnHost(paragraph, request)),
  );
  return translated.join("\n\n");
}

/** テスト専用: browser/host 両経路のモジュール内キャッシュと pending 状態を
 * リセットする。 */
export function _resetTranslatorStateForTest(): void {
  translatorPromise = null;
  paragraphCache.clear();
  hostTextCache.clear();
  pendingHostCount = 0;
  pendingListeners.clear();
}
