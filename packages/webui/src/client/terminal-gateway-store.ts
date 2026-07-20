// Terminal タブ (SessionView の hyoui gateway iframe) の gateway URL を
// localStorage に持つヘルパ + URL 組立ての純関数
// (issue 2026-07-21-webui-terminal-tab-embed)。
//
// gateway URL は「外部の web gateway (hyoui) の base URL」を指す設定値で、
// 未設定 (null) の場合は Terminal タブ機能そのものが無効 (SessionView 側
// で Terminal タブ自体が出ない)。値の妥当性は buildTerminalEmbedUrl が
// URL コンストラクタで最終確認する — localStorage に壊れた値が入っていた
// 場合は build 側で null を返し、UI は設定入力欄にフォールバックする。
import { readStorage, removeStorage, writeStorage } from "./storage.ts";

export const TERMINAL_GATEWAY_STORAGE_KEY = "ccmsg.terminalGatewayUrl";

/** localStorage から gateway base URL を読む。未設定 / 空文字は null。 */
export function loadTerminalGatewayUrl(): string | null {
  const raw = readStorage(TERMINAL_GATEWAY_STORAGE_KEY);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** localStorage に gateway base URL を保存する。空文字/null で削除。
 * 値の validation (http/https スキーム、末尾スラッシュ等) は buildTerminalEmbedUrl
 * が URL コンストラクタで行うため、ここでは trim だけの pass-through。 */
export function saveTerminalGatewayUrl(url: string | null): void {
  if (!url || url.trim().length === 0) {
    removeStorage(TERMINAL_GATEWAY_STORAGE_KEY);
    return;
  }
  writeStorage(TERMINAL_GATEWAY_STORAGE_KEY, url.trim());
}

/** gateway base URL + HYOUI_SESSION_ID から iframe に流し込む embed URL を
 * 組み立てる純関数。gateway URL の末尾スラッシュの有無・path ありの
 * base URL のいずれも受けられるよう、URL コンストラクタで正規化する
 * (base 末尾に `/` がなくても pathname 差し替えは URL 側で確定的に動く)。
 *
 * 不正な gateway URL (parse 失敗) や空の sessionId の場合は null を返す —
 * 呼び出し側は「iframe を出さず設定入力欄を出す」等にフォールバックする。 */
export function buildTerminalEmbedUrl(
  gatewayBase: string | null,
  hyouiSessionId: string | null | undefined,
): string | null {
  if (!gatewayBase || !hyouiSessionId) return null;
  let base: URL;
  try {
    base = new URL(gatewayBase);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  // base の pathname を全置換して sessions/<id> を組む。base に path が
  // 付いていても Terminal embed の src は常に `/sessions/<id>` を指す
  // (hyoui gateway の URL 仕様)。
  const embedded = new URL(base.toString());
  embedded.pathname = `/sessions/${encodeURIComponent(hyouiSessionId)}`;
  embedded.search = "?embed=1";
  embedded.hash = "";
  return embedded.toString();
}
