// Terminal タブの iframe パネル (issue 2026-07-21-webui-terminal-tab-embed)。
// 外部 hyoui web gateway の embed ページ (`/sessions/<HYOUI_SESSION_ID>?embed=1`
// = ヘッダ無しのターミナル + resume バナー + input 欄) を iframe で埋め込む。
// ccmsg 側はターミナル描画/入力ロジックを一切持たない — iframe を出すだけ。
//
// gateway URL は daemon `<dataDir>/config.json` の `terminal_gateway_url`
// で設定し hello response 経由で受け取る (旧 localStorage `ccmsg.terminalGatewayUrl`
// 方式と画面内の設定 UI は r46m7 で撤去)。gateway URL 未設定 / HYOUI_SESSION_ID
// 未解決の場合は SessionView 側でそもそも Terminal タブ自体を出さないので、
// ここに来る時点で両方 non-empty が保証される。防御的に不正 URL は
// buildTerminalEmbedUrl 側で null を返し、その時だけ簡素なエラー表示に落ちる
// (通常発生しない — daemon 側で http:// / https:// スキームは検証済み)。
import { buildTerminalEmbedUrl } from "../terminal-gateway-store.ts";

interface Props {
  hyouiSessionId: string;
  gatewayUrl: string;
}

export function TerminalPanel({ hyouiSessionId, gatewayUrl }: Props) {
  const embedUrl = buildTerminalEmbedUrl(gatewayUrl, hyouiSessionId);
  if (!embedUrl) {
    // 通常到達しない (daemon が config.json 読み込み時に http/https 以外を
    // 弾いており、hello では検証済みの URL しか流れてこない)。万一 URL が
    // 壊れて届いた時のフォールバック表示 — 設定は config.json 側で直す。
    return (
      <div class="terminal-pane">
        <p id="empty-state">
          Terminal gateway URL が不正です (daemon config.json の `terminal_gateway_url`
          を確認してください)。
        </p>
      </div>
    );
  }
  return (
    <div class="terminal-pane">
      <iframe
        class="terminal-iframe"
        src={embedUrl}
        title="Terminal"
        // tailnet 内部ツール前提だが、iframe 経由の script/form/same-origin は
        // 必要 (xterm.js の入力ハンドラ + resume バナー + input POST)。
        sandbox="allow-scripts allow-same-origin allow-forms"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
