import * as v from "valibot";
import { setBounded } from "./bounded-map.ts";
import {
  joinProgressively,
  registerParagraphTranslation,
  type PartialTextListener,
} from "./translate.ts";

// 翻訳比較タブ ja(plamo) の経路 (DR-0049)。PLaMo 3 Translate を動かす
// llama-server (OpenAI 互換 API) に、ブラウザが直接 1 段落 1 リクエストで
// 送る。base URL は daemon の config `translate_plamo_url` が hello で届く。
// 段落の分け方と逐次表示は browser / host 経路と同じ (translate.ts の共有部品)。
// browser / host と違い日本語を含む段落も送る: PLaMo は日本語の段落を壊さない
// ので、送るかどうかの前処理を持たない (DR-0049 §5)。

/** 送らない段落 (空・空白だけ)。 */
function isBlankParagraph(paragraph: string): boolean {
  return paragraph.trim() === "";
}

const PLAMO_MODEL = "plamo-3-translate";
const PLAMO_FORM = "plain";

/** 英語のまま残す語 (`source` = `target`)。ccmsg と Claude Code の文脈で
 * 頻出し、訳すと識別子やコマンド名として読めなくなるもの。評価
 * (docs/findings/2026-11-06-plamo-translate-eval.md §1.4) で、付けると識別子の
 * 保持と係り受けが良くなった。 */
const PLAMO_GLOSSARY_TERMS = [
  "Bash",
  "jj",
  "git",
  "commit",
  "push",
  "daemon",
  "session",
  "transcript",
  "hook",
  "tool",
  "worker",
  "subagent",
  "webui",
  "module",
  "config",
  "workspace",
  "issue",
  "DR",
  "classifier",
  "thinking",
  "prompt",
  "Claude Code",
  "ccmsg",
];
const PLAMO_GLOSSARY = PLAMO_GLOSSARY_TERMS.map((term) => ({ source: term, target: term }));

/** 内容理解のヒント (文体の指示としては効かない、reference local-translate)。 */
const PLAMO_CONTEXT = "Claude Code (AI coding agent) のセッションの thinking / 応答。技術文書。";

/** llama-server の slot 数 (`--parallel 4`)。これを超えて送ってもサーバ側で
 * 待つだけなので、ブラウザ側でも同時に 4 本までにして残りを手元で待たせる
 * (どの段落を先に送るかを、送った順で決められる)。 */
const PLAMO_MAX_PARALLEL = 4;

/** 失敗した POST を送り直すまでの待ち。cold start の 302 は caddy が
 * llama-server を起動してから返すので、1 秒置けば次は届く想定。 */
const DEFAULT_RETRY_DELAY_MS = 1000;
let retryDelayMs = DEFAULT_RETRY_DELAY_MS;

/** 1 リクエストの期限。1 段落 8,000 字が約 8.5 s (findings §2) なので、
 * 詰まった時にだけ切れる長さ。切らないと slot の待ちが永遠に空かない。 */
const REQUEST_TIMEOUT_MS = 60_000;

/** `/health` の期限 (読み込み時の可用性判定)。 */
const HEALTH_TIMEOUT_MS = 5_000;

/** 1 slot の入出力合計が 4,096 tokens (findings §1.1) なので、それ以上は
 * 頼んでも出ない。英文は約 4 字/token、訳文は入力と同程度の tokens なので、
 * 段落の字数の半分 + 余裕を出力の上限にする。 */
function maxTokensFor(paragraph: string): number {
  return Math.min(4096, Math.max(256, Math.ceil(paragraph.length / 2) + 128));
}

/** 端末内キャッシュのキーの、段落以外の部分。temperature 0 で決定的なので
 * (model, form, glossary, context) が同じなら同じ段落は同じ訳になる。 */
const CACHE_KEY_PREFIX = [
  PLAMO_MODEL,
  PLAMO_FORM,
  fnv1a(JSON.stringify({ glossary: PLAMO_GLOSSARY, context: PLAMO_CONTEXT })),
].join("\u0000");

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** llama-server の chat completion の応答のうち、読むところだけ。 */
const CompletionSchema = v.object({
  choices: v.pipe(
    v.array(
      v.object({
        message: v.object({ content: v.string() }),
        finish_reason: v.nullish(v.string()),
      }),
    ),
    v.minLength(1),
  ),
});

