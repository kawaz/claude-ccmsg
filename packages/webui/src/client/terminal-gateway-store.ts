// Terminal タブ (SessionView の hyoui gateway iframe) の embed URL 組み立て
// 純関数 (issue 2026-07-21-webui-terminal-tab-embed)。
//
// gateway URL の値は daemon の `<dataDir>/config.json` の
// `terminal_gateway_url` トップレベルキーが正本で、hello response の
// `terminal_gateway_url` で webui に届き AppState.terminalGatewayUrl に載る。
// webui 側にはもはや設定 UI / localStorage は無い (「他タブに設定 UI が
// 無いのに Terminal だけあるのは中途半端」r46m7 で撤去、config ファイル方式へ)。

/** gateway base URL + HYOUI_SESSION_ID から iframe に流し込む embed URL を
 * 組み立てる純関数。gateway URL の末尾スラッシュの有無・path ありの
 * base URL のいずれも受けられるよう、URL コンストラクタで正規化する
 * (base 末尾に `/` がなくても pathname 差し替えは URL 側で確定的に動く)。
 *
 * 不正な gateway URL (parse 失敗 / http|https 以外) や空の sessionId の
 * 場合は null を返す — 呼び出し側は「Terminal タブ自体を出さない」で
 * フォールバックする (設定 UI は廃止済み)。 */
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
  // resize=1: iframe サイズに合わせた PTY 自動 resize (hyoui r45m11。embed は
  // UI トグルが無く iframe の localStorage も分離されるため URL パラメータ方式)
  // fab=...: hyoui embed の入力フォーム呼び出しボタン (fab) のデザインヒント
  // (r53m4 + r56 合意仕様。ユーザ D&D 位置 > query > 既定 の優先順)。
  // right:16,bottom:64 = ccmsg の＋ボタン (right/bottom 1.2rem, 3.2rem 円) と
  // 重ならない位置 (80 は離れすぎとの kawaz 実機フィードバックで 64 に詰め)。
  // size:51,bg:#3b82f6 = ＋ボタンと同径・同系青にして色差による大きさの錯視を
  // 抑え、embed 外側と馴染ませる (r55m1)。未知 key は hyoui 側 silent skip
  // なので旧 gateway に渡しても安全 (後方互換)。
  embedded.search = "?embed=1&resize=1&fab=right:16,bottom:64,size:51,bg:%233b82f6";
  embedded.hash = "";
  return embedded.toString();
}
