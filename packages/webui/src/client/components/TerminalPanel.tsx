// Terminal タブの iframe パネル (issue 2026-07-21-webui-terminal-tab-embed)。
// 外部 hyoui web gateway の embed ページ (`/sessions/<HYOUI_SESSION_ID>?embed=1`
// = ヘッダ無しのターミナル + resume バナー + input 欄) を iframe で埋め込む。
// ccmsg 側はターミナル描画/入力ロジックを一切持たない — iframe を出すだけ。
//
// 表示条件は SessionView 側で管理する (agent の hyoui_session_id が解決済み
// のセッションでのみ Terminal タブ自体を出す)。ここに来る時点で
// hyouiSessionId は non-empty が保証されているが、gateway URL の設定は
// ここで判定して未設定なら簡易入力欄にフォールバックする。
import { useState } from "preact/hooks";
import {
  buildTerminalEmbedUrl,
  loadTerminalGatewayUrl,
  saveTerminalGatewayUrl,
} from "../terminal-gateway-store.ts";

interface Props {
  hyouiSessionId: string;
}

export function TerminalPanel({ hyouiSessionId }: Props) {
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(() => loadTerminalGatewayUrl());
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const embedUrl = buildTerminalEmbedUrl(gatewayUrl, hyouiSessionId);

  if (!embedUrl) {
    // gateway URL 未設定 or 不正 → 簡易入力欄。localStorage 直書きなので
    // 各 webui クライアントで独立に設定する (端末・PWA ごとに別値)。
    return (
      <div class="terminal-pane terminal-pane-config">
        <form
          class="terminal-config-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            const url = draft.trim();
            if (!url) {
              setError("URL を入力してください");
              return;
            }
            const test = buildTerminalEmbedUrl(url, hyouiSessionId);
            if (!test) {
              setError("URL の形式が不正です (http:// または https:// で始まる base URL を入力)");
              return;
            }
            saveTerminalGatewayUrl(url);
            setGatewayUrl(url);
            setError(null);
          }}
        >
          <label>
            <div>Web gateway URL (未設定です)</div>
            <input
              type="url"
              placeholder="https://your-gateway.example / http://127.0.0.1:43690"
              value={draft}
              onInput={(ev) => setDraft((ev.target as HTMLInputElement).value)}
              inputMode="url"
              autocomplete="off"
              spellcheck={false}
            />
          </label>
          <button type="submit">保存</button>
          {error ? <p class="terminal-config-error">{error}</p> : null}
        </form>
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
      <button
        type="button"
        class="terminal-gateway-reset"
        title="gateway URL を再設定"
        onClick={() => {
          saveTerminalGatewayUrl(null);
          setGatewayUrl(null);
          setDraft("");
        }}
      >
        設定変更
      </button>
    </div>
  );
}