function endpointOf(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 同時数の上限 ---

let activeRequests = 0;
const slotWaiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (activeRequests < PLAMO_MAX_PARALLEL) {
    activeRequests++;
    return;
  }
  // 空いた slot は release が直接手渡すので、ここでは数を増やさない。
  await new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) next();
  else activeRequests--;
}

// --- 1 リクエスト ---

/** POST 1 回の結果。`length` は HTTP 200 のまま slot の上限で切れたもの。 */
type Attempt = { kind: "ok"; text: string } | { kind: "length"; text: string } | { kind: "failed" };

async function postOnce(base: string, paragraph: string): Promise<Attempt> {
  await acquireSlot();
  try {
    const response = await fetch(endpointOf(base, "v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: PLAMO_MODEL,
        messages: [{ role: "user", content: paragraph }],
        chat_template_kwargs: {
          target_lang: "ja",
          form: PLAMO_FORM,
          glossary: PLAMO_GLOSSARY,
          context: PLAMO_CONTEXT,
        },
        temperature: 0,
        max_tokens: maxTokensFor(paragraph),
      }),
      // cold start の 302 を辿ると fetch は POST を GET に変えて送り直し、
      // 404 になる (findings §3)。302 は受け取って失敗扱いにし、同じ POST を
      // 送り直す (translateWithRetry)。
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // opaqueredirect (302 を manual で受けたもの) は status 0 で ok も false。
    if (!response.ok) return { kind: "failed" };
    const body: unknown = await response.json();
    const parsed = v.safeParse(CompletionSchema, body);
    if (!parsed.success) return { kind: "failed" };
    const [choice] = parsed.output.choices;
    if (choice === undefined) return { kind: "failed" };
    if (choice.finish_reason === "length") return { kind: "length", text: choice.message.content };
    return { kind: "ok", text: choice.message.content };
  } catch {
    return { kind: "failed" };
  } finally {
    releaseSlot();
  }
}

/** 失敗 (HTTP エラー・ネットワークエラー・302・応答の形の不一致) なら 1 秒
 * 待って 1 回だけ同じ POST を送り直す。待っている間は slot を返している。 */
async function translateWithRetry(base: string, paragraph: string): Promise<Attempt> {
  const first = await postOnce(base, paragraph);
  if (first.kind !== "failed") return first;
  await delay(retryDelayMs);
  return postOnce(base, paragraph);
}

// --- 長すぎる段落の 2 分割 ---

/** 文の終わり (句点の後の空白) か改行で、段落をなるべく真ん中で 2 つに分ける。
 * 分けられる所が無ければ null。`separator` は分けた所にあった空白で、訳を
 * つなぐ時に改行だけ戻す (和文の文と文の間に空白は要らない)。 */
