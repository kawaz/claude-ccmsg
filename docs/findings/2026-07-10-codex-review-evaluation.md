# codex レビュー (2026-07-10) の実物検証と評価

一次資料: `subagents/aa6b41b6e4178b94f.output` (context に貼付済み、要点は本文にコピー)。
kawaz の依頼「方向性のスジ / 実装・設計の良し悪し / 考慮漏れ」に対する codex のレビュー結果を、
実物コードと突き合わせて重大度と対応方針を確定させた記録。

## 判明した事実

### Critical 1 件、Major 4 件、Minor 3 件すべて実物成立

7 件すべて指摘されたファイルの当該行を確認、指摘通りの実装であることを確認した。
codex の推測ミスや誤読はゼロ。ただし重大度と対応判断は分ける。

### Critical: HTTP/WS が悪意 Web ページから操作可能

- **成立条件が全部揃っている**:
  - `DEFAULT_HTTP_BIND = "0.0.0.0:8642"` (`protocol/src/index.ts:29`)
  - `DEFAULT_HTTP_ALLOW = "127.0.0.0/8,::1,100.64.0.0/10,fd7a:115c:a1e0::/48"` (同 :35)
  - `fetch(req, srv)` で Origin ヘッダを検証しない (`http.ts:64-83`)
  - `pinHelloToUser` で hello を強制的に `role: "user"` にする (同 :41-51)
  - `IDENTITY_OPS = ["post", "create_room", "next_room", "subscribe", "notify", "leave"]`
    (`server.ts:284`) — **`read` / `rooms` / `peers` / `ping` / `shutdown` は hello 不要**
- **実悪用シナリオ**: kawaz が browser で悪意ページ `evil.com` を開いた瞬間、そのページの JS から:
  1. `new WebSocket("ws://127.0.0.1:8642/ws")` で接続 (SOP は WebSocket に効かない、Fetch spec)。
     source IP は `127.0.0.1` で allowlist 通過、Origin は `evil.com` だが daemon は無視
  2. hello なしで `{"op":"shutdown"}` 送信 → daemon が `gracefulShutdown` → `process.exit(0)`
     → 任意の kawaz マシンで **リモート DoS** 成立
  3. `{"op":"rooms"}` → 全 room 一覧漏洩、`{"op":"read","room":"r1","mids":"1-9999"}` →
     全メッセージ漏洩
  4. hello (自動で `role: "user"` に pin) 後 `{"op":"post","room":"r1","msg":"..."}` →
     u1 として peer session に **偽メッセージ注入** (受信側 AI が「kawaz の指示」と誤認する可能性)
- **根本原因**: DR-0004 §2 の trust model「reachable == user」が Web ブラウザからの
  cross-origin WebSocket 接続を想定していない。ネットワーク到達性で trust を判定する設計を
  取る限り、Web の origin 越境で穴が開く

### Major 1: u1 真正性が同 UID 内で成立していない

- `cli/src/index.ts` の `--as-user` で誰でも `identity.role="user"` を作れる
- daemon 側 hello 処理 (`server.ts:312-329`) は role を鵜呑み、UID trust のみ
- Claude Code セッション自身も kawaz と同 UID なので、別 agent がその気になれば
  UDS 経由で `u1` を偽装可能
- ただし攻撃前提が「同 UID で任意のプロセスを走らせられる」= ローカル侵入済み前提なので、
  personal スケールで受容可能。**DR に「同 UID 内は信頼」を明記する対応でよい**

### Major 2: plain HTTP 既定のまま (webui-https close 判断の残タスク)

- webui-https issue の受け入れ条件「採用方式に応じて `CCMSG_HTTP_BIND` の既定値・
  source-IP allowlist の要否を見直す」が未実施のまま resolved close
- 私 (先ほどのセッション) が「tailscale serve で解決」を根拠に close したが、
  実装調整 (bind を 127.0.0.1 に戻す等) が残っていた = **close 判断が甘かった**
- Critical の修正と併せて実装調整すれば同時解決

### Major 3: source-IP allowlist が tailnet 認証境界の代替

- `100.64.0.0/10` 全体を u1 admin として扱う = tailnet 内の他 device 全員が u1
- kawaz が個人単独 tailnet の場合は実害なし。**shared tailnet では脆弱**
- Critical の修正で tailnet レンジを allowlist から外せば同時解決 (kawaz は tailscale
  serve を採用するので、tailscale serve が localhost:8642 に proxy し、daemon 側は
  127.0.0.1 bind のみで足りる)

