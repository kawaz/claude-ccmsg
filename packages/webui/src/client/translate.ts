import type { ErrorResponse, TranslateResponse } from "@ccmsg/protocol";

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
export async function translateThinkingTextInBrowser(text: string): Promise<string> {
  const paragraphs = text.split("\n\n");
  const translated = await Promise.all(paragraphs.map(translateParagraph));
  return translated.join("\n\n");
}

export type HostTranslateRequest = (texts: string[]) => Promise<TranslateResponse | ErrorResponse>;

/** host 翻訳も browser 翻訳と同じ段落単位で成功結果を共有する。同じ段落は
 * thinking text をまたいで再利用し、失敗時は削除して helper 復帰後の再試行を
 * 許す。Promise を保持するため、同じ段落の並行要求も 1 op に集約される。 */
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

/** Microbatch aggregator: 短時間窓 (既定 20ms) の間に enqueue された翻訳対象段落を
 * まとめて 1 回の translate op として送信する。daemon の translate op は
 * `texts: string[]` を受け入れ、Swift helper 側も `session.translations(from:)`
 * で複数段落を 1 セッション往復で処理できる (下位層は実装済み) ため、集約層を
 * 挟むだけで helper 直列化コスト (400-900ms × N) を N ではなく 1 回に圧縮できる。
 *
 * 段落単位の hostTextCache は enqueue 前に確認 (translateParagraphOnHost) するので
 * キャッシュ済み段落は batch に含まれない。 */
const DEFAULT_HOST_BATCH_WINDOW_MS = 20;
let hostBatchWindowMs = DEFAULT_HOST_BATCH_WINDOW_MS;

type BatchItem = {
  paragraph: string;
  request: HostTranslateRequest;
  /** 集約層から段落の最終テキストを引き渡すコールバック。ok=true なら翻訳成功、
   * ok=false は失敗 fallback (原文をそのまま resolve する場合も含む)。呼び出し
   * 側 (translateParagraphOnHost) は ok=false の時に段落キャッシュから promise を
   * 除去して再試行を許す。 */
  onResult: (text: string, ok: boolean) => void;
};

let pendingBatch: BatchItem[] = [];
let batchFlushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueBatchItem(item: BatchItem): void {
  pendingBatch.push(item);
  if (batchFlushTimer !== null) return;
  batchFlushTimer = setTimeout(flushBatch, hostBatchWindowMs);
}

function flushBatch(): void {
  batchFlushTimer = null;
  if (pendingBatch.length === 0) return;
  const items = pendingBatch;
  pendingBatch = [];
  // request 関数のインスタンスごとに 1 batch にまとめる。実運用では Timeline の
  // useMemo で 1 つの stable instance を渡すため単一グループになる想定だが、
  // 複数 request が同時に enqueue される想定外ケースでも取り違えないよう分離する。
  const groups = new Map<HostTranslateRequest, BatchItem[]>();
  for (const item of items) {
    const g = groups.get(item.request);
    if (g) g.push(item);
    else groups.set(item.request, [item]);
  }
  for (const [request, group] of groups) sendBatch(request, group);
}

function fallbackWholeBatch(group: BatchItem[]): void {
  for (const item of group) item.onResult(item.paragraph, false);
}

function sendBatch(request: HostTranslateRequest, group: BatchItem[]): void {
  const texts = group.map((i) => i.paragraph);
  let responsePromise: ReturnType<HostTranslateRequest>;
  try {
    responsePromise = request(texts);
  } catch {
    fallbackWholeBatch(group);
    return;
  }
  responsePromise.then(
    (response) => {
      if (!response.ok) {
        fallbackWholeBatch(group);
        return;
      }
      // TranslateResponse.results は入力順を保つ契約 (protocol/src/index.ts)。
      // 個別 item の ok=false はその段落のみ原文 fallback、それ以外は helper の
      // 翻訳結果を採用する。結果配列が短い / 欠落しているケースは helper 破損と
      // 見做してその段落のみ fallback。
      group.forEach((item, i) => {
        const result = response.results[i];
        if (result && result.ok) item.onResult(result.text, true);
        else item.onResult(item.paragraph, false);
      });
    },
    () => fallbackWholeBatch(group),
  );
}

/** host で 1 段落を翻訳する。日本語を含む段落・空段落は daemon へ送らず、
 * request/daemon/helper のどの失敗もその段落の原文へ fallback する。実際の
 * daemon 送信は microbatch aggregator (enqueueBatchItem) が短時間の他段落と
 * 束ねて 1 op に集約する。 */
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
  let resolveOuter!: (text: string) => void;
  const promise = new Promise<string>((resolve) => {
    resolveOuter = resolve;
  });
  hostTextCache.set(paragraph, promise);
  enqueueBatchItem({
    paragraph,
    request,
    onResult: (text, ok) => {
      if (!ok && hostTextCache.get(paragraph) === promise) {
        // 成功結果ではないためキャッシュを外し、後続 op で再試行できるようにする
        // (browser 経路 paragraphCache とは対照的に、host 経路は helper の一時的
        // 失敗からの復旧を想定してキャッシュに fallback を残さない)。
        hostTextCache.delete(paragraph);
      }
      pendingHostCount--;
      notifyPendingChange();
      resolveOuter(text);
    },
  });
  return promise;
}

/** thinking ブロックを `\n\n` で分割し、翻訳対象の各段落を microbatch 集約層
 * (enqueueBatchItem) 経由で送信する。集約層は同時期に enqueue された他 thinking
 * の段落と 1 op にまとめる。結果は入力順に `\n\n` で再結合する。 */
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

/** テスト専用: browser/host 両経路のモジュール内キャッシュと microbatch 状態を
 * リセットする。バッチ窓は既定値 (20ms) に戻す。 */
export function _resetTranslatorStateForTest(): void {
  translatorPromise = null;
  paragraphCache.clear();
  hostTextCache.clear();
  pendingHostCount = 0;
  pendingListeners.clear();
  if (batchFlushTimer !== null) {
    clearTimeout(batchFlushTimer);
    batchFlushTimer = null;
  }
  pendingBatch = [];
  hostBatchWindowMs = DEFAULT_HOST_BATCH_WINDOW_MS;
}

/** テスト専用: microbatch 集約層の flush 窓を上書きする。0 を渡せば setTimeout(_, 0)
 * 相当で最速の次 macrotask に flush する。 */
export function _setHostBatchWindowMsForTest(ms: number): void {
  hostBatchWindowMs = ms;
}