export function splitParagraphInTwo(
  paragraph: string,
): { head: string; separator: string; tail: string } | null {
  const middle = paragraph.length / 2;
  let best: { start: number; end: number } | null = null;
  for (const match of paragraph.matchAll(/[.!?。！？]["')\]]*(\s+)|\n+/g)) {
    const separator = match[1] ?? match[0];
    const end = match.index + match[0].length;
    const start = end - separator.length;
    const head = paragraph.slice(0, start);
    const tail = paragraph.slice(end);
    if (head.trim() === "" || tail.trim() === "") continue;
    if (best === null || Math.abs(start - middle) < Math.abs(best.start - middle)) {
      best = { start, end };
    }
  }
  if (best === null) return null;
  return {
    head: paragraph.slice(0, best.start),
    separator: paragraph.slice(best.start, best.end),
    tail: paragraph.slice(best.end),
  };
}

// --- 段落の訳 ---

const TRUNCATED_NOTE = "*(ja(plamo): 長すぎて訳が途中で切れた)*";
const FAILED_NOTE = "*(ja(plamo): 翻訳できなかったので原文を表示)*";

/** 段落 1 つの訳の結末。`truncated` は分けても切れた訳 (切れたまま出す)。 */
type ParagraphOutcome =
  | { kind: "ok"; text: string }
  | { kind: "truncated"; text: string }
  | { kind: "failed" };

async function translateParagraphOutcome(
  base: string,
  paragraph: string,
): Promise<ParagraphOutcome> {
  const whole = await translateWithRetry(base, paragraph);
  if (whole.kind === "ok") return whole;
  if (whole.kind === "failed") return { kind: "failed" };
  // slot の上限で切れた: 文で 2 つに分けて送り直す。
  const split = splitParagraphInTwo(paragraph);
  if (split === null) return { kind: "truncated", text: whole.text };
  const [head, tail] = await Promise.all([
    translateWithRetry(base, split.head),
    translateWithRetry(base, split.tail),
  ]);
  if (head.kind === "failed" || tail.kind === "failed") {
    return { kind: "truncated", text: whole.text };
  }
  const joined = `${head.text}${split.separator.includes("\n") ? split.separator : ""}${tail.text}`;
  return head.kind === "ok" && tail.kind === "ok"
    ? { kind: "ok", text: joined }
    : { kind: "truncated", text: joined };
}

/** 段落の原文 (+ 経路の条件) -> 訳の Promise。browser / host のキャッシュと
 * 同じく段落単位・同じ上限で持ち、同じ段落の並行要求は 1 リクエストにまとめる。
 * 失敗は載せたままにしない (サーバが戻れば次に開いた時に訳し直す)。 */
const plamoCache = new Map<string, Promise<ParagraphOutcome>>();
const PLAMO_CACHE_MAX_ENTRIES = 512;

function cacheKeyOf(paragraph: string): string {
  return `${CACHE_KEY_PREFIX}\u0000${paragraph}`;
}

function translateParagraphCached(base: string, paragraph: string): Promise<ParagraphOutcome> {
  const key = cacheKeyOf(paragraph);
  const cached = plamoCache.get(key);
  if (cached) return cached;
  const promise = translateParagraphOutcome(base, paragraph).then((outcome) => {
    if (outcome.kind === "failed" && plamoCache.get(key) === promise) plamoCache.delete(key);
    return outcome;
  });
  setBounded(plamoCache, key, promise, PLAMO_CACHE_MAX_ENTRIES);
  return promise;
}

async function translateParagraphWithPlamo(base: string, paragraph: string): Promise<string> {
  if (isBlankParagraph(paragraph)) return paragraph;
  const outcome = await translateParagraphCached(base, paragraph);
  switch (outcome.kind) {
    case "ok":
      registerParagraphTranslation(paragraph, outcome.text);
      return outcome.text;
    case "truncated":
      registerParagraphTranslation(paragraph, outcome.text);
      return `${outcome.text}\n\n${TRUNCATED_NOTE}`;
    case "failed":
      return `${paragraph}\n\n${FAILED_NOTE}`;
  }
}

/** テキストを `\n\n` で段落に分け、空でない段落を ja(plamo) で訳す。訳が
 * 届いた段落から `onPartial` に途中経過を流し、最後に全段落を結合して返す。 */
export function translateTextWithPlamo(
  text: string,
  base: string,
  onPartial?: PartialTextListener,
): Promise<string> {
  return joinProgressively(
    text.split("\n\n"),
    (paragraph) => translateParagraphWithPlamo(base, paragraph),
    onPartial,
  );
}

/** テキスト全体の翻訳対象段落が ja(plamo) のキャッシュに揃っているか。 */
export function hasCachedPlamoText(text: string): boolean {
  return text
    .split("\n\n")
    .every((paragraph) => isBlankParagraph(paragraph) || plamoCache.has(cacheKeyOf(paragraph)));
}

/** 読み込み時の可用性判定: `<base>/health` が 200 なら使える。cold start
 * (caddy の 302 とサーバの起動待ち) を 1 回の失敗で見限らないよう、翻訳の
 * POST と同じく 1 秒置いて 1 回だけ確かめ直す。 */
export async function probePlamoHealth(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await delay(retryDelayMs);
    try {
      const response = await fetch(endpointOf(base, "health"), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (response.status === 200) return true;
    } catch {
      // 到達できない / 期限切れ / CORS 拒否: 次の試行か、使えない扱いへ。
    }
  }
  return false;
}

/** テスト専用: キャッシュと同時数の状態を捨て、再送の待ちを差し替える。 */
export function _resetPlamoStateForTest(opts?: { retryDelayMs?: number }): void {
  plamoCache.clear();
  activeRequests = 0;
  slotWaiters.length = 0;
  retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
}