### Major 4: storage 永続化前の in-memory 更新 (順序問題)

- `storage.ts:207` `appendEvent`:
  ```
  room.events.push(ev);            // ① in-memory 更新
  if (msg) room.lastMid = ev.mid;  // ② lastMid 更新
  ...
  fs.writeSync(room.fd, line);     // ③ 永続化 (失敗しうる)
  ```
- ③ が例外 (disk full / EIO) を投げると ①② が先行済み。次回 daemon 再起動時は
  jsonl から再構築するので in-memory 状態は消える = **同じ mid の重複割当も起こり得る**
- 実発生率は低いが設計として正しくない
- 修正: writeSync を先に、成功後 push/lastMid 更新に順序反転 (エラー時は throw 伝播で
  handleRequest 内 try/catch が捕捉して sendErr する)

### Minor 1: `ln -sfn` の shell quoting 欠落

- `hooks/session-start.ts:167` — `ln -sfn ${bin} ${candidate.binPath}` が unquoted
- home に空白/metachar 含む環境 (mac の "Yoshiaki Kawazu" 系ユーザ名や、
  日本語パス) で AI がそのままシェルに投げると壊れる
- 修正: `ln -sfn '${bin}' '${candidate.binPath}'` (single quote で囲む)

### Minor 2: DR-0002 の crash loop 警告仕様が未実装

- DR-0002 で「spawn 失敗の backoff + 5 回連続失敗警告」が仕様
- 実装は `connectWithSpawn` が 12 回試行して throw する形 (`client.ts:132-144`)
- session-start hook は `try/catch` で握り潰し (best-effort warm-up、これは正)
- **仕様と実装の乖離**。実害は限定的 (daemon 起動失敗時にセッションが理由を知らないだけ)
- 対応候補: (a) DR-0002 を実装に合わせて簡略化、(b) 警告実装を追加

### Minor 3: webui pending resolver が close 時に flush されない

- `webui/src/client/ws.ts:58` — `pending: Array<(v: Response) => void>` に resolver を積む
- `onClose` (:115) で pending array を flush/reject していない
- onOpen 済み → send 直後に切断、の窓 (レア) で Composer が永久 pending
- 修正: onClose で `pending.forEach(r => r({ ok: false, error: {code: "connection_closed",
  msg: "..."} }))` してから `pending = []`

## 実用的な示唆・対応方針

### 最優先 (Critical + Major 2 + Major 3 セット)

DR-0004 §2 の trust model を実質的に見直す。実装変更は 3 点:

1. `DEFAULT_HTTP_BIND` を `"127.0.0.1:8642,[::1]:8642"` に戻す (tailscale serve が
   localhost に proxy する前提。kawaz の HTTPS 化裁定と整合)
2. `DEFAULT_HTTP_ALLOW` から `100.64.0.0/10` と `fd7a:115c:a1e0::/48` を削除
3. `fetch` に Origin 検証を追加: `null` (file://, non-browser) と、
   `origin === "http://127.0.0.1:8642"` / `http://[::1]:8642` などの許可オリジンのみ通す。
   tailscale serve 越しは Origin が `https://<machine>.<tailnet>.ts.net` になるので、
   `CCMSG_HTTP_ALLOW_ORIGIN` 環境変数で明示的に足せる形にする

これで DoS + 情報漏洩 + 偽メッセージ発行の 3 経路が全部塞がる。DR-0004 追補として記録。

### 中対応 (Major 4 + Minor 3)

- storage 順序反転 (`storage.ts:207`)
- webui pending resolver flush (`webui/src/client/ws.ts:onClose`)

どちらも実害は小さいが設計上正しくない。個別に修正 issue。

### 軽対応 (Minor 1 + Minor 2)

- `ln -sfn` の quoting (`hooks/session-start.ts:167`) — 1 行の quote 追加
- DR-0002 crash loop 警告仕様と実装の乖離 — DR 側を実装に合わせて簡略化 (実害小のため)

### 議論余地あり (Major 1)

- u1 真正性は現行の personal スケール前提で受容可能
- DR-0004 (or 新 DR) に「UDS 上の trust は同 UID 内は信頼」を明記して閉じる

## 検証の詳細

各指摘の該当行を Read で確認し、コード上の実装と codex の主張が一致することを検証した。
実装テストは実行していない (read-only レビューの評価なので不要)。
